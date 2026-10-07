/*
 * P4-T01: every route under /api/w/:workspaceId carries exactly one permission guard, and the list of
 * what each route needs is written down here. Together with the role table in @app/shared (tested
 * role by role there) this is the full route-by-role matrix. A new route without a guard, or a guard
 * that changes, fails this test.
 */
import { afterAll, describe, expect, it } from "vitest";
import { PERMISSIONS } from "@app/shared";
import { isPermissionGuard } from "../../middleware/roles.js";
import { buildContainerApp } from "../../__tests__/helpers/container-app.js";

const ctx = buildContainerApp();

afterAll(async () => {
  await ctx.container.close();
});

interface RouteLayer {
  route?: {
    path: string | string[];
    methods: Record<string, boolean>;
    stack: { handle: unknown }[];
  };
}

const WORKSPACE_PREFIX = "/api/w/:workspaceId";

function workspaceRoutes(): { route: string; permissions: string[] }[] {
  const found: { route: string; permissions: string[] }[] = [];
  for (const mounted of ctx.container.routers) {
    if (mounted.path !== WORKSPACE_PREFIX) continue;
    for (const layer of mounted.router.stack as unknown as RouteLayer[]) {
      if (layer.route === undefined) continue;
      const permissions = layer.route.stack
        .map((l) => l.handle)
        .filter(isPermissionGuard)
        .map((g) => g.permission);
      for (const path of [layer.route.path].flat()) {
        for (const method of Object.keys(layer.route.methods)) {
          found.push({ route: `${method.toUpperCase()} ${path}`, permissions });
        }
      }
    }
  }
  return found.sort((a, b) => a.route.localeCompare(b.route));
}

