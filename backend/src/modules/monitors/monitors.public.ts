/* Monitors in the public API (/api/v1). The answers are v1's own shape, not the web app's view. */
import { z } from "zod";
import { v1MonitorPageSchema, v1MonitorSchema, type V1Monitor } from "@app/shared";
import { publicRoute, type PublicRoute } from "../../core/public-api.js";
import type { MonitorView, MonitorsService } from "./monitors.service.js";
import {
  createMonitorBody,
  listMonitorsQuery,
  monitorIdParams,
  updateMonitorBody,
} from "./validators/index.js";

const toV1 = (m: MonitorView): V1Monitor => ({
  id: m.id,
  name: m.name,
  type: m.type,
  config: m.config as Record<string, unknown>,
  intervalSeconds: m.intervalSeconds,
  timeoutMs: m.timeoutMs,
  regions: m.regions,
  tags: m.tags,
  groupId: m.groupId,
  severity: m.severity,
  paused: m.paused,
  createdAt: m.createdAt,
  updatedAt: m.updatedAt,
});

export function monitorsPublicRoutes(service: MonitorsService): PublicRoute[] {
  const tag = "Monitors";
  return [
    publicRoute({
      method: "get",
      path: "/monitors",
      scope: "monitors:read",
      tag,
      summary: "List monitors",
      query: listMonitorsQuery,
      status: 200,
      response: v1MonitorPageSchema,
      handle: async ({ scope, query }) => {
        const page = await service.list(scope, query);
        return { data: page.data.map(toV1), nextCursor: page.nextCursor };
      },
    }),
    publicRoute({
      method: "post",
      path: "/monitors",
      scope: "monitors:write",
      tag,
      summary: "Create a monitor",
      description:
        "`config.type` picks the kind of check and the other `config` fields; `settings` holds the name, interval, regions and alerting options.",
      body: createMonitorBody,
      status: 201,
      response: v1MonitorSchema,
      handle: async ({ scope, body }) => toV1(await service.create(scope, body)),
    }),
    publicRoute({
      method: "get",
      path: "/monitors/:monitorId",
      scope: "monitors:read",
      tag,
      summary: "Get a monitor",
      params: monitorIdParams,
      status: 200,
      response: v1MonitorSchema,
      handle: async ({ scope, params }) => toV1(await service.get(scope, params.monitorId)),
    }),
    publicRoute({
      method: "patch",
      path: "/monitors/:monitorId",
      scope: "monitors:write",
      tag,
      summary: "Change a monitor",
      description:
        "Send only what changes. `settings` is merged with what is stored; `config` replaces the fields you send and can't change the monitor's type.",
      params: monitorIdParams,
      body: updateMonitorBody,
      status: 200,
      response: v1MonitorSchema,
      handle: async ({ scope, params, body }) =>
        toV1(await service.update(scope, params.monitorId, body)),
    }),
    publicRoute({
      method: "post",
      path: "/monitors/:monitorId/pause",
      scope: "monitors:write",
      tag,
      summary: "Pause a monitor",
      params: monitorIdParams,
      status: 200,
      response: v1MonitorSchema,
      handle: async ({ scope, params }) =>
        toV1(await service.setPaused(scope, params.monitorId, true)),
    }),
    publicRoute({
      method: "post",
      path: "/monitors/:monitorId/resume",
      scope: "monitors:write",
      tag,
      summary: "Resume a paused monitor",
      params: monitorIdParams,
      status: 200,
      response: v1MonitorSchema,
      handle: async ({ scope, params }) =>
        toV1(await service.setPaused(scope, params.monitorId, false)),
    }),
    publicRoute({
      method: "delete",
      path: "/monitors/:monitorId",
      scope: "monitors:write",
      tag,
      summary: "Delete a monitor",
      params: monitorIdParams,
      status: 204,
      handle: async ({ scope, params }) => {
        await service.delete(scope, params.monitorId);
        return z.undefined().parse(undefined);
      },
    }),
  ];
}
