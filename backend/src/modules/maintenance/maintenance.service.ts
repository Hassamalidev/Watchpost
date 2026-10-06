/*
 * Maintenance windows (PRODUCT.md §9.6): planned work during which failures are recorded but open no
 * incident and send nothing. Detection asks `inMaintenance` on every evaluation. The boundary sweep
 * reports which monitors just entered a window so they switch to "maintenance" at once; monitors
 * already in maintenance are looked at again by detection every minute, which is how the end of a
 * window (or its deletion) is noticed.
 */
import type {
  CreateMaintenanceWindowInput,
  MaintenanceWindowView,
  UpdateMaintenanceWindowInput,
} from "@app/shared";
import type { Clock } from "../../core/clock.js";
import { NotFoundError, ValidationError } from "../../core/errors.js";
import type { WorkspaceScope } from "../../core/workspace-scope.js";
import type { MonitorsService } from "../monitors/index.js";
import type { MaintenanceRepository } from "./maintenance.repository.js";
import {
  RecurrenceError,
  formatRule,
  isOver,
  isValidTimezone,
  nextOccurrence,
  occurrenceAt,
  parseRule,
  type WindowSpec,
} from "./recurrence.js";
import type { MaintenanceWindowRow } from "./schema/maintenance.js";

/* Monitors that just entered or left a window: listed, or every monitor of the workspace. */
export interface BoundaryChange {
  workspaceId: string;
  windowId: string;
  monitorIds: string[] | "all";
  change: "started" | "ended";
}

export interface MaintenanceService {
  list(scope: WorkspaceScope): Promise<MaintenanceWindowView[]>;
  get(scope: WorkspaceScope, id: string): Promise<MaintenanceWindowView>;
  create(
    scope: WorkspaceScope,
    input: CreateMaintenanceWindowInput,
  ): Promise<MaintenanceWindowView>;
  update(
    scope: WorkspaceScope,
    id: string,
    input: UpdateMaintenanceWindowInput,
  ): Promise<MaintenanceWindowView>;
  delete(scope: WorkspaceScope, id: string): Promise<void>;
  /* System: is this monitor inside a window that silences alerts at `at`? */
  inMaintenance(monitor: { id: string; workspaceId: string }, at: Date): Promise<boolean>;
  /*
   * System: notices windows that started or ended since the last call and answers whose monitors
   * need evaluating again. Each start and each end is reported once.
   */
  boundaryChanges(): Promise<BoundaryChange[]>;
}

const specOf = (row: Pick<MaintenanceWindowRow, "startsAt" | "endsAt" | "rrule" | "timezone">) =>
  ({
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    rrule: row.rrule,
    timezone: row.timezone,
  }) satisfies WindowSpec;

const covers = (row: Pick<MaintenanceWindowRow, "scope">, monitorId: string) =>
  "all" in row.scope || row.scope.monitorIds.includes(monitorId);

