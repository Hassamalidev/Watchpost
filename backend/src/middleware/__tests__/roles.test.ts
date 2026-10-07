import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import type { Permission } from "@app/shared";
import { ForbiddenError, NotFoundError } from "../../core/errors.js";
import { createWorkspaceScope, type WorkspaceRole } from "../../core/workspace-scope.js";
import { newId } from "../../infra/ids.js";
import { hasPermission, isPermissionGuard, parseMemberRole, requirePermission } from "../roles.js";

function runGuard(permission: Permission, role?: WorkspaceRole) {
  const next = vi.fn();
  const res = {
    locals: role ? { scope: createWorkspaceScope({ workspaceId: newId(), role }) } : {},
  } as unknown as Response;
  requirePermission(permission)({} as Request, res, next);
  return next.mock.calls[0]?.[0];
}

describe("hasPermission", () => {
  it("reads the shared table, and lets system work through", () => {
    expect(hasPermission("owner", "billing:manage")).toBe(true);
    expect(hasPermission("member", "channel:manage")).toBe(false);
    expect(hasPermission("responder", "incident:respond")).toBe(true);
    expect(hasPermission("responder", "monitor:write")).toBe(false);
    expect(hasPermission("billing", "monitor:read")).toBe(false);
    expect(hasPermission("system", "incident:drill")).toBe(true);
  });

  it("parses Better Auth role strings, keeping the broadest known role", () => {
    expect(parseMemberRole("member")).toBe("member");
    expect(parseMemberRole("member,admin")).toBe("admin");
    expect(parseMemberRole(" viewer , unknown ")).toBe("viewer");
    expect(parseMemberRole("unknown")).toBeUndefined();
    expect(parseMemberRole(null)).toBeUndefined();
  });
});

describe("requirePermission", () => {
  it("lets roles with the permission through", () => {
    expect(runGuard("channel:manage", "admin")).toBeUndefined();
    expect(runGuard("incident:respond", "responder")).toBeUndefined();
    expect(runGuard("billing:manage", "billing")).toBeUndefined();
  });

  it("rejects other roles with 403 and a missing scope with 404", () => {
    expect(runGuard("channel:manage", "member")).toBeInstanceOf(ForbiddenError);
    expect(runGuard("monitor:write", "responder")).toBeInstanceOf(ForbiddenError);
    expect(runGuard("incident:read", "billing")).toBeInstanceOf(ForbiddenError);
    expect(runGuard("monitor:read")).toBeInstanceOf(NotFoundError);
  });

  it("names its permission so tools can read what a route needs", () => {
    const guard = requirePermission("deploy:manage");
    expect(isPermissionGuard(guard)).toBe(true);
    expect(guard.permission).toBe("deploy:manage");
    expect(isPermissionGuard(() => undefined)).toBe(false);
  });
});
