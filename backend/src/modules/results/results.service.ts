/*
 * Result storage (PRODUCT.md §7.7): idempotent ingest into daily partitions, a check_events row per
 * failed result (kept for the history period), and partition maintenance (3 days ahead; raw results
 * dropped after 48 h).
 */
import { evidenceKey, type CheckResult, type EvidenceBundle } from "@app/shared";
import type { Clock } from "../../core/clock.js";
import type { Db } from "../../infra/db/index.js";
import type { Logger } from "../../infra/logger.js";
import type { ObjectStore } from "../../infra/storage/index.js";
import { partitionDay, partitionName, type ResultsRepository } from "./results.repository.js";
import type { CheckResultRow } from "./schema/partitioned/check-results.js";

export const PARTITIONS_AHEAD_DAYS = 3;
export const RAW_RETENTION_MS = 48 * 3_600_000;
/* Results older than this are refused: their partition may already be gone. */
export const MAX_RESULT_AGE_MS = 24 * 3_600_000;
/* Probe clocks may drift a little; results far in the future are refused. */
export const MAX_FUTURE_SKEW_MS = 5 * 60_000;
/* Evidence uploads per batch and at a time: a mass outage must not slow ingest to a crawl. */
export const MAX_EVIDENCE_PER_BATCH = 100;
const EVIDENCE_CONCURRENCY = 8;

/* The stored bundle: the failed result's facts plus what the probe kept of the response. */
export function toEvidenceBundle(r: StoredResult): EvidenceBundle {
  return {
    version: 1,
    resultId: r.id,
    monitorId: r.monitorId,
    region: r.region,
    checkedAt: r.checkedAt,
    errorCode: r.errorCode ?? null,
    message: r.message ?? null,
    httpStatus: r.httpStatus ?? null,
    latencyMs: Math.round(r.latencyMs),
    timings: r.timings ?? null,
    ip: r.ip ?? null,
    tls: r.tls ?? null,
    details: r.details ?? null,
    headers: r.evidence?.headers ?? {},
    bodySnippet: r.evidence?.bodySnippet ?? null,
    bodyBytes: r.evidence?.bodyBytes ?? null,
    bodyTruncated: r.evidence?.bodyTruncated ?? false,
  };
}

export interface StoredResult extends CheckResult {
  workspaceId: string;
  probeId?: string | undefined;
}

export interface IngestOutcome {
  accepted: number;
  duplicates: number;
  /* Results outside the accepted time window. */
  rejected: number;
  /* IDs of newly stored results, for evaluation. */
  insertedIds: string[];
}

export interface ResultsService {
  ingest(results: StoredResult[]): Promise<IngestOutcome>;
  /*
   * System (workspace erasure): removes the stored evidence of a workspace's failed checks from
   * object storage. The rows themselves go with the workspace. Returns how many objects went.
   */
  eraseEvidence(workspaceId: string): Promise<number>;
  recent(monitorId: string, region: string, limit: number): Promise<CheckResultRow[]>;
  /* History used by "what changed before this incident" (system-level; the caller checks scope). */
  ipHistory: ResultsRepository["ipHistory"];
  tlsHistory: ResultsRepository["tlsHistory"];
  latencyAverage: ResultsRepository["latencyAverage"];
  /* Probe health guard (system-level): how a probe's checks are going. */
  probeFailureStats: ResultsRepository["probeFailureStats"];
  probeFailureRatio: ResultsRepository["probeFailureRatio"];
  /* The newest TLS facts per monitor (system-level, across workspaces). */
  latestTls(): ReturnType<ResultsRepository["latestTls"]>;
  /* Records a check event that isn't a failed result (for example a certificate change). */
  recordEvent(event: {
    workspaceId: string;
    monitorId: string;
    at: Date;
    kind: "info" | "state_change";
    message: string;
    details?: Record<string, unknown>;
  }): Promise<void>;
  maintainPartitions(): Promise<{ created: string[]; dropped: string[] }>;
}

