import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { ForbiddenError, NotFoundError } from "../../core/errors.js";
import { createWorkspaceScope, type WorkspaceRole } from "../../core/workspace-scope.js";
import { newId } from "../../infra/ids.js";
import { hasRole, parseMemberRole, requireRole } from "../roles.js";

function runGuard(minimum: WorkspaceRole, role?: WorkspaceRole) {
  const next = vi.fn();
  const res = {
    locals: role ? { scope: createWorkspaceScope({ workspaceId: newId(), role }) } : {},
  } as unknown as Response;
  requireRole(minimum)({} as Request, res, next);
  return next.mock.calls[0]?.[0];
}

describe("role ranking", () => {
  it("orders viewer < member < admin < owner", () => {
    expect(hasRole("owner", "admin")).toBe(true);
    expect(hasRole("admin", "admin")).toBe(true);
    expect(hasRole("member", "admin")).toBe(false);
    expect(hasRole("viewer", "member")).toBe(false);
    expect(hasRole("responder", "member")).toBe(false);
    expect(hasRole("billing", "viewer")).toBe(false);
    expect(hasRole("system", "owner")).toBe(true);
  });

  it("parses Better Auth role strings, keeping the highest known role", () => {
    expect(parseMemberRole("member")).toBe("member");
    expect(parseMemberRole("member,admin")).toBe("admin");
    expect(parseMemberRole(" viewer , unknown ")).toBe("viewer");
    expect(parseMemberRole("unknown")).toBeUndefined();
    expect(parseMemberRole(null)).toBeUndefined();
  });
});

describe("requireRole", () => {
  it("lets the minimum role and higher through", () => {
    expect(runGuard("admin", "admin")).toBeUndefined();
    expect(runGuard("admin", "owner")).toBeUndefined();
  });

  it("rejects lower roles with 403 and a missing scope with 404", () => {
    expect(runGuard("admin", "member")).toBeInstanceOf(ForbiddenError);
    expect(runGuard("member", "viewer")).toBeInstanceOf(ForbiddenError);
    expect(runGuard("viewer")).toBeInstanceOf(NotFoundError);
  });
});
