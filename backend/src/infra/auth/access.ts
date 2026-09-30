/*
 * Workspace roles for Better Auth's organization plugin (PRODUCT.md §6.11).
 * P1: owner, admin, member, viewer. Responder and billing arrive in P4-T01.
 * Better Auth enforces these for its own endpoints (invite, remove member, update workspace);
 * our API routes use requireRole with the same names.
 */
import { createAccessControl } from "better-auth/plugins/access";
import {
  adminAc,
  defaultStatements,
  memberAc,
  ownerAc,
} from "better-auth/plugins/organization/access";

export const WORKSPACE_ROLES = ["owner", "admin", "member", "viewer"] as const;
export type WorkspaceRoleName = (typeof WORKSPACE_ROLES)[number];

export const accessControl = createAccessControl(defaultStatements);

export const workspaceRoles = {
  owner: accessControl.newRole(ownerAc.statements),
  admin: accessControl.newRole(adminAc.statements),
  member: accessControl.newRole(memberAc.statements),
  viewer: accessControl.newRole({}),
};

export function isWorkspaceRole(value: string): value is WorkspaceRoleName {
  return (WORKSPACE_ROLES as readonly string[]).includes(value);
}