export function createMaintenanceService(deps: {
  repository: MaintenanceRepository;
  monitors: Pick<MonitorsService, "getForDetection">;
  clock: Clock;
  newId: () => string;
}): MaintenanceService {
  const { repository: repo, clock } = deps;

  function toView(row: MaintenanceWindowRow): MaintenanceWindowView {
    const now = clock.now();
    const spec = specOf(row);
    const current = occurrenceAt(spec, now);
    return {
      id: row.id,
      name: row.name,
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
      timezone: row.timezone,
      rrule: row.rrule,
      scope: row.scope,
      suppressAlerts: row.suppressAlerts,
      showOnPages: row.showOnPages,
      active: current !== null,
      activeUntil: current?.end.toISOString() ?? null,
      nextStart: nextOccurrence(spec, now)?.start.toISOString() ?? null,
      over: isOver(spec, now),
      createdAt: row.createdAt.toISOString(),
    };
  }

  const fieldError = (field: string, message: string) =>
    new ValidationError(`${field}: ${message}`, [{ path: `body.${field}`, message }]);

  /* Timezone and rule are checked here, where Luxon lives; shapes were checked by Zod. */
  function checkTiming(timezone: string, rrule: string | null): string | null {
    if (!isValidTimezone(timezone)) {
      throw fieldError("timezone", "is not a timezone we know (use one like Europe/Berlin).");
    }
    if (rrule === null) return null;
    try {
      return formatRule(parseRule(rrule));
    } catch (err) {
      if (err instanceof RecurrenceError) throw fieldError("rrule", err.message);
      throw err;
    }
  }

  async function checkScope(
    scope: WorkspaceScope,
    target: MaintenanceWindowRow["scope"],
  ): Promise<void> {
    if ("all" in target) return;
    const found = await deps.monitors.getForDetection(target.monitorIds);
    const mine = new Set(found.filter((m) => m.workspaceId === scope.workspaceId).map((m) => m.id));
    const missing = target.monitorIds.filter((id) => !mine.has(id));
    if (missing.length > 0) {
      throw fieldError("scope", `unknown monitors: ${missing.slice(0, 5).join(", ")}.`);
    }
  }

  async function mustFind(scope: WorkspaceScope, id: string): Promise<MaintenanceWindowRow> {
    const row = await repo.find(scope, id);
    if (row === undefined) throw new NotFoundError("Maintenance window not found.");
    return row;
  }

  return {
    async list(scope) {
      return (await repo.list(scope)).map(toView);
    },

    async get(scope, id) {
      return toView(await mustFind(scope, id));
    },

    async create(scope, input) {
      const rrule = checkTiming(input.timezone, input.rrule);
      await checkScope(scope, input.scope);
      const row = await repo.insert(scope, {
        id: deps.newId(),
        name: input.name,
        startsAt: new Date(input.startsAt),
        endsAt: new Date(input.endsAt),
        timezone: input.timezone,
        rrule,
        scope: input.scope,
        suppressAlerts: input.suppressAlerts,
        showOnPages: input.showOnPages,
        createdBy: scope.actorUserId ?? null,
      });
      return toView(row);
    },

    async update(scope, id, input) {
      const before = await mustFind(scope, id);
      const timezone = input.timezone ?? before.timezone;
      const rrule = checkTiming(timezone, input.rrule === undefined ? before.rrule : input.rrule);
      const startsAt = input.startsAt === undefined ? before.startsAt : new Date(input.startsAt);
      const endsAt = input.endsAt === undefined ? before.endsAt : new Date(input.endsAt);
      if (endsAt <= startsAt) throw fieldError("endsAt", "must be after the start.");
      if (input.scope !== undefined) await checkScope(scope, input.scope);

      const row = await repo.update(scope, id, {
        ...(input.name === undefined ? {} : { name: input.name }),
        startsAt,
        endsAt,
        timezone,
        rrule,
        ...(input.scope === undefined ? {} : { scope: input.scope }),
        ...(input.suppressAlerts === undefined ? {} : { suppressAlerts: input.suppressAlerts }),
        ...(input.showOnPages === undefined ? {} : { showOnPages: input.showOnPages }),
      });
      if (row === undefined) throw new NotFoundError("Maintenance window not found.");
      return toView(row);
    },

    async delete(scope, id) {
      if (!(await repo.delete(scope, id))) {
        throw new NotFoundError("Maintenance window not found.");
      }
    },

    async inMaintenance(monitor, at) {
      const windows = await repo.suppressing(monitor.workspaceId);
      return windows.some(
        (row) => covers(row, monitor.id) && occurrenceAt(specOf(row), at) !== null,
      );
    },

    async boundaryChanges() {
      const now = clock.now();
      const changes: BoundaryChange[] = [];
      for (const row of await repo.unfinished()) {
        const spec = specOf(row);
        const active = occurrenceAt(spec, now) !== null;
        const finishedAt = !active && isOver(spec, now) ? now : null;
        if (active === row.active && finishedAt === null) continue;
        const changed = await repo.setState(row.id, { active, finishedAt });
        /* Only a window that silences alerts changes what detection decides. */
        if (changed && active !== row.active && row.suppressAlerts) {
          changes.push({
            workspaceId: row.workspaceId,
            windowId: row.id,
            monitorIds: "all" in row.scope ? "all" : row.scope.monitorIds,
            change: active ? "started" : "ended",
          });
        }
      }
      return changes;
    },
  };
}
