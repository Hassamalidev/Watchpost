/*
 * On-call schedules (PRODUCT.md §6.5, §9.5): definitions, overrides, and the answers built on the
 * engine: who is on call now and next, and the timeline a calendar draws. Only people who can be
 * paged (responders and above) can be put on a schedule.
 */
import {
  MAX_TIMELINE_DAYS,
  roleCan,
  type CreateOverrideInput,
  type CreateScheduleInput,
  type OnCallNow,
  type OnCallPerson,
  type OnCallSegment,
  type ScheduleLayerInput,
  type ScheduleOverrideView,
  type ScheduleSummary,
  type ScheduleView,
  type UpdateScheduleInput,
} from "@app/shared";
import type { Clock } from "../../core/clock.js";
import { NotFoundError, ValidationError } from "../../core/errors.js";
import type { WorkspaceScope } from "../../core/workspace-scope.js";
import type { Db } from "../../infra/db/index.js";
import type { WorkspacesService } from "../workspaces/index.js";
import {
  isTimezone,
  timeline as engineTimeline,
  whoIsOnCall as engineWhoIsOnCall,
  type EngineSchedule,
  type EngineSegment,
} from "./engine.js";
import type { NewLayer, OncallRepository } from "./oncall.repository.js";
import type { ScheduleLayerRow, ScheduleOverrideRow, ScheduleRow } from "./schema/oncall.js";

const DAY_MS = 86_400_000;
/* How far ahead "who is next" looks. */
const NEXT_HORIZON_MS = 35 * DAY_MS;
/* Overrides can't be longer than this, so an old one is never left in force by accident. */
const MAX_OVERRIDE_MS = 62 * DAY_MS;

export interface OncallService {
  list(scope: WorkspaceScope): Promise<ScheduleSummary[]>;
  get(scope: WorkspaceScope, id: string): Promise<ScheduleView>;
  create(scope: WorkspaceScope, input: CreateScheduleInput): Promise<ScheduleView>;
  update(scope: WorkspaceScope, id: string, input: UpdateScheduleInput): Promise<ScheduleView>;
  delete(scope: WorkspaceScope, id: string): Promise<void>;
  addOverride(
    scope: WorkspaceScope,
    scheduleId: string,
    input: CreateOverrideInput,
  ): Promise<ScheduleOverrideView>;
  removeOverride(scope: WorkspaceScope, scheduleId: string, overrideId: string): Promise<void>;
  /* Who is on call at `at` (default now), and who takes over next. */
  onCall(scope: WorkspaceScope, id: string, at?: Date): Promise<OnCallNow>;
  timeline(scope: WorkspaceScope, id: string, from: Date, to: Date): Promise<OnCallSegment[]>;
  /* System: the user on call for a schedule at `at`; undefined when nobody is, or it is gone. */
  whoIsOnCall(scope: WorkspaceScope, scheduleId: string, at: Date): Promise<string | undefined>;
}

export interface OncallServiceDeps {
  db: Db;
  repository: OncallRepository;
  workspaces: Pick<WorkspacesService, "listMembers">;
  clock: Clock;
  newId: () => string;
}

