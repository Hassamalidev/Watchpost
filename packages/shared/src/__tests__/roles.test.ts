/* P4-T01: the permission matrix for all six roles, written out by hand (PRODUCT.md §6.11). */
import { describe, expect, it } from "vitest";
import {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  WORKSPACE_ROLES,
  broadestRole,
  isWorkspaceRole,
  roleCan,
  roleStatements,
  type Permission,
  type WorkspaceRole,
} from "../index.js";

/* Columns: owner, admin, member, responder, viewer, billing. */
const MATRIX: Record<Permission, [boolean, boolean, boolean, boolean, boolean, boolean]> = {
  "settings:read": [true, true, true, true, true, true],
  "settings:update": [true, true, false, false, false, false],
  "roster:read": [true, true, false, false, false, false],
  "monitor:read": [true, true, true, true, true, false],
  "monitor:write": [true, true, true, false, false, false],
  "incident:read": [true, true, true, true, true, false],
  "incident:respond": [true, true, true, true, false, false],
  "incident:write": [true, true, true, false, false, false],
  "incident:drill": [true, true, false, false, false, false],
  "maintenance:read": [true, true, true, true, true, false],
  "maintenance:write": [true, true, true, false, false, false],
  "alertPolicy:read": [true, true, true, true, true, false],
  "alertPolicy:write": [true, true, false, false, false, false],
  "channel:read": [true, true, true, true, true, false],
  "channel:manage": [true, true, false, false, false, false],
  "deploy:read": [true, true, true, true, true, false],
  "deploy:manage": [true, true, false, false, false, false],
  "billing:read": [true, true, true, true, true, true],
  "billing:manage": [true, true, false, false, false, true],
};
const COLUMNS: WorkspaceRole[] = ["owner", "admin", "member", "responder", "viewer", "billing"];

describe("permission matrix", () => {
  it("covers every permission and every role", () => {
    expect(Object.keys(MATRIX).sort()).toEqual([...PERMISSIONS].sort());
    expect([...COLUMNS].sort()).toEqual([...WORKSPACE_ROLES].sort());
  });

  for (const [permission, row] of Object.entries(MATRIX) as [Permission, boolean[]][]) {
    for (const [i, role] of COLUMNS.entries()) {
      it(`${role} ${row[i] ? "may" : "may not"} ${permission}`, () => {
        expect(roleCan(role, permission)).toBe(row[i]);
      });
    }
  }

  it("lets a responder do exactly what a viewer does, plus respond to incidents", () => {
    const extra = ROLE_PERMISSIONS.responder.filter((p) => !ROLE_PERMISSIONS.viewer.includes(p));
    expect(extra).toEqual(["incident:respond"]);
  });

  it("keeps the billing role to billing pages", () => {
    expect([...ROLE_PERMISSIONS.billing].sort()).toEqual([
      "billing:manage",
      "billing:read",
      "settings:read",
    ]);
  });
});

describe("role helpers", () => {
  it("recognises the six roles and nothing else", () => {
    expect(WORKSPACE_ROLES.every(isWorkspaceRole)).toBe(true);
    expect(isWorkspaceRole("superuser")).toBe(false);
  });

  it("picks the broadest of several stored roles", () => {
    expect(broadestRole("member")).toBe("member");
    expect(broadestRole("member,admin")).toBe("admin");
    expect(broadestRole("billing,responder")).toBe("responder");
    expect(broadestRole(" viewer , unknown ")).toBe("viewer");
    expect(broadestRole("unknown")).toBeUndefined();
    expect(broadestRole(null)).toBeUndefined();
  });

  it("shapes a role's permissions for Better Auth", () => {
    expect(roleStatements("billing")).toEqual({ settings: ["read"], billing: ["read", "manage"] });
    expect(roleStatements("responder").incident).toEqual(["read", "respond"]);
  });
});
