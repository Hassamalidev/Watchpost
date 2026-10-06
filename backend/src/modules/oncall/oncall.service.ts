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
import { createHash, randomBytes } from "node:crypto";
import type { Clock } from "../../core/clock.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../../core/errors.js";
import { createWorkspaceScope, type WorkspaceScope } from "../../core/workspace-scope.js";
import type { Db } from "../../infra/db/index.js";
import type { Outbox } from "../../infra/outbox/index.js";
import type { ContactsService } from "../contacts/index.js";
import type { WorkspacesService } from "../workspaces/index.js";
import {
  isTimezone,
  timeline as engineTimeline,
  whoIsOnCall as engineWhoIsOnCall,
  type EngineSchedule,
  type EngineSegment,
} from "./engine.js";
import { toICalendar, type CalendarEvent } from "./ical.js";
import type { NewLayer, OncallRepository } from "./oncall.repository.js";
import type { ScheduleLayerRow, ScheduleOverrideRow, ScheduleRow } from "./schema/oncall.js";

const DAY_MS = 86_400_000;
/* How far ahead "who is next" looks. */
const NEXT_HORIZON_MS = 35 * DAY_MS;
/* Overrides can't be longer than this, so an old one is never left in force by accident. */
const MAX_OVERRIDE_MS = 62 * DAY_MS;
/* What a calendar feed covers: a week back, two months ahead. */
const FEED_PAST_MS = 7 * DAY_MS;
const FEED_AHEAD_MS = 60 * DAY_MS;
/*
 * How far back the shift sweep looks for starts and ends it hasn't announced. Longer than any
 * worker restart; a boundary older than this is no longer news.
 */
export const SHIFT_NOTICE_LOOKBACK_MS = 30 * 60_000;

/* One stretch during which a person is on call for a schedule. */
export interface Shift {
  scheduleId: string;
  scheduleName: string;
  startsAt: Date;
  endsAt: Date;
  source: "override" | "layer";
}

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
  /* Whether the acting user has a calendar feed, and since when. */
  feed(scope: WorkspaceScope): Promise<{ exists: boolean; createdAt: string | null }>;
  /* Creates the acting user's feed URL, or replaces it; the URL is shown this once. */
  rotateFeed(scope: WorkspaceScope): Promise<{ url: string }>;
  removeFeed(scope: WorkspaceScope): Promise<void>;
  /* Token URL: the calendar behind a feed token; undefined for an unknown token. */
  calendar(token: string): Promise<string | undefined>;
  /* System: a person's shifts across every schedule of the workspace that overlap (from, to). */
  shiftsOf(scope: WorkspaceScope, userId: string, from: Date, to: Date): Promise<Shift[]>;
  /*
   * System (sweep): emails everyone whose shift started or ended since the last look, once each,
   * through their low-urgency email methods. Returns how many notices were sent.
   */
  notifyShifts(): Promise<number>;
  /* System: the user on call for a schedule at `at`; undefined when nobody is, or it is gone. */
  whoIsOnCall(scope: WorkspaceScope, scheduleId: string, at: Date): Promise<string | undefined>;
}

export interface OncallServiceDeps {
  db: Db;
  repository: OncallRepository;
  workspaces: Pick<WorkspacesService, "listMembers" | "workspaceName">;
  /* Where a person wants to hear things; optional so tests can build schedules without it. */
  contacts?: Pick<ContactsService, "fanOut"> | undefined;
  outbox?: Outbox | undefined;
  clock: Clock;
  newId: () => string;
  /* Where the API is reached from outside, for feed URLs. */
  webOrigin: string;
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

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

    async feed(scope) {
      if (scope.actorUserId === undefined) return { exists: false, createdAt: null };
      const row = await repo.findFeed(deps.db, scope, scope.actorUserId);
      return { exists: row !== undefined, createdAt: row?.createdAt.toISOString() ?? null };
    },

    async rotateFeed(scope) {
      if (scope.actorUserId === undefined) {
        throw new ForbiddenError("A calendar feed belongs to a signed-in member.");
      }
      const token = randomBytes(32).toString("base64url");
      await repo.saveFeed(deps.db, scope, {
        id: deps.newId(),
        userId: scope.actorUserId,
        tokenHash: hashToken(token),
      });
      return { url: `${deps.webOrigin}/api/oncall/ical/${token}.ics` };
    },

    async removeFeed(scope) {
      if (scope.actorUserId !== undefined) await repo.deleteFeed(deps.db, scope, scope.actorUserId);
    },

