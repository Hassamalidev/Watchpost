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
      description: `${ref} An incident opened by a monitor opens again if the monitor still fails.`,
      params: incidentRefParams,
      status: 200,
      response: v1IncidentSchema,
      handle: async ({ scope, params }) =>
        toV1(await service.resolve(scope, params.incidentRef, { via: "api" })),
    }),
  ];
}
