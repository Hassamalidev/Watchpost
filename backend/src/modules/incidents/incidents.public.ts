/* Incidents in the public API (/api/v1): read them, acknowledge and resolve them. */
import { v1IncidentPageSchema, v1IncidentSchema, type V1Incident } from "@app/shared";
import { publicRoute, type PublicRoute } from "../../core/public-api.js";
import type { IncidentView, IncidentsService } from "./incidents.service.js";
import { incidentRefParams, listIncidentsQuery } from "./validators/index.js";

const toV1 = (i: IncidentView): V1Incident => ({
  id: i.id,
  number: i.number,
  title: i.title,
  status: i.status,
  severity: i.severity,
  source: i.source,
  monitorId: i.monitorId,
  causeCode: i.causeCode,
  failingRegions: i.failingRegions,
  startedAt: i.startedAt,
  acknowledgedAt: i.acknowledgedAt,
  resolvedAt: i.resolvedAt,
  durationSeconds: i.durationSeconds,
});

export function incidentsPublicRoutes(service: IncidentsService): PublicRoute[] {
  const tag = "Incidents";
  const ref = "`incidentRef` is the incident's ID or its number in the workspace (12 for #12).";
  return [
    publicRoute({
      method: "get",
      path: "/incidents",
      scope: "incidents:read",
      tag,
      summary: "List incidents",
      tool: {
        name: "list_incidents",
        description:
          'List incidents, newest first. `status: "open"` gives everything not resolved, which answers "what is down right now?". Filter by status, severity or `monitorId`. Paged with `cursor`.',
      },
      description: "Newest first. `status=open` means everything that isn't resolved.",
      query: listIncidentsQuery,
      status: 200,
      response: v1IncidentPageSchema,
      handle: async ({ scope, query }) => {
        const page = await service.list(scope, query);
        return { data: page.data.map(toV1), nextCursor: page.nextCursor };
      },
    }),
    publicRoute({
      method: "get",
      path: "/incidents/:incidentRef",
      scope: "incidents:read",
      tag,
      summary: "Get an incident",
      tool: {
        name: "get_incident",
        description:
          "One incident by its number (12 for #12) or ID: title, status, severity, cause code, failing regions, and when it started, was acknowledged and was resolved.",
      },
      description: ref,
      params: incidentRefParams,
      status: 200,
      response: v1IncidentSchema,
      handle: async ({ scope, params }) => toV1(await service.get(scope, params.incidentRef)),
    }),
    publicRoute({
      method: "post",
      path: "/incidents/:incidentRef/acknowledge",
      scope: "incidents:write",
      tag,
      summary: "Acknowledge an incident",
      tool: {
        name: "acknowledge_incident",
        description:
          "Acknowledge an incident: it tells the team someone is on it and stops escalation to further people. Only when the person you are helping asks for it. It does not resolve the incident.",
        idempotent: true,
      },
      description: `${ref} Escalation stops. Acknowledging twice changes nothing.`,
      params: incidentRefParams,
      status: 200,
      response: v1IncidentSchema,
      handle: async ({ scope, params }) =>
        toV1(await service.acknowledge(scope, params.incidentRef, { via: "api" })),
    }),
    publicRoute({
      method: "post",
      path: "/incidents/:incidentRef/resolve",
      scope: "incidents:write",
      tag,
      summary: "Resolve an incident",
      tool: {
        name: "resolve_incident",
        description:
          "Mark an incident as resolved. Only when the person you are helping says it is over. An incident opened by a monitor opens again if the monitor still fails.",
        idempotent: true,
      },
      description: `${ref} An incident opened by a monitor opens again if the monitor still fails.`,
      params: incidentRefParams,
      status: 200,
      response: v1IncidentSchema,
      handle: async ({ scope, params }) =>
        toV1(await service.resolve(scope, params.incidentRef, { via: "api" })),
    }),
  ];
}
