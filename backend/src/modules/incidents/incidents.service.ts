/*
 * Incident lifecycle (PRODUCT.md §6.3, §9.3). Detection and heartbeats open and resolve incidents inside
 * their own transactions (pass `tx`); every change writes a timeline event and emits an outbox event.
 * The user-facing API (list, acknowledge, comment, false alarm) arrives in P1-T11.
 */
import type { Clock } from "../../core/clock.js";
import { createWorkspaceScope } from "../../core/workspace-scope.js";
import type { DbOrTx, Tx } from "../../infra/db/index.js";
import type { Outbox } from "../../infra/outbox/index.js";
import type { WorkspacesService } from "../workspaces/index.js";
import type { IncidentsRepository } from "./incidents.repository.js";
import type { IncidentRow } from "./schema/incidents.js";

export interface OpenForMonitorInput {
  workspaceId: string;
  monitorId: string;
  title: string;
  severity: "critical" | "high" | "low";
  causeCode: string | null;
  failingRegions: string[];
  evidence?: Record<string, unknown>;
}

export interface IncidentsService {
  /* Opens an incident for a monitor, or returns the open one. `created` tells which. */
  openForMonitor(
    tx: Tx,
    input: OpenForMonitorInput,
  ): Promise<{ incident: IncidentRow; created: boolean }>;
  /* Resolves the monitor's open incident, if any. */
  resolveForMonitor(
    tx: Tx,
    input: { monitorId: string; auto: boolean; byUserId?: string },
  ): Promise<IncidentRow | undefined>;
  setFlapping(tx: Tx, incidentId: string, flapping: boolean): Promise<void>;
  findOpenForMonitor(tx: DbOrTx, monitorId: string): Promise<IncidentRow | undefined>;
}

export function createIncidentsService(deps: {
  repository: IncidentsRepository;
  workspaces: Pick<WorkspacesService, "nextIncidentNumber">;
  outbox: Outbox;
  clock: Clock;
  newId: () => string;
}): IncidentsService {
  const { repository: repo, clock } = deps;

  return {
    async openForMonitor(tx, input) {
      const existing = await repo.findOpenForMonitor(tx, input.monitorId);
      if (existing) return { incident: existing, created: false };

      const now = clock.now();
      const number = await deps.workspaces.nextIncidentNumber(
        tx,
        createWorkspaceScope({ workspaceId: input.workspaceId }),
      );
      const created = await repo.insertForMonitor(tx, {
        id: deps.newId(),
        workspaceId: input.workspaceId,
        number,
        source: "monitor",
        monitorId: input.monitorId,
        title: input.title,
        severity: input.severity,
        causeCode: input.causeCode,
        failingRegions: input.failingRegions,
        evidence: input.evidence ?? null,
        startedAt: now,
      });
      if (created === undefined) {
        /* Another transaction opened it first; the unique index kept us from a duplicate. */
        const winner = await repo.findOpenForMonitor(tx, input.monitorId);
        if (winner === undefined)
          throw new Error("open incident vanished during a concurrent insert");
        return { incident: winner, created: false };
      }
      await repo.addEvent(tx, {
        id: deps.newId(),
        incidentId: created.id,
        workspaceId: created.workspaceId,
        at: now,
        type: "triggered",
        actor: "system",
        data: { causeCode: input.causeCode, failingRegions: input.failingRegions },
      });
      await deps.outbox.emit(
        tx,
        "incident.triggered",
        {
          incidentId: created.id,
          number: created.number,
          monitorId: input.monitorId,
          severity: created.severity,
          title: created.title,
        },
        { workspaceId: created.workspaceId },
      );
      return { incident: created, created: true };
    },

    async resolveForMonitor(tx, input) {
      const open = await repo.findOpenForMonitor(tx, input.monitorId, true);
      if (open === undefined) return undefined;
      const now = clock.now();
      const resolved = await repo.update(tx, open.id, {
        status: "resolved",
        resolvedAt: now,
        resolvedBy: input.byUserId ?? null,
        autoResolved: input.auto,
        flapping: false,
        snoozedUntil: null,
      });
      await repo.addEvent(tx, {
        id: deps.newId(),
        incidentId: open.id,
        workspaceId: open.workspaceId,
        at: now,
        type: "resolved",
        actor: input.byUserId ?? "system",
        data: {
          auto: input.auto,
          durationSeconds: Math.round((now.getTime() - open.startedAt.getTime()) / 1_000),
        },
      });
      await deps.outbox.emit(
        tx,
        "incident.resolved",
        { incidentId: open.id, auto: input.auto },
        { workspaceId: open.workspaceId },
      );
      return resolved;
    },

    async setFlapping(tx, incidentId, flapping) {
      const incident = await repo.findById(tx, incidentId);
      if (incident === undefined || incident.flapping === flapping) return;
      await repo.update(tx, incidentId, { flapping });
      await repo.addEvent(tx, {
        id: deps.newId(),
        incidentId,
        workspaceId: incident.workspaceId,
        at: clock.now(),
        type: flapping ? "flapping_started" : "flapping_stopped",
        actor: "system",
        data: {},
      });
    },

    findOpenForMonitor: (tx, monitorId) => repo.findOpenForMonitor(tx, monitorId),
  };
}