const startOfUtcDay = (ms: number) => {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

export function createResultsService(deps: {
  db: Db;
  repository: ResultsRepository;
  clock: Clock;
  newId: () => string;
  /* Where evidence bundles go; without it results are stored without evidence. */
  objects?: ObjectStore | undefined;
  logger?: Logger | undefined;
}): ResultsService {
  const { repository: repo, clock } = deps;

  /*
   * Stores the evidence of failed results and answers their keys. Best effort: a result whose bundle
   * can't be stored is kept without one, because losing the result would lose the outage.
   */
  async function storeEvidence(results: StoredResult[]): Promise<Map<string, string>> {
    const keys = new Map<string, string>();
    const { objects } = deps;
    if (objects === undefined) return keys;
    const queue = results
      .filter((r) => !r.ok && r.evidence !== undefined)
      .slice(0, MAX_EVIDENCE_PER_BATCH);
    const worker = async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        const key = evidenceKey(next.workspaceId, next.checkedAt, next.id);
        try {
          await objects.put(key, JSON.stringify(toEvidenceBundle(next)), {
            contentType: "application/json",
          });
          keys.set(next.id, key);
        } catch (err) {
          deps.logger?.warn({ err, resultId: next.id }, "evidence bundle not stored");
        }
      }
    };
    await Promise.all(Array.from({ length: EVIDENCE_CONCURRENCY }, worker));
    return keys;
  }

  return {
    async eraseEvidence(workspaceId) {
      const { objects } = deps;
      if (objects === undefined) return 0;
      let erased = 0;
      for (const key of await deps.repository.evidenceKeysOf(workspaceId)) {
        try {
          await objects.delete(key);
          erased += 1;
        } catch (err) {
          /* The object expires by itself after its lifetime; the erasure goes on. */
          deps.logger?.warn({ err, key }, "evidence object not deleted");
        }
      }
      return erased;
    },

    async ingest(results) {
      const now = clock.now().getTime();
      const inWindow = results.filter((r) => {
        const at = Date.parse(r.checkedAt);
        return at >= now - MAX_RESULT_AGE_MS && at <= now + MAX_FUTURE_SKEW_MS;
      });
      const evidenceKeys = await storeEvidence(inWindow);
      const insertedIds = await deps.db.transaction(async (tx) => {
        const inserted = await repo.insertResults(
          tx,
          inWindow.map((r) => ({
            checkedAt: new Date(r.checkedAt),
            id: r.id,
            workspaceId: r.workspaceId,
            monitorId: r.monitorId,
            region: r.region,
            probeId: r.probeId ?? null,
            ok: r.ok,
            errorCode: r.errorCode ?? null,
            message: r.message ?? null,
            httpStatus: r.httpStatus ?? null,
            latencyMs: Math.round(r.latencyMs),
            timings: r.timings ?? null,
            ip: r.ip ?? null,
            tls: r.tls ?? null,
            details: r.details ?? null,
            taskId: r.taskId ?? null,
            evidenceKey: evidenceKeys.get(r.id) ?? null,
          })),
        );
        const fresh = new Set(inserted);
        await repo.insertEvents(
          tx,
          inWindow
            .filter((r) => !r.ok && fresh.has(r.id))
            .map((r) => ({
              id: r.id,
              workspaceId: r.workspaceId,
              monitorId: r.monitorId,
              at: new Date(r.checkedAt),
              kind: "failure" as const,
              region: r.region,
              errorCode: r.errorCode ?? null,
              httpStatus: r.httpStatus ?? null,
              message: r.message ?? null,
              details: r.details ?? null,
            })),
        );
        return inserted;
      });
      return {
        accepted: insertedIds.length,
        duplicates: inWindow.length - insertedIds.length,
        rejected: results.length - inWindow.length,
        insertedIds,
      };
    },

    recent: (monitorId, region, limit) => repo.recent(monitorId, region, limit),

    latestTls: () => repo.latestTls(),
    ipHistory: (monitorId, from, to) => repo.ipHistory(monitorId, from, to),
    tlsHistory: (monitorId, from, to) => repo.tlsHistory(monitorId, from, to),
    latencyAverage: (monitorId, from, to) => repo.latencyAverage(monitorId, from, to),
    probeFailureStats: (probeId, since) => repo.probeFailureStats(probeId, since),
    probeFailureRatio: (probeId, from, to) => repo.probeFailureRatio(probeId, from, to),

    async recordEvent(event) {
      await repo.insertEvents(deps.db, [
        {
          id: deps.newId(),
          workspaceId: event.workspaceId,
          monitorId: event.monitorId,
          at: event.at,
          kind: event.kind,
          message: event.message,
          details: event.details ?? null,
        },
      ]);
    },

    async maintainPartitions() {
      const now = clock.now().getTime();
      const created: string[] = [];
      const today = startOfUtcDay(now);
      for (let i = -1; i <= PARTITIONS_AHEAD_DAYS; i += 1) {
        const day = new Date(today.getTime() + i * 86_400_000);
        if (await repo.createPartition(day)) created.push(partitionName(day));
      }
      const dropped: string[] = [];
      for (const name of await repo.listPartitions()) {
        const day = partitionDay(name);
        if (day === undefined) continue;
        const end = day.getTime() + 86_400_000;
        if (end <= now - RAW_RETENTION_MS) {
          await repo.dropPartition(name);
          dropped.push(name);
        }
      }
      return { created, dropped };
    },
  };
}
