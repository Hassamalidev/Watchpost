import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../../core/clock.js";
import { createWorkspaceScope } from "../../../core/workspace-scope.js";
import type { Db } from "../../../infra/db/index.js";
import { newId } from "../../../infra/ids.js";
import type { Outbox } from "../../../infra/outbox/index.js";
import type { WorkspaceSettingsRow } from "../schema/workspace-settings.js";
import type { WorkspacesRepository } from "../workspaces.repository.js";
import { TRIAL_DAYS, createWorkspacesService } from "../workspaces.service.js";

function setup(
  options: { roles?: Record<string, string>; members?: Array<{ role: string }> } = {},
) {
  const settings = new Map<string, WorkspaceSettingsRow>();
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const repository: WorkspacesRepository = {
    findMemberRole: async (userId, workspaceId) => options.roles?.[`${userId}:${workspaceId}`],
    listMembers: async () =>
      (options.members ?? []).map((m, i) => ({
        userId: `u${i}`,
        name: `User ${i}`,
        email: `u${i}@example.com`,
        role: m.role,
        joinedAt: new Date("2026-01-01T00:00:00Z"),
      })),
    workspaceName: async () => "Acme",
    countMembers: async () => (options.members ?? []).length,
    trialsEndingBetween: async () => [],
    workspaceIds: async () => [],
    insertSettingsIfMissing: async (_tx, values) => {
      if (settings.has(values.workspaceId)) return false;
      settings.set(values.workspaceId, {
        workspaceId: values.workspaceId,
        timezone: "UTC",
        requireTwoFactor: false,
        incidentSeq: 0,
        trialEndsAt: values.trialEndsAt,
        flags: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return true;
    },
    findSettings: async (scope) => settings.get(scope.workspaceId),
    updateSettings: async (scope, patch) => {
      const row = settings.get(scope.workspaceId);
      if (row === undefined) return undefined;
      Object.assign(row, patch);
      return row;
    },
    nextIncidentNumber: async (_tx, scope) => {
      const row = settings.get(scope.workspaceId);
      if (row === undefined) return undefined;
      row.incidentSeq += 1;
      return row.incidentSeq;
    },
    findWorkspacesWithoutSettings: async () => [],
  };
  const db = {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  } as unknown as Db;
  const outbox = {
    emit: async (_tx: unknown, type: string, payload: unknown) => {
      emitted.push({ type, payload });
      return newId();
    },
  } as unknown as Outbox;
  const clock = createFakeClock("2026-01-01T00:00:00Z");
  const service = createWorkspacesService({ db, repository, outbox, clock });
  return { service, emitted, settings, db };
}

describe("workspaces service", () => {
  it("resolves the highest role, and undefined for non-members", async () => {
    const ws = newId();
    const { service } = setup({ roles: { [`a:${ws}`]: "member,admin", [`b:${ws}`]: "viewer" } });
    expect(await service.resolveRole("a", ws)).toBe("admin");
    expect(await service.resolveRole("b", ws)).toBe("viewer");
    expect(await service.resolveRole("c", ws)).toBeUndefined();
  });

  it("lists members with parsed roles and drops unknown roles", async () => {
    const { service } = setup({ members: [{ role: "owner" }, { role: "mystery" }] });
    const members = await service.listMembers(
      createWorkspaceScope({ workspaceId: newId(), role: "admin" }),
    );
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ role: "owner", joinedAt: "2026-01-01T00:00:00.000Z" });
  });

  it("creates default settings with a 14-day trial and emits workspace.created once", async () => {
    const { service, emitted, settings } = setup();
    const ws = newId();
    expect(await service.ensureSettings(ws)).toBe(true);
    expect(await service.ensureSettings(ws)).toBe(false);
    expect(emitted).toEqual([{ type: "workspace.created", payload: { workspaceId: ws } }]);
    expect(settings.get(ws)?.trialEndsAt?.toISOString()).toBe(
      new Date(Date.parse("2026-01-01T00:00:00Z") + TRIAL_DAYS * 86_400_000).toISOString(),
    );
  });

  it("creates settings lazily on first read", async () => {
    const { service, emitted } = setup();
    const scope = createWorkspaceScope({ workspaceId: newId(), role: "member" });
    const settings = await service.getSettings(scope);
    expect(settings).toMatchObject({ workspaceId: scope.workspaceId, timezone: "UTC", flags: {} });
    expect(emitted).toHaveLength(1);
  });

  it("hands out sequential incident numbers, creating settings if needed", async () => {
    const { service, db } = setup();
    const scope = createWorkspaceScope({ workspaceId: newId() });
    expect(await service.nextIncidentNumber(db, scope)).toBe(1);
    expect(await service.nextIncidentNumber(db, scope)).toBe(2);
  });
});
