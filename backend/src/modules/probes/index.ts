/* Public API of the probes module. Other modules import only from this file (PRODUCT.md §7.1). */
import type { RequestHandler } from "express";
import type { AppModule, Infra } from "../../composition/types.js";
import { newId } from "../../infra/ids.js";
import { probeAuth } from "../../middleware/probe-auth.js";
import type { MonitorsService } from "../monitors/index.js";
import type { ResultsService } from "../results/index.js";
import type { WorkspacesService } from "../workspaces/index.js";
import {
  createPrivateProbesRouter,
  createPrivateProbesService,
  type PrivateProbesService,
} from "./private.js";
import { createProbesController } from "./probes.controller.js";
import { createProbesRepository } from "./probes.repository.js";
import { createProbeProtocolRouter, createProbeUserRouter } from "./probes.routes.js";
import { createProbesService, type ProbesService } from "./probes.service.js";
import { createTaskNotifier } from "./types/task-notifier.js";

export type {
  ProbeTaskView,
  ProbesService,
  QuarantineInfo,
  SilentProbeInfo,
} from "./probes.service.js";
export { GUARD_MIN_MONITORS, QUARANTINE_MS } from "./guard.js";

export interface ProbesModuleDeps {
  infra: Pick<Infra, "db" | "pool" | "clock" | "cipher" | "logger" | "outbox" | "config" | "locks">;
  monitors: MonitorsService;
  workspaces: Pick<WorkspacesService, "listMembers" | "workspaceName">;
  /* The probe health guard reads each probe's failure rate; without it the guard is off. */
  results?: ResultsService | undefined;
  guards: { session: RequestHandler; workspace: RequestHandler };
}

const DAY_MS = 24 * 60 * 60_000;

export interface ProbesModule extends AppModule {
  service: ProbesService;
  privateProbes: PrivateProbesService;
}

export function createProbesModule(deps: ProbesModuleDeps): ProbesModule {
  const { infra } = deps;
  const logger = infra.logger.child({ module: "probes" });
  const percent = (ratio: number) => `${Math.round(ratio * 100)}%`;
  /* Ops are told; customers never are (rule 13). Without OPS_EMAIL the log line is the notice. */
  const tellOps = async (
    key: string,
    notice: { subject: string; heading: string; lines: string[] },
  ): Promise<void> => {
    const to = infra.config.funding.opsEmail;
    if (to === undefined) return;
    await infra.db.transaction((tx) =>
      infra.outbox.emit(tx, "email.requested", {
        template: "ops-notice",
        to,
        data: notice,
        idempotencyKey: key,
      }),
    );
  };
  const repository = createProbesRepository(deps.infra.db);
  const service = createProbesService({
    results: deps.results,
    async onQuarantine(info) {
      logger.error({ ...info }, "probe quarantined: its failures no longer count");
      await tellOps(`probe-quarantine:${info.probeId}:${infra.clock.now().toISOString()}`, {
        subject: `Probe in ${info.region} quarantined`,
        heading: `Our probe in ${info.region} is failing most of its checks`,
        lines: [
          `Probe ${info.probeId} failed ${info.failing} of ${info.monitors} monitors (${percent(info.failing / Math.max(1, info.monitors))}); its usual failure rate is ${percent(info.baselineRatio)}.`,
          "Its failures are ignored for 10 minutes at a time while this lasts, and verification goes to other regions. No customer was alerted because of it.",
          "Check the probe's host and network. Monitors that use this region are confirmed from fewer regions until it recovers, and monitors checked only from there aren't being watched.",
          "Runbook: docs/runbooks/probe-quarantine.md",
        ],
      });
    },
    async onSilent(info) {
      /* One notice a day per probe; the lock is left to expire on its own. */
      const first = await infra.locks.acquire(`probe-silent:${info.probeId}`, DAY_MS);
      if (first === null) return;
      logger.error({ ...info }, "probe stopped reporting: its region no longer counts");
      await tellOps(
        `probe-silent:${info.probeId}:${infra.clock.now().toISOString().slice(0, 10)}`,
        {
          subject: `Probe in ${info.region} stopped reporting`,
          heading: `Our probe in ${info.region} is silent`,
          lines: [
            `Probe ${info.name} (${info.probeId}) last reported at ${info.lastSeenAt?.toISOString() ?? "an unknown time"}.`,
            "Its region doesn't count until it reports again: monitors there are confirmed from fewer regions, and monitors checked only from there aren't being watched.",
            "Check the probe's host, its container and its network path to the API.",
            "Runbook: docs/runbooks/probe-quarantine.md",
          ],
        },
      );
    },
    db: deps.infra.db,
    repository,
    monitors: deps.monitors,
    cipher: deps.infra.cipher,
    clock: deps.infra.clock,
    newId,
    notifier: createTaskNotifier(deps.infra.pool),
  });
  const controller = createProbesController(service);
  const privateProbes = createPrivateProbesService({
    db: deps.infra.db,
    repository,
    register: (input) => service.register(input),
    forget: (probeId) => service.forget(probeId),
    monitors: deps.monitors,
    workspaces: deps.workspaces,
    outbox: deps.infra.outbox,
    clock: deps.infra.clock,
    webOrigin: deps.infra.config.webOrigin,
    image: deps.infra.config.privateProbeImage,
  });
  return {
    name: "probes",
    service,
    privateProbes,
    probeAuth: probeAuth({ lookup: (id) => service.authLookup(id) }),
    probeRouters: [createProbeProtocolRouter(controller)],
    routers: [
      { path: "/api/w/:workspaceId", router: createProbeUserRouter(controller, deps.guards) },
      {
        path: "/api/w/:workspaceId",
        router: createPrivateProbesRouter(privateProbes, deps.guards),
      },
    ],
    sweeps: [
      {
        /* A private probe silent for five minutes: its workspace is told, once. */
        kind: "private-probes-offline",
        everyMs: 60_000,
        async run(sweepLogger) {
          const told = await privateProbes.notifyOffline();
          if (told > 0) sweepLogger.info({ told }, "private probes went offline");
        },
      },
      {
        /* Every minute (§9.2): renew quarantines that still hold and notice silent probes. */
        kind: "probe-health-guard",
        everyMs: 60_000,
        async run(sweepLogger) {
          const quarantined = await service.guardSweep();
          if (quarantined.length > 0) sweepLogger.warn({ quarantined }, "probes in quarantine");
        },
      },
    ],
    readinessWarnings: { probes: () => service.regionsCovered() },
    close: () => service.close(),
  };
}
