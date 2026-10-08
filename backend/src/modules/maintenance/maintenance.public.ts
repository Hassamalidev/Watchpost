/* Maintenance windows in the public API (/api/v1): list, create, delete. */
import { z } from "zod";
import {
  v1MaintenanceListSchema,
  v1MaintenanceWindowSchema,
  type MaintenanceWindowView,
  type V1MaintenanceWindow,
} from "@app/shared";
import { publicRoute, type PublicRoute } from "../../core/public-api.js";
import type { MaintenanceService } from "./maintenance.service.js";
import { createWindowBody, windowIdParams } from "./validators/index.js";

const toV1 = (w: MaintenanceWindowView): V1MaintenanceWindow => ({
  id: w.id,
  name: w.name,
  startsAt: w.startsAt,
  endsAt: w.endsAt,
  timezone: w.timezone,
  rrule: w.rrule,
  scope: w.scope,
  suppressAlerts: w.suppressAlerts,
  showOnPages: w.showOnPages,
  active: w.active,
  nextStart: w.nextStart,
});

export function maintenancePublicRoutes(service: MaintenanceService): PublicRoute[] {
  const tag = "Maintenance";
  return [
    publicRoute({
      method: "get",
      path: "/maintenance-windows",
      scope: "maintenance:read",
      tag,
      summary: "List maintenance windows",
      tool: {
        name: "list_maintenance_windows",
        description:
          "List maintenance windows: planned periods in which the listed monitors don't alert. `active` says which are in effect now.",
      },
      status: 200,
      response: v1MaintenanceListSchema,
      handle: async ({ scope }) => ({ data: (await service.list(scope)).map(toV1) }),
    }),
    publicRoute({
      method: "post",
      path: "/maintenance-windows",
      scope: "maintenance:write",
      tag,
      summary: "Create a maintenance window",
      tool: {
        name: "create_maintenance_window",
        description:
          'Create a maintenance window so the given monitors (or all, with `scope: {"all": true}`) don\'t alert between `startsAt` and `endsAt` (ISO 8601, at most 30 days). Use it for planned work the person names, such as a deploy. `rrule` repeats it.',
      },
      description:
        "While a window is in effect its monitors don't alert (unless `suppressAlerts` is false) and the time doesn't count as downtime. Use it around a deploy: create the window, deploy, delete the window.",
      body: createWindowBody,
      status: 201,
      response: v1MaintenanceWindowSchema,
      handle: async ({ scope, body }) => toV1(await service.create(scope, body)),
    }),
    publicRoute({
      method: "delete",
      path: "/maintenance-windows/:windowId",
      scope: "maintenance:write",
      tag,
      summary: "Delete a maintenance window",
      description: "Deleting a window that is in effect ends it now.",
      params: windowIdParams,
      status: 204,
      handle: async ({ scope, params }) => {
        await service.delete(scope, params.windowId);
        return z.undefined().parse(undefined);
      },
    }),
  ];
}