describe("workspace route permissions", () => {
  const routes = workspaceRoutes();

  it("finds the workspace routes", () => {
    expect(routes.length).toBeGreaterThanOrEqual(122);
  });

  it("guards every workspace route with exactly one known permission", () => {
    const wrong = routes.filter(
      (r) => r.permissions.length !== 1 || !PERMISSIONS.includes(r.permissions[0] as never),
    );
    expect(wrong).toEqual([]);
  });

  it("matches the written list of what each route needs", () => {
    expect(routes.map((r) => `${r.route} → ${r.permissions.join(", ")}`)).toMatchInlineSnapshot(`
      [
        "DELETE /alert-policies/:policyId → alertPolicy:write",
        "DELETE /channels/:channelId → channel:manage",
        "DELETE /escalation-policies/:policyId → schedule:write",
        "DELETE /inbound-sources/:sourceId → channel:manage",
        "DELETE /maintenance-windows/:windowId → maintenance:write",
        "DELETE /me/chat-links/:linkId → contact:manage",
        "DELETE /me/contact-methods/:methodId → contact:manage",
        "DELETE /me/oncall-feed → contact:manage",
        "DELETE /monitor-groups/:groupId → monitor:write",
        "DELETE /monitors/:monitorId → monitor:write",
        "DELETE /schedules/:scheduleId → schedule:write",
        "DELETE /schedules/:scheduleId/overrides/:overrideId → schedule:override",
        "DELETE /status-pages/:pageId → statusPage:write",
        "DELETE /status-pages/:pageId/incidents/:incidentId → statusPage:write",
        "DELETE /status-pages/:pageId/subscribers/:subscriberId → statusPage:write",
        "GET /alert-policies → alertPolicy:read",
        "GET /alert-tuning → incident:read",
        "GET /alert-tuning/:monitorId → incident:read",
        "GET /billing → billing:read",
        "GET /channels → channel:read",
        "GET /channels/:channelId → channel:manage",
        "GET /channels/types → channel:read",
        "GET /check-regions → monitor:read",
        "GET /credits → billing:read",
        "GET /deploy-hook → deploy:read",
        "GET /deploys → deploy:read",
        "GET /entitlements → billing:read",
        "GET /error-budgets → monitor:read",
        "GET /escalation-policies → schedule:read",
        "GET /expiry/:monitorId → monitor:read",
        "GET /heartbeats → monitor:read",
        "GET /heartbeats/:monitorId → monitor:read",
        "GET /imports → settings:update",
        "GET /inbound-sources → channel:read",
        "GET /incidents → incident:read",
        "GET /incidents/:incidentId/deliveries → incident:read",
        "GET /incidents/:incidentId/escalation → incident:read",
        "GET /incidents/:incidentRef → incident:read",
        "GET /incidents/:incidentRef/evidence → incident:read",
        "GET /incidents/summary → incident:read",
        "GET /integrations/slack/install → channel:manage",
        "GET /integrations/slack/installations → channel:manage",
        "GET /integrations/slack/installations/:installationId/channels → channel:manage",
        "GET /maintenance-windows → maintenance:read",
        "GET /maintenance-windows/:windowId → maintenance:read",
        "GET /me → settings:read",
        "GET /me/chat-links → contact:manage",
        "GET /me/chat-links/preview → contact:manage",
        "GET /me/contact-methods → contact:manage",
        "GET /me/notification-rules → contact:manage",
        "GET /me/on-call → contact:manage",
        "GET /me/oncall-feed → contact:manage",
        "GET /me/push → contact:manage",
        "GET /members → roster:read",
        "GET /monitor-groups → monitor:read",
        "GET /monitor-states → monitor:read",
        "GET /monitor-usage → billing:read",
        "GET /monitors → monitor:read",
        "GET /monitors/:monitorId → monitor:read",
        "GET /monitors/:monitorId/badges → monitor:read",
        "GET /monitors/:monitorId/changes → monitor:read",
        "GET /monitors/:monitorId/checks → monitor:read",
        "GET /monitors/:monitorId/error-budget → monitor:read",
        "GET /monitors/:monitorId/latency → monitor:read",
        "GET /monitors/:monitorId/uptime → monitor:read",
        "GET /monitors/:monitorId/uptime/days → monitor:read",
        "GET /phone-numbers/cost → channel:manage",
        "GET /probe-tasks/:taskId → monitor:read",
        "GET /schedules → schedule:read",
        "GET /schedules/:scheduleId → schedule:read",
        "GET /schedules/:scheduleId/on-call → schedule:read",
        "GET /schedules/:scheduleId/timeline → schedule:read",
        "GET /settings → settings:read",
        "GET /status-pages → statusPage:read",
        "GET /status-pages/:pageId → statusPage:read",
        "GET /status-pages/:pageId/incidents → statusPage:read",
        "GET /status-pages/:pageId/preview → statusPage:read",
        "GET /status-pages/:pageId/subscribers → statusPage:read",
        "GET /tags → monitor:read",
        "PATCH /alert-policies/:policyId → alertPolicy:write",
        "PATCH /channels/:channelId → channel:manage",
        "PATCH /escalation-policies/:policyId → schedule:write",
        "PATCH /maintenance-windows/:windowId → maintenance:write",
        "PATCH /monitor-groups/:groupId → monitor:write",
        "PATCH /monitors/:monitorId → monitor:write",
        "PATCH /schedules/:scheduleId → schedule:write",
        "PATCH /settings → settings:update",
        "PATCH /status-pages/:pageId → statusPage:write",
        "PATCH /status-pages/:pageId/incidents/:incidentId → statusPage:write",
        "POST /alert-policies → alertPolicy:write",
        "POST /billing/cancel → billing:manage",
        "POST /billing/checkout → billing:manage",
        "POST /billing/credits → billing:manage",
        "POST /billing/pause → billing:manage",
        "POST /billing/plan → billing:manage",
        "POST /billing/portal → billing:manage",
        "POST /billing/resume → billing:manage",
        "POST /channels → channel:manage",
        "POST /channels/:channelId/telegram-link → channel:manage",
        "POST /channels/:channelId/test → channel:manage",
        "POST /deploy-hook → deploy:manage",
        "POST /escalation-policies → schedule:write",
        "POST /expiry/:monitorId/check → monitor:write",
        "POST /heartbeats/:monitorId/token → monitor:write",
        "POST /imports → settings:update",
        "POST /imports/dry-run → settings:update",
        "POST /inbound-sources → channel:manage",
        "POST /inbound-sources/:sourceId/rotate → channel:manage",
        "POST /inbound-sources/:sourceId/test → channel:manage",
        "POST /incidents → incident:write",
        "POST /incidents/:incidentId/escalate → incident:respond",
        "POST /incidents/:incidentRef/acknowledge → incident:respond",
        "POST /incidents/:incidentRef/comments → incident:respond",
        "POST /incidents/:incidentRef/false-alarm → incident:write",
        "POST /incidents/:incidentRef/resolve → incident:respond",
        "POST /incidents/drill → incident:drill",
        "POST /maintenance-windows → maintenance:write",
        "POST /me/chat-links → contact:manage",
        "POST /me/contact-methods → contact:manage",
        "POST /me/contact-methods/:methodId/code → contact:manage",
        "POST /me/contact-methods/:methodId/confirm → contact:manage",
        "POST /me/oncall-feed → contact:manage",
        "POST /monitor-groups → monitor:write",
        "POST /monitors → monitor:write",
        "POST /monitors/:monitorId/pause → monitor:write",
        "POST /monitors/:monitorId/resume → monitor:write",
        "POST /monitors/:monitorId/test → monitor:write",
        "POST /phone-numbers/codes → channel:manage",
        "POST /phone-numbers/confirm → channel:manage",
        "POST /schedules → schedule:write",
        "POST /schedules/:scheduleId/overrides → schedule:override",
        "POST /status-pages → statusPage:write",
        "POST /status-pages/:pageId/domain/verify → statusPage:write",
        "POST /status-pages/:pageId/incidents → statusPage:write",
        "POST /status-pages/:pageId/incidents/:incidentId/updates → statusPage:write",
        "PUT /ai/generations/:generationId/feedback → incident:respond",
        "PUT /alert-policies/default/channels/:channelId → alertPolicy:write",
        "PUT /alert-policies/default/escalation → alertPolicy:write",
        "PUT /me/notification-rules/:urgency → contact:manage",
        "PUT /status-pages/:pageId/components → statusPage:write",
        "PUT /status-pages/:pageId/domain → statusPage:write",
      ]
    `);
  });
});
