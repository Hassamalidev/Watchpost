/*
 * SSL and domain expiry (PRODUCT.md §9.8). A daily sweep reads each monitor's newest TLS facts (SSL
 * monitors, and HTTPS monitors by default) and each domain monitor's registration expiry (RDAP,
 * cached per domain across workspaces). Each warning threshold fires once per certificate or expiry
 * date: the first opens one low-severity incident per item, later ones update it (and notify), and a
 * renewal past every threshold resolves it. A certificate replaced long before it was due is
 * recorded as an info event.
 */
import type { MonitorConfig } from "@app/shared";
import type { Clock } from "../../core/clock.js";
import { ValidationError } from "../../core/errors.js";
import type { WorkspaceScope } from "../../core/workspace-scope.js";
import type { Db } from "../../infra/db/index.js";
import type { OutboundHttp } from "../../infra/http/outbound.js";
import type { Logger } from "../../infra/logger.js";
import type { IncidentsService } from "../incidents/index.js";
import type { MonitorForDetection, MonitorsService } from "../monitors/index.js";
import type { ResultsService } from "../results/index.js";
import type { ExpiryRepository } from "./expiry.repository.js";
import {
  ROUTINE_RENEWAL_DAYS,
  SSL_DEFAULT_THRESHOLDS,
  crossedThresholds,
  daysUntil,
  expiryPhrase,
} from "./expiry.thresholds.js";
import { fetchBootstrap, lookupDomain } from "./rdap.js";
import type { DomainExpiryRow, ExpiryKind } from "./schema/expiry.js";

const HOUR_MS = 3_600_000;
const BOOTSTRAP_MAX_AGE_MS = 7 * 24 * HOUR_MS;
/* How long a lookup stays fresh, by outcome. */
const DOMAIN_FRESH_MS = {
  ok: 12 * HOUR_MS,
  error: HOUR_MS,
  unsupported: 7 * 24 * HOUR_MS,
} as const;
/* Registry lookups per sweep, to stay polite with RDAP servers. */
const MAX_LOOKUPS_PER_SWEEP = 200;
const PAGE = 500;

export type ExpiryStatus = "pending" | "ok" | "warning" | "expired" | "unsupported" | "error";

export interface ExpiryView {
  monitorId: string;
  kind: ExpiryKind;
  status: ExpiryStatus;
  expiresAt: string | null;
  daysRemaining: number | null;
  thresholds: number[];
  message: string | null;
  checkedAt: string | null;
  details: Record<string, unknown>;
}

export interface ExpirySweepOutcome {
  certificates: number;
  domains: number;
  lookups: number;
  notices: number;
  resolved: number;
}

export interface ExpiryService {
  sweep(): Promise<ExpirySweepOutcome>;
  get(scope: WorkspaceScope, monitorId: string): Promise<ExpiryView>;
  /* Checks one monitor now (a fresh RDAP lookup for domains) and returns its state. */
  check(scope: WorkspaceScope, monitorId: string): Promise<ExpiryView>;
}

interface Target {
  kind: ExpiryKind;
  /* Hostname for certificates, registered domain for domains. */
  name: string;
  thresholds: number[];
}

/* What a monitor's config says to watch: its certificate, its domain, or nothing. */
export function expiryTarget(config: MonitorConfig): Target | undefined {
  switch (config.type) {
    case "ssl":
      return { kind: "ssl", name: config.host, thresholds: config.warnDays };
    case "domain":
      return { kind: "domain", name: config.domain, thresholds: config.warnDays };
    case "http":
    case "keyword":
    case "json_query": {
      const url = new URL(config.url);
      return url.protocol === "https:"
        ? { kind: "ssl", name: url.hostname, thresholds: SSL_DEFAULT_THRESHOLDS }
        : undefined;
    }
    case "tcp":
      return config.tls
        ? { kind: "ssl", name: config.host, thresholds: SSL_DEFAULT_THRESHOLDS }
        : undefined;
    default:
      return undefined;
  }
}

