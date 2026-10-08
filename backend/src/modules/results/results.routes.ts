/*
 * Chart reads under /api/w/:workspaceId/monitors/:monitorId (viewers and above): latency series
 * from rollups and the raw checks of the last 48 hours.
 */
import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { checkRegionSchema } from "@app/shared";
import { requirePermission } from "../../middleware/roles.js";
import { inputOf, validate } from "../../middleware/validate.js";
import { scopeOf } from "../../middleware/workspace.js";
import { CHART_RANGES, type ChartRange, type RollupsService } from "./rollups.service.js";

const params = z.object({ monitorId: z.uuid() });
const latencyQuery = z.object({
  range: z.enum(Object.keys(CHART_RANGES) as [ChartRange, ...ChartRange[]]).default("24h"),
  region: checkRegionSchema.optional(),
});
const checksQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  region: checkRegionSchema.optional(),
});

export function createResultsRouter(
  rollups: RollupsService,
  guards: { session: RequestHandler; workspace: RequestHandler },
): Router {
  const router = Router({ mergeParams: true });
  const read = [guards.session, guards.workspace, requirePermission("monitor:read")];

  router.get(
    "/monitors/:monitorId/latency",
    ...read,
    validate({ params, query: latencyQuery }),
    async (req, res) => {
      const input = inputOf<{ params: typeof params; query: typeof latencyQuery }>(req, res);
      res.json(await rollups.latency(scopeOf(req, res), input.params.monitorId, input.query));
    },
  );
  router.get(
    "/monitors/:monitorId/checks",
    ...read,
    validate({ params, query: checksQuery }),
    async (req, res) => {
      const input = inputOf<{ params: typeof params; query: typeof checksQuery }>(req, res);
      res.json({
        data: await rollups.checks(scopeOf(req, res), input.params.monitorId, input.query),
      });
    },
  );
  return router;
}
