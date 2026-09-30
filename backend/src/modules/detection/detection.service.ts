/*
 * Result ingest (PRODUCT.md §7.4: detection owns POST /api/probe/v1/results). Accepts only results for
 * monitors assigned to the reporting probe, stores them idempotently, completes their tasks, and
 * (from P1-T10) queues evaluation. The evaluation engine itself arrives in P1-T10.
 */
import { resultsBatchSchema, type CheckResult } from "@app/shared";
import { ValidationError } from "../../core/errors.js";
import type { Db } from "../../infra/db/index.js";
import type { Logger } from "../../infra/logger.js";
import type { AuthenticatedProbe } from "../../middleware/probe-auth.js";
import type { MonitorsService } from "../monitors/index.js";
import type { ProbesService } from "../probes/index.js";
import type { ResultsService } from "../results/index.js";

export interface IngestResponse {
  accepted: number;
  duplicates: number;
}

export interface DetectionService {
  ingest(probe: AuthenticatedProbe, body: unknown): Promise<IngestResponse>;
}

export function createDetectionService(deps: {
  db: Db;
  monitors: MonitorsService;
  results: ResultsService;
  probes: ProbesService;
  logger: Logger;
  /* Called with newly stored results; P1-T10 wires evaluation here. */
  onStored?: (results: CheckResult[]) => Promise<void>;
}): DetectionService {
  return {
    async ingest(probe, body) {
      const parsed = resultsBatchSchema.safeParse(body);
      if (!parsed.success)
        throw new ValidationError(`Invalid results batch: ${parsed.error.message}`);
      const batch = parsed.data;

      const monitors = new Map(
        (await deps.monitors.getForProbes([...new Set(batch.results.map((r) => r.monitorId))])).map(
          (m) => [m.id, m],
        ),
      );
      /* A probe reports only its own region and only monitors it was assigned. */
      const accepted = batch.results.filter((r) => {
        const monitor = monitors.get(r.monitorId);
        return (
          monitor !== undefined &&
          r.region === probe.region &&
          deps.probes.isAssigned(probe, monitor)
        );
      });
      const refused = batch.results.length - accepted.length;
      if (refused > 0) {
        deps.logger.warn(
          { probeId: probe.id, refused, batchId: batch.batchId },
          "refused results for unassigned monitors",
        );
      }

      const outcome = await deps.results.ingest(
        accepted.map((r) => ({
          ...r,
          workspaceId: monitors.get(r.monitorId)?.workspaceId ?? "",
          probeId: probe.id,
        })),
      );
      const stored = new Set(outcome.insertedIds);
      const newResults = accepted.filter((r) => stored.has(r.id));
      await deps.db.transaction((tx) => deps.probes.completeTasks(tx, probe.id, newResults));
      if (deps.onStored && newResults.length > 0) await deps.onStored(newResults);

      return {
        accepted: outcome.accepted,
        duplicates: outcome.duplicates + refused + outcome.rejected,
      };
    },
  };
}