export function createExpiryService(deps: {
  db: Db;
  repository: ExpiryRepository;
  monitors: Pick<MonitorsService, "get" | "getForProbes" | "getForDetection" | "listByType">;
  results: Pick<ResultsService, "latestTls" | "recordEvent">;
  incidents: Pick<IncidentsService, "openOrUpdateExpiry" | "resolveByDedupKey">;
  http: OutboundHttp;
  clock: Clock;
  logger: Logger;
  newId: () => string;
}): ExpiryService {
  const { repository: repo, clock } = deps;

  /* Fires a new threshold (once) or resolves the warning after a renewal. */
  async function applyThresholds(
    monitor: MonitorForDetection,
    target: Target,
    subject: string,
    expiresAt: Date,
    evidence: Record<string, unknown>,
    outcome: ExpirySweepOutcome,
  ): Promise<void> {
    const now = clock.now();
    const dedupKey = `${target.kind}:${monitor.id}`;
    await deps.db.transaction(async (tx) => {
      const noticed = await repo.noticed(tx, monitor.id, target.kind, subject);
      const decision = crossedThresholds(expiresAt, now, target.thresholds, noticed);
      if (decision.notify !== null) {
        const recorded = await repo.addNotices(
          tx,
          decision.newlyCrossed.map((threshold) => ({
            id: deps.newId(),
            workspaceId: monitor.workspaceId,
            monitorId: monitor.id,
            kind: target.kind,
            subject,
            threshold,
          })),
        );
        /* Another sweep got there first: it sent this warning. */
        if (!recorded.includes(decision.notify)) return;
        const what =
          target.kind === "ssl" ? `SSL certificate for ${target.name}` : `Domain ${target.name}`;
        await deps.incidents.openOrUpdateExpiry(tx, {
          workspaceId: monitor.workspaceId,
          monitorId: monitor.id,
          dedupKey,
          title: `${what} ${expiryPhrase(decision.days)}`,
          causeCode: target.kind === "ssl" ? "cert_expiring" : "domain_expiring",
          evidence: {
            ...evidence,
            expiresAt: expiresAt.toISOString(),
            daysRemaining: decision.days,
            threshold: decision.notify,
          },
        });
        outcome.notices += 1;
      } else if (!decision.warning) {
        if (await deps.incidents.resolveByDedupKey(tx, monitor.workspaceId, dedupKey)) {
          outcome.resolved += 1;
        }
      }
    });
  }

  async function processCertificate(
    monitor: MonitorForDetection,
    target: Target,
    tls: Awaited<ReturnType<ResultsService["latestTls"]>>[number],
    outcome: ExpirySweepOutcome,
  ): Promise<void> {
    const now = clock.now();
    const validTo = new Date(tls.tls.validTo);
    const previous = await repo.ssl(deps.db, monitor.id);
    if (
      previous !== undefined &&
      previous.fingerprint !== tls.tls.fingerprint256 &&
      daysUntil(previous.validTo, now) > ROUTINE_RENEWAL_DAYS
    ) {
      await deps.results.recordEvent({
        workspaceId: monitor.workspaceId,
        monitorId: monitor.id,
        at: tls.checkedAt,
        kind: "info",
        message: `The certificate for ${target.name} changed ${daysUntil(previous.validTo, now)} days before the old one expired.`,
        details: {
          previous: {
            fingerprint256: previous.fingerprint,
            issuer: previous.issuer,
            validTo: previous.validTo.toISOString(),
          },
          current: {
            fingerprint256: tls.tls.fingerprint256,
            issuer: tls.tls.issuer,
            validTo: tls.tls.validTo,
          },
        },
      });
    }
    await repo.saveSsl(deps.db, {
      monitorId: monitor.id,
      workspaceId: monitor.workspaceId,
      fingerprint: tls.tls.fingerprint256,
      validFrom: new Date(tls.tls.validFrom),
      validTo,
      issuer: tls.tls.issuer,
      subject: tls.tls.subject,
      checkedAt: tls.checkedAt,
    });
    outcome.certificates += 1;
    await applyThresholds(
      monitor,
      target,
      tls.tls.fingerprint256,
      validTo,
      { issuer: tls.tls.issuer, subject: tls.tls.subject, fingerprint256: tls.tls.fingerprint256 },
      outcome,
    );
  }

  let bootstrapCache: { map: Map<string, string[]>; at: number } | undefined;
  async function bootstrap(): Promise<Map<string, string[]>> {
    const now = clock.now().getTime();
    if (bootstrapCache && now - bootstrapCache.at < HOUR_MS) return bootstrapCache.map;
    const stored = await repo.bootstrap(deps.db);
    if (
      stored.map.size > 0 &&
      stored.fetchedAt !== null &&
      now - stored.fetchedAt.getTime() < BOOTSTRAP_MAX_AGE_MS
    ) {
      bootstrapCache = { map: stored.map, at: now };
      return stored.map;
    }
    try {
      const fresh = await fetchBootstrap(deps.http);
      await deps.db.transaction((tx) => repo.replaceBootstrap(tx, fresh, clock.now()));
      bootstrapCache = { map: fresh, at: now };
      return fresh;
    } catch (err) {
      /* A stale list beats none; lookups still work for known TLDs. */
      deps.logger.warn({ err }, "RDAP bootstrap refresh failed");
      if (stored.map.size > 0) return stored.map;
      throw err;
    }
  }

  async function domainRecord(
    domain: string,
    force: boolean,
  ): Promise<{ row: DomainExpiryRow; looked: boolean }> {
    const name = domain.toLowerCase().replace(/\.$/, "");
    const now = clock.now();
    const cached = await repo.domain(deps.db, name);
    if (
      !force &&
      cached !== undefined &&
      now.getTime() - cached.checkedAt.getTime() < DOMAIN_FRESH_MS[cached.status]
    ) {
      return { row: cached, looked: false };
    }
    let row: DomainExpiryRow;
    try {
      const result = await lookupDomain(deps.http, await bootstrap(), name);
      row =
        result.status === "ok"
          ? {
              domain: name,
              status: "ok",
              expiresAt: result.expiresAt,
              registrar: result.registrar,
              source: "rdap",
              error: null,
              checkedAt: now,
            }
          : {
              domain: name,
              status: result.status,
              expiresAt: cached?.expiresAt ?? null,
              registrar: cached?.registrar ?? null,
              source: "rdap",
              error: result.error,
              checkedAt: now,
            };
    } catch (err) {
      row = {
        domain: name,
        status: "error",
        expiresAt: cached?.expiresAt ?? null,
        registrar: cached?.registrar ?? null,
        source: "rdap",
        error: `RDAP lookup failed: ${err instanceof Error ? err.message : String(err)}`,
        checkedAt: now,
      };
    }
    await repo.saveDomain(deps.db, row);
    return { row, looked: true };
  }

  async function processDomain(
    monitor: MonitorForDetection,
    target: Target,
    force: boolean,
    outcome: ExpirySweepOutcome,
  ): Promise<void> {
    if (!force && outcome.lookups >= MAX_LOOKUPS_PER_SWEEP) {
      const cached = await repo.domain(deps.db, target.name.toLowerCase());
      if (cached?.status === "ok" && cached.expiresAt) {
        await applyThresholds(
          monitor,
          target,
          cached.expiresAt.toISOString(),
          cached.expiresAt,
          { registrar: cached.registrar },
          outcome,
        );
      }
      return;
    }
    const { row, looked } = await domainRecord(target.name, force);
    if (looked) outcome.lookups += 1;
    outcome.domains += 1;
    if (row.status === "ok" && row.expiresAt !== null) {
      await applyThresholds(
        monitor,
        target,
        row.expiresAt.toISOString(),
        row.expiresAt,
        { registrar: row.registrar },
        outcome,
      );
    }
  }

  async function withConfigs(ids: string[]) {
    const [detection, probes] = await Promise.all([
      deps.monitors.getForDetection(ids),
      deps.monitors.getForProbes(ids),
    ]);
    const configs = new Map(probes.map((m) => [m.id, m.config]));
    return detection.flatMap((m) => {
      const config = configs.get(m.id);
      const target = config === undefined ? undefined : expiryTarget(config);
      return target === undefined ? [] : [{ monitor: m, target }];
    });
  }

  function view(
    monitorId: string,
    target: Target,
    parts: Omit<ExpiryView, "monitorId" | "kind" | "thresholds">,
  ): ExpiryView {
    return { monitorId, kind: target.kind, thresholds: target.thresholds, ...parts };
  }

  function statusOf(days: number, thresholds: number[]): ExpiryStatus {
    if (days < 0) return "expired";
    return days <= Math.max(...thresholds) ? "warning" : "ok";
  }

  async function mustTarget(scope: WorkspaceScope, monitorId: string): Promise<Target> {
    const monitor = await deps.monitors.get(scope, monitorId);
    const target = expiryTarget(monitor.config);
    if (target === undefined) {
      throw new ValidationError("This monitor has no certificate or domain expiry to track.");
    }
    return target;
  }

  const service: ExpiryService = {
    async sweep() {
      const outcome: ExpirySweepOutcome = {
        certificates: 0,
        domains: 0,
        lookups: 0,
        notices: 0,
        resolved: 0,
      };

      const tls = await deps.results.latestTls();
      for (let i = 0; i < tls.length; i += PAGE) {
        const page = tls.slice(i, i + PAGE);
        const targets = new Map(
          (await withConfigs(page.map((t) => t.monitorId))).map((t) => [t.monitor.id, t]),
        );
        for (const row of page) {
          const found = targets.get(row.monitorId);
          if (found === undefined || found.monitor.paused || found.target.kind !== "ssl") continue;
          try {
            await processCertificate(found.monitor, found.target, row, outcome);
          } catch (err) {
            deps.logger.error({ err, monitorId: row.monitorId }, "certificate expiry check failed");
          }
        }
      }

      let afterId: string | null = null;
      do {
        const page = await deps.monitors.listByType(["domain"], {
          limit: PAGE,
          ...(afterId === null ? {} : { afterId }),
        });
        const targets = await withConfigs(page.monitors.map((m) => m.id));
        for (const { monitor, target } of targets) {
          if (monitor.paused) continue;
          try {
            await processDomain(monitor, target, false, outcome);
          } catch (err) {
            deps.logger.error({ err, monitorId: monitor.id }, "domain expiry check failed");
          }
        }
        afterId = page.nextAfterId;
      } while (afterId !== null);
      return outcome;
    },

    async get(scope, monitorId) {
      const target = await mustTarget(scope, monitorId);
      const now = clock.now();
      if (target.kind === "ssl") {
        const state = await repo.ssl(deps.db, monitorId);
        if (state === undefined) {
          return view(monitorId, target, {
            status: "pending",
            expiresAt: null,
            daysRemaining: null,
            message: "Waiting for the first TLS check.",
            checkedAt: null,
            details: {},
          });
        }
        const days = daysUntil(state.validTo, now);
        return view(monitorId, target, {
          status: statusOf(days, target.thresholds),
          expiresAt: state.validTo.toISOString(),
          daysRemaining: days,
          message: null,
          checkedAt: state.checkedAt.toISOString(),
          details: {
            issuer: state.issuer,
            subject: state.subject,
            fingerprint256: state.fingerprint,
          },
        });
      }
      const row = await repo.domain(deps.db, target.name.toLowerCase().replace(/\.$/, ""));
      if (row === undefined) {
        return view(monitorId, target, {
          status: "pending",
          expiresAt: null,
          daysRemaining: null,
          message: "Waiting for the first registry lookup.",
          checkedAt: null,
          details: {},
        });
      }
      const days = row.expiresAt === null ? null : daysUntil(row.expiresAt, now);
      return view(monitorId, target, {
        status:
          row.status === "ok" && days !== null
            ? statusOf(days, target.thresholds)
            : row.status === "ok"
              ? "error"
              : row.status,
        expiresAt: row.expiresAt?.toISOString() ?? null,
        daysRemaining: days,
        message: row.error,
        checkedAt: row.checkedAt.toISOString(),
        details: { registrar: row.registrar, source: row.source },
      });
    },

    async check(scope, monitorId) {
      const target = await mustTarget(scope, monitorId);
      const [found] = await withConfigs([monitorId]);
      if (found !== undefined && !found.monitor.paused) {
        const outcome: ExpirySweepOutcome = {
          certificates: 0,
          domains: 0,
          lookups: 0,
          notices: 0,
          resolved: 0,
        };
        if (target.kind === "domain") {
          await processDomain(found.monitor, found.target, true, outcome);
        } else {
          const tls = (await deps.results.latestTls()).find((t) => t.monitorId === monitorId);
          if (tls !== undefined)
            await processCertificate(found.monitor, found.target, tls, outcome);
        }
      }
      return service.get(scope, monitorId);
    },
  };
  return service;
}