    async calendar(token) {
      const feed = await repo.findFeedByHash(deps.db, hashToken(token));
      if (feed === undefined) return undefined;
      const scope = createWorkspaceScope({ workspaceId: feed.workspaceId });
      /* Someone who left the workspace keeps no view of its schedules. */
      const members = await deps.workspaces.listMembers(scope);
      if (!members.some((m) => m.userId === feed.userId)) return undefined;
      const now = clock.now();
      const shifts = await service.shiftsOf(
        scope,
        feed.userId,
        new Date(now.getTime() - FEED_PAST_MS),
        new Date(now.getTime() + FEED_AHEAD_MS),
      );
      const workspaceName = await deps.workspaces.workspaceName(scope);
      const events: CalendarEvent[] = shifts.map((shift) => ({
        uid: `${shift.scheduleId}-${shift.startsAt.getTime()}-${feed.userId}@watchpost`,
        startsAt: shift.startsAt,
        endsAt: shift.endsAt,
        summary: `On call: ${shift.scheduleName}`,
        description:
          shift.source === "override"
            ? `You are covering ${shift.scheduleName} in ${workspaceName} (override).`
            : `You are on call for ${shift.scheduleName} in ${workspaceName}.`,
      }));
      return toICalendar({ name: `On-call (${workspaceName})`, now, events });
    },

    async shiftsOf(scope, userId, from, to) {
      const rows = await repo.listSchedules(deps.db, scope);
      const ids = rows.map((r) => r.id);
      const [layers, overrides] = await Promise.all([
        repo.layersOf(deps.db, scope, ids),
        repo.overridesOf(deps.db, scope, ids, from, to),
      ]);
      const shifts: Shift[] = [];
      for (const row of rows) {
        for (const segment of engineTimeline(engineOf(row, layers, overrides), from, to)) {
          if (segment.onCall?.userId !== userId) continue;
          shifts.push({
            scheduleId: row.id,
            scheduleName: row.name,
            startsAt: segment.startsAt,
            endsAt: segment.endsAt,
            source: segment.onCall.source,
          });
        }
      }
      return shifts.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
    },

    async notifyShifts() {
      const { contacts, outbox } = deps;
      if (contacts === undefined || outbox === undefined) return 0;
      const now = clock.now();
      const since = new Date(now.getTime() - SHIFT_NOTICE_LOOKBACK_MS);
      let sent = 0;
      for (const workspaceId of await repo.workspacesWithSchedules(deps.db)) {
        const scope = createWorkspaceScope({ workspaceId });
        const rows = await repo.listSchedules(deps.db, scope);
        const ids = rows.map((r) => r.id);
        const [layers, overrides, { person }, workspaceName] = await Promise.all([
          repo.layersOf(deps.db, scope, ids),
          repo.overridesOf(deps.db, scope, ids, since, new Date(now.getTime() + NEXT_HORIZON_MS)),
          people(scope),
          deps.workspaces.workspaceName(scope),
        ]);
        for (const row of rows) {
          /* A little past now, so the stretch that has just begun is known with its end. */
          const segments = engineTimeline(
            engineOf(row, layers, overrides),
            since,
            new Date(now.getTime() + NEXT_HORIZON_MS),
          );
          for (let i = 1; i < segments.length; i += 1) {
            const before = segments[i - 1] as EngineSegment;
            const after = segments[i] as EngineSegment;
            const at = after.startsAt;
            if (at.getTime() > now.getTime()) break;
            const leaving = before.onCall?.userId;
            const arriving = after.onCall?.userId;
            /* The same person carrying on (a layer handing to their own override) isn't a handoff. */
            if (leaving === arriving) continue;
            const notices = [
              ...(arriving === undefined
                ? []
                : [
                    {
                      userId: arriving,
                      kind: "start" as const,
                      other: leaving,
                      until: after.endsAt,
                    },
                  ]),
              ...(leaving === undefined
                ? []
                : [{ userId: leaving, kind: "end" as const, other: arriving, until: undefined }]),
            ];
            for (const notice of notices) {
              const steps = (await contacts.fanOut(scope, notice.userId, "low", at)).filter(
                (step) => step.type === "email",
              );
              const told = await deps.db.transaction(async (tx) => {
                const fresh = await repo.claimShiftNotice(tx, scope, {
                  id: deps.newId(),
                  scheduleId: row.id,
                  userId: notice.userId,
                  kind: notice.kind,
                  at,
                });
                if (!fresh) return false;
                for (const step of steps) {
                  await outbox.emit(
                    tx,
                    "email.requested",
                    {
                      template: "shift-notice",
                      to: step.address,
                      data: {
                        kind: notice.kind,
                        scheduleName: row.name,
                        workspaceName,
                        timezone: row.timezone,
                        at: at.toISOString(),
                        ...(notice.until === undefined
                          ? {}
                          : { until: notice.until.toISOString() }),
                        ...(notice.other === undefined
                          ? {}
                          : { otherName: person(notice.other).name ?? "A former member" }),
                        url: `${deps.webOrigin}/w/${workspaceId}/on-call/${row.id}`,
                      },
                      idempotencyKey: `shift.${row.id}.${notice.userId}.${notice.kind}.${at.getTime()}.${step.contactMethodId}`,
                    },
                    { workspaceId },
                  );
                }
                return steps.length > 0;
              });
              if (told) sent += 1;
            }
          }
        }
      }
      return sent;
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
