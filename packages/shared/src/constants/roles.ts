/*
 * Workspace roles and what each may do (PRODUCT.md §6.11). This table is the single source: the API
 * guards every workspace route with one of these permissions, Better Auth's access control is built
 * from it, and the web app hides what a role can't do.
 */
export const WORKSPACE_ROLES = [
  "owner",
  "admin",
  "member",
  "responder",
  "viewer",
  "billing",
] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/* Resources and actions. Names stay clear of Better Auth's own (organization, member, invitation, team, ac). */
export const WORKSPACE_STATEMENTS = {
  /* The workspace itself: its name, timezone and other settings. */
  settings: ["read", "update"],
  /* Who is in the workspace. Inviting and removing go through Better Auth's own statements. */
  roster: ["read"],
  /* Monitors, groups, tags, heartbeats, checks, uptime and charts. */
  monitor: ["read", "write"],
  /* respond: acknowledge, resolve and comment. write: open by hand, mark a false alarm. */
  incident: ["read", "respond", "write", "drill"],
  maintenance: ["read", "write"],
  alertPolicy: ["read", "write"],
  /* Integrations: alert channels, chat app installs, phone numbers. */
  channel: ["read", "manage"],
  deploy: ["read", "manage"],
  /* On-call schedules. override: put yourself or a colleague on call for a while ("cover for me"). */
  schedule: ["read", "write", "override"],
  /* Your own contact methods and notification rules; only people who can be paged have them. */
  contact: ["manage"],
  /* read: plan, limits, usage and credits. manage: checkout, plan changes, cancel, portal. */
  billing: ["read", "manage"],
} as const;

export type WorkspaceResource = keyof typeof WORKSPACE_STATEMENTS;
export type Permission = {
  [R in WorkspaceResource]: `${R}:${(typeof WORKSPACE_STATEMENTS)[R][number]}`;
}[WorkspaceResource];

export const PERMISSIONS: readonly Permission[] = Object.entries(WORKSPACE_STATEMENTS).flatMap(
  ([resource, actions]) => actions.map((action) => `${resource}:${action}` as Permission),
);

const VIEWER: readonly Permission[] = [
  "settings:read",
  "monitor:read",
  "incident:read",
  "maintenance:read",
  "alertPolicy:read",
  "channel:read",
  "deploy:read",
  "schedule:read",
  "billing:read",
];
const RESPONDER: readonly Permission[] = [
  ...VIEWER,
  "incident:respond",
  "contact:manage",
  "schedule:override",
];
const MEMBER: readonly Permission[] = [
  ...RESPONDER,
  "monitor:write",
  "incident:write",
  "maintenance:write",
];

export const ROLE_PERMISSIONS: Record<WorkspaceRole, readonly Permission[]> = {
  owner: PERMISSIONS,
  /* Admins differ from owners only inside Better Auth: deleting the workspace and changing owners. */
  admin: PERMISSIONS,
  member: MEMBER,
  responder: RESPONDER,
  viewer: VIEWER,
  /* Billing pages only: the plan and its meters, nothing about monitors or incidents. */
  billing: ["settings:read", "billing:read", "billing:manage"],
};

export function isWorkspaceRole(value: string): value is WorkspaceRole {
  return (WORKSPACE_ROLES as readonly string[]).includes(value);
}

export function roleCan(role: WorkspaceRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/* The same table shaped for Better Auth's `newRole` ({ resource: actions[] }). */
export type RoleStatements = {
  [R in WorkspaceResource]?: (typeof WORKSPACE_STATEMENTS)[R][number][];
};

export function roleStatements(role: WorkspaceRole): RoleStatements {
  const out: Partial<Record<WorkspaceResource, string[]>> = {};
  for (const permission of ROLE_PERMISSIONS[role]) {
    const [resource, action] = permission.split(":") as [WorkspaceResource, string];
    (out[resource] ??= []).push(action);
  }
  return out as RoleStatements;
}

/*
 * A member row can hold several roles ("admin,member"). The one that grants the most wins; billing
 * grants the least outside its own pages.
 */
const BREADTH: Record<WorkspaceRole, number> = {
  billing: 0,
  viewer: 1,
  responder: 2,
  member: 3,
  admin: 4,
  owner: 5,
};

export function broadestRole(value: string | null | undefined): WorkspaceRole | undefined {
  let best: WorkspaceRole | undefined;
  for (const raw of (value ?? "").split(",")) {
    const role = raw.trim();
    if (!isWorkspaceRole(role)) continue;
    if (best === undefined || BREADTH[role] > BREADTH[best]) best = role;
  }
  return best;
}
