/*
 * Workspace roles for Better Auth's organization plugin (PRODUCT.md §6.11): owner, admin, member,
 * responder, viewer and billing. The permission table lives in @app/shared; this file turns it into
 * Better Auth's access control and adds what Better Auth guards itself (inviting, removing members,
 * updating or deleting the workspace). Our API routes check the same table through requirePermission.
 */
import { createAccessControl } from "better-auth/plugins/access";
import {
  adminAc,
  defaultStatements,
  memberAc,
  ownerAc,
} from "better-auth/plugins/organization/access";
import { WORKSPACE_STATEMENTS, roleStatements } from "@app/shared";

export {
  WORKSPACE_ROLES,
  isWorkspaceRole,
  type WorkspaceRole as WorkspaceRoleName,
} from "@app/shared";

export const accessControl = createAccessControl({ ...defaultStatements, ...WORKSPACE_STATEMENTS });

/*
 * Responders, viewers and billing members get none of Better Auth's own statements: they can't
 * invite, remove or change anyone, and can't rename or delete the workspace.
 */
export const workspaceRoles = {
  owner: accessControl.newRole({ ...ownerAc.statements, ...roleStatements("owner") }),
  admin: accessControl.newRole({ ...adminAc.statements, ...roleStatements("admin") }),
  member: accessControl.newRole({ ...memberAc.statements, ...roleStatements("member") }),
  responder: accessControl.newRole(roleStatements("responder")),
  viewer: accessControl.newRole(roleStatements("viewer")),
  billing: accessControl.newRole(roleStatements("billing")),
};
