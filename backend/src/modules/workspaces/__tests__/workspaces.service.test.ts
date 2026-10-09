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
  options: {
    roles?: Record<string, string>;
    members?: Array<{ role: string }>;
    parents?: Record<string, string>;
    clientLimit?: number;
  } = {},
) {
  const settings = new Map<string, WorkspaceSettingsRow>();
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const parents = new Map<string, string>(Object.entries(options.parents ?? {}));
  const repository: WorkspacesRepository = {
    findMemberRole: async (userId, workspaceId) => options.roles?.[`${userId}:${workspaceId}`],
    findParent: async (workspaceId) => parents.get(workspaceId),
    linkClient: async (workspaceId, parentId) => {
      parents.set(workspaceId, parentId);
    },
    listClients: async (scope) =>
      [...parents]
        .filter(([, parentId]) => parentId === scope.workspaceId)
        .map(([id]) => ({ id, name: `Client ${id}`, createdAt: new Date("2026-01-01T00:00:00Z") })),
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
  const service = createWorkspacesService({
    db,
    repository,
    outbox,
    clock,
    clientLimit: async () => options.clientLimit ?? 0,
    createWorkspace: async () => newId(),
  });
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

describe("client workspaces", () => {
  const agency = "00000000-0000-7000-8000-00000000a001";
  const client = "00000000-0000-7000-8000-00000000c001";

  it("lets the agency's owners and admins run a client workspace as admins, and nobody else", async () => {
    const { service } = setup({
      parents: { [client]: agency },
      roles: {
        [`owner:${agency}`]: "owner",
        [`admin:${agency}`]: "admin",
        [`member:${agency}`]: "member",
        [`viewer:${client}`]: "viewer",
        [`both:${agency}`]: "owner",
        [`both:${client}`]: "viewer",
      },
    });
    expect(await service.resolveRole("owner", client)).toBe("admin");
    expect(await service.resolveRole("admin", client)).toBe("admin");
    expect(await service.resolveRole("member", client)).toBeUndefined();
    expect(await service.resolveRole("stranger", client)).toBeUndefined();
    /* The client's own people keep the role they were invited with. */
    expect(await service.resolveRole("viewer", client)).toBe("viewer");
    expect(await service.resolveRole("viewer", agency)).toBeUndefined();
    /* A role given in the client workspace itself wins over the inherited one. */
    expect(await service.resolveRole("both", client)).toBe("viewer");
  });

  it("creates clients up to the plan's number, without a trial of their own", async () => {
    const { service, settings } = setup({ clientLimit: 2 });
    const scope = createWorkspaceScope({ workspaceId: agency });
    const first = await service.createClient(scope, "Bakery", { userId: "owner" });
    expect(first.name).toBe("Bakery");
    expect(await service.parentOf(first.id)).toBe(agency);
    expect(settings.get(first.id)?.trialEndsAt).toBeNull();
    await service.createClient(scope, "Florist", { userId: "owner" });
    expect(await service.listClients(scope)).toHaveLength(2);
    await expect(service.createClient(scope, "Third", { userId: "owner" })).rejects.toThrow(
      "includes 2 client workspaces",
    );
  });

  it("refuses on a plan without client workspaces, and inside a client workspace", async () => {
    const none = setup();
    await expect(
      none.service.createClient(createWorkspaceScope({ workspaceId: agency }), "Bakery", {
        userId: "owner",
      }),
    ).rejects.toThrow("Business plan");
    const nested = setup({ parents: { [client]: agency }, clientLimit: 5 });
    await expect(
      nested.service.createClient(createWorkspaceScope({ workspaceId: client }), "Deeper", {
        userId: "owner",
      }),
    ).rejects.toThrow("can't have client workspaces");
  });
});