export function createOncallService(deps: OncallServiceDeps): OncallService {
  const { repository: repo, clock } = deps;

  async function people(scope: WorkspaceScope) {
    const members = await deps.workspaces.listMembers(scope);
    const names = new Map(members.map((m) => [m.userId, m.name] as const));
    const pageable = new Set(
      members.filter((m) => roleCan(m.role, "contact:manage")).map((m) => m.userId),
    );
    const person = (userId: string): OnCallPerson => ({ userId, name: names.get(userId) ?? null });
    return { person, pageable };
  }

  const fail = (path: string, message: string) => new ValidationError(message, [{ path, message }]);

  function checkTimezone(timezone: string) {
    if (!isTimezone(timezone)) {
      throw fail("body.timezone", "Use an IANA time zone such as Europe/Berlin.");
    }
  }

  function toLayers(
    layers: ScheduleLayerInput[],
    pageable: Set<string>,
    newId: () => string,
  ): NewLayer[] {
    return layers.map((layer, i) => {
      const stranger = layer.participants.findIndex((id) => !pageable.has(id));
      if (stranger !== -1) {
        throw fail(
          `body.layers.${i}.participants.${stranger}`,
          "Only responders, members, admins and owners of this workspace can be on call.",
        );
      }
      return {
        id: newId(),
        name: layer.name,
        rotation: layer.rotation,
        shiftHours: layer.rotation === "custom" ? (layer.shiftHours ?? null) : null,
        startsAt: new Date(layer.startsAt),
        endsAt: layer.endsAt === undefined ? null : new Date(layer.endsAt),
        participants: layer.participants,
        restrictions: layer.restrictions,
      };
    });
  }

  const engineOf = (
    schedule: ScheduleRow,
    layers: ScheduleLayerRow[],
    overrides: ScheduleOverrideRow[],
  ): EngineSchedule => ({
    timezone: schedule.timezone,
    layers: layers.filter((l) => l.scheduleId === schedule.id),
    overrides: overrides.filter((o) => o.scheduleId === schedule.id),
  });

  async function load(scope: WorkspaceScope, id: string, from: Date, to: Date) {
    const schedule = await repo.findSchedule(deps.db, scope, id);
    if (schedule === undefined) throw new NotFoundError("Schedule not found.");
    const [layers, overrides] = await Promise.all([
      repo.layersOf(deps.db, scope, [id]),
      repo.overridesOf(deps.db, scope, [id], from, to),
    ]);
    return { schedule, layers, overrides, engine: engineOf(schedule, layers, overrides) };
  }

  const toSegment = (
    segment: EngineSegment,
    person: (userId: string) => OnCallPerson,
  ): OnCallSegment => ({
    startsAt: segment.startsAt.toISOString(),
    endsAt: segment.endsAt.toISOString(),
    user: segment.onCall === null ? null : person(segment.onCall.userId),
    source: segment.onCall?.source ?? null,
    layerName: segment.onCall?.layerName ?? null,
  });

  const toOverride = (
    row: ScheduleOverrideRow,
    person: (userId: string) => OnCallPerson,
  ): ScheduleOverrideView => ({
    id: row.id,
    user: person(row.userId),
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
  });

  const service: OncallService = {
    async list(scope) {
      const now = clock.now();
      const rows = await repo.listSchedules(deps.db, scope);
      const ids = rows.map((r) => r.id);
      const [layers, overrides, { person }] = await Promise.all([
        repo.layersOf(deps.db, scope, ids),
        repo.overridesOf(deps.db, scope, ids, now, new Date(now.getTime() + 1)),
        people(scope),
      ]);
      return rows.map((row) => {
        const onCall = engineWhoIsOnCall(engineOf(row, layers, overrides), now);
        return {
          id: row.id,
          name: row.name,
          timezone: row.timezone,
          onCall: onCall === null ? null : person(onCall.userId),
        };
      });
    },

    async get(scope, id) {
      const now = clock.now();
      const { schedule, layers, overrides } = await load(
        scope,
        id,
        now,
        new Date(now.getTime() + 10 * 365 * DAY_MS),
      );
      const { person } = await people(scope);
      return {
        id: schedule.id,
        name: schedule.name,
        timezone: schedule.timezone,
        layers: layers.map((l) => ({
          id: l.id,
          name: l.name,
          rotation: l.rotation,
          shiftHours: l.shiftHours,
          startsAt: l.startsAt.toISOString(),
          endsAt: l.endsAt === null ? null : l.endsAt.toISOString(),
          participants: l.participants.map(person),
          restrictions: l.restrictions,
        })),
        overrides: overrides.map((o) => toOverride(o, person)),
        createdAt: schedule.createdAt.toISOString(),
      };
    },

    async create(scope, input) {
      checkTimezone(input.timezone);
      const { pageable } = await people(scope);
      const layers = toLayers(input.layers, pageable, deps.newId);
      const id = deps.newId();
      await deps.db.transaction(async (tx) => {
        await repo.insertSchedule(tx, scope, {
          id,
          name: input.name,
          timezone: input.timezone,
          createdBy: scope.actorUserId ?? null,
        });
        await repo.replaceLayers(tx, scope, id, layers);
      });
      return service.get(scope, id);
    },

    async update(scope, id, input) {
      if (input.timezone !== undefined) checkTimezone(input.timezone);
      const layers =
        input.layers === undefined
          ? undefined
          : toLayers(input.layers, (await people(scope)).pageable, deps.newId);
      const existing = await repo.findSchedule(deps.db, scope, id);
      if (existing === undefined) throw new NotFoundError("Schedule not found.");
      await deps.db.transaction(async (tx) => {
        await repo.updateSchedule(tx, scope, id, {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
        });
        if (layers !== undefined) await repo.replaceLayers(tx, scope, id, layers);
      });
      return service.get(scope, id);
    },

    async delete(scope, id) {
      if (!(await repo.deleteSchedule(deps.db, scope, id))) {
        throw new NotFoundError("Schedule not found.");
      }
    },

    async addOverride(scope, scheduleId, input) {
      const schedule = await repo.findSchedule(deps.db, scope, scheduleId);
      if (schedule === undefined) throw new NotFoundError("Schedule not found.");
      const startsAt = new Date(input.startsAt);
      const endsAt = new Date(input.endsAt);
      if (endsAt.getTime() <= clock.now().getTime()) {
        throw fail("body.endsAt", "The override is already over.");
      }
      if (endsAt.getTime() - startsAt.getTime() > MAX_OVERRIDE_MS) {
        throw fail("body.endsAt", "An override can cover at most 62 days.");
      }
      const { person, pageable } = await people(scope);
      if (!pageable.has(input.userId)) {
        throw fail(
          "body.userId",
          "Only responders, members, admins and owners of this workspace can be on call.",
        );
      }
      const row = await repo.insertOverride(deps.db, scope, {
        id: deps.newId(),
        scheduleId,
        userId: input.userId,
        startsAt,
        endsAt,
        createdBy: scope.actorUserId ?? null,
      });
      return toOverride(row, person);
    },

    async removeOverride(scope, scheduleId, overrideId) {
      if (!(await repo.deleteOverride(deps.db, scope, scheduleId, overrideId))) {
        throw new NotFoundError("Override not found.");
      }
    },

    async onCall(scope, id, at = clock.now()) {
      const until = new Date(at.getTime() + NEXT_HORIZON_MS);
      const { engine } = await load(scope, id, at, until);
      const { person } = await people(scope);
      const [current, next] = engineTimeline(engine, at, until);
      return {
        at: at.toISOString(),
        current: current === undefined ? null : toSegment(current, person),
        next: next === undefined ? null : toSegment(next, person),
      };
    },

    async timeline(scope, id, from, to) {
      if (to.getTime() <= from.getTime()) {
        throw fail("query.to", "The range must end after it starts.");
      }
      if (to.getTime() - from.getTime() > MAX_TIMELINE_DAYS * DAY_MS) {
        throw fail("query.to", `A timeline can cover at most ${MAX_TIMELINE_DAYS} days.`);
      }
      const { engine } = await load(scope, id, from, to);
      const { person } = await people(scope);
      return engineTimeline(engine, from, to).map((s) => toSegment(s, person));
    },

    async whoIsOnCall(scope, scheduleId, at) {
      const schedule = await repo.findSchedule(deps.db, scope, scheduleId);
      if (schedule === undefined) return undefined;
      const [layers, overrides] = await Promise.all([
        repo.layersOf(deps.db, scope, [scheduleId]),
        repo.overridesOf(deps.db, scope, [scheduleId], at, new Date(at.getTime() + 1)),
      ]);
      return engineWhoIsOnCall(engineOf(schedule, layers, overrides), at)?.userId;
    },
  };
  return service;
}
