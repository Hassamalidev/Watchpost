import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../../core/clock.js";
import { createWorkspaceScope } from "../../../core/workspace-scope.js";
import { newId } from "../../../infra/ids.js";
import type { WorkspacesRepository } from "../workspaces.repository.js";
import { createWorkspacesService } from "../workspaces.service.js";

function fakeRepository(roles: Record<string, string>, members = [] as Array<{ role: string }>) {
  const repo: WorkspacesRepository = {
    findMemberRole: async (userId, workspaceId) => roles[`${userId}:${workspaceId}`],
    listMembers: async () =>
      members.map((m, i) => ({
        userId: `u${i}`,
        name: `User ${i}`,
        email: `u${i}@example.com`,
        role: m.role,
        joinedAt: new Date("2026-01-01T00:00:00Z"),
      })),
  };
  return repo;
}

describe("workspaces service", () => {
  const clock = createFakeClock();

  it("resolves the highest role, and undefined for non-members", async () => {
    const ws = newId();
    const service = createWorkspacesService({
      repository: fakeRepository({ [`a:${ws}`]: "member,admin", [`b:${ws}`]: "viewer" }),
      clock,
    });
    expect(await service.resolveRole("a", ws)).toBe("admin");
    expect(await service.resolveRole("b", ws)).toBe("viewer");
    expect(await service.resolveRole("c", ws)).toBeUndefined();
  });

  it("lists members with parsed roles and drops unknown roles", async () => {
    const service = createWorkspacesService({
      repository: fakeRepository({}, [{ role: "owner" }, { role: "mystery" }]),
      clock,
    });
    const scope = createWorkspaceScope({ workspaceId: newId(), role: "admin" });
    const members = await service.listMembers(scope);
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ role: "owner", joinedAt: "2026-01-01T00:00:00.000Z" });
  });
});
