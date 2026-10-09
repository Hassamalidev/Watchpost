/*
 * The audit log (PRODUCT.md §6.11): who changed what in a workspace, and when. Security events
 * (people, roles, keys, probes, webhooks, security settings) are kept for every plan; the full log
 * of configuration and incident actions is part of Business.
 */
export const AUDIT_CATEGORIES = ["security", "config", "incident"] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

export const AUDIT_ACTOR_TYPES = ["user", "api_key", "system"] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

/* How long entries are kept. */
export const AUDIT_RETENTION_DAYS = 400;

export interface AuditEntryView {
  id: string;
  at: string;
  category: AuditCategory;
  /* What was done, as `<thing>.<verb>`: "monitors.pause", "member.role_changed". */
  action: string;
  actor: { type: AuditActorType; id: string | null; label: string };
  /* The ID of what it was done to, when there is one. */
  targetId: string | null;
  /* A name to recognise it by (the monitor's name, the invited address); never a secret. */
  detail: string | null;
  ip: string | null;
}

export interface AuditLogPage {
  data: AuditEntryView[];
  nextCursor: string | null;
  /* True when the plan shows security events only. */
  securityOnly: boolean;
}

/* Things whose changes are security events, whatever the plan. */
const SECURITY_RESOURCES = new Set([
  "api-keys",
  "private-probes",
  "webhooks",
  "settings",
  "security",
  "member",
  "invitation",
]);
const INCIDENT_RESOURCES = new Set(["incidents"]);

export function auditCategoryOf(resource: string): AuditCategory {
  if (SECURITY_RESOURCES.has(resource)) return "security";
  return INCIDENT_RESOURCES.has(resource) ? "incident" : "config";
}

/*
 * The action a request stands for, from its method and route: `POST /monitors/:monitorId/pause` is
 * "monitors.pause", `PATCH /monitors/:monitorId` is "monitors.update". Undefined for a route that
 * names nothing (the root).
 */
export function auditActionOf(method: string, route: string): string | undefined {
  const parts = route.split("/").filter((part) => part !== "" && !part.startsWith(":"));
  const resource = parts[0];
  if (resource === undefined) return undefined;
  const last = parts.at(-1);
  const verb =
    parts.length > 1 && last !== undefined
      ? parts.slice(1).join("_").replace(/-/g, "_")
      : method === "POST"
        ? "create"
        : method === "DELETE"
          ? "delete"
          : "update";
  return `${resource}.${verb}`;
}
