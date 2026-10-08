/*
 * The integration request log (PRODUCT.md §21.2): a member looked for an integration we don't have
 * and said so. One line per wish; a workspace can add 20 a day, which is plenty for people and
 * useless for a script. Nothing is promised and nobody is notified: the table is read when the next
 * integrations are chosen (`select name, count(distinct workspace_id) … group by name`).
 */
import { and, eq, gte, sql } from "drizzle-orm";
import { Router, type RequestHandler } from "express";
import { z } from "zod";
import type { Clock } from "../../core/clock.js";
import { RateLimitedError } from "../../core/errors.js";
import type { DbOrTx } from "../../infra/db/index.js";
import { requirePermission } from "../../middleware/roles.js";
import { inputOf, validate } from "../../middleware/validate.js";
import { scopeOf } from "../../middleware/workspace.js";
import { integrationRequests } from "./schema/channels.js";

const PER_WORKSPACE_PER_DAY = 20;

export const integrationRequestBody = z
  .object({
    name: z
      .string()
      .trim()
      .min(2)
      .max(80)
      .transform((name) => name.toLowerCase().replace(/\s+/g, " ")),
  })
  .strict();

export function createIntegrationRequestsRouter(
  deps: { db: DbOrTx; clock: Clock; newId: () => string },
  guards: { session: RequestHandler; workspace: RequestHandler },
): Router {
  const router = Router({ mergeParams: true });
  router.post(
    "/integration-requests",
    guards.session,
    guards.workspace,
    requirePermission("channel:read"),
    validate({ body: integrationRequestBody }),
    async (req, res) => {
      const scope = scopeOf(req, res);
      const { body } = inputOf<{ body: typeof integrationRequestBody }>(req, res);
      const since = new Date(deps.clock.now().getTime() - 86_400_000);
      const recent = await deps.db
        .select({
          n: sql<number>`count(*)::int`,
          same: sql<number>`(count(*) filter (where ${integrationRequests.name} = ${body.name}))::int`,
        })
        .from(integrationRequests)
        .where(
          and(
            eq(integrationRequests.workspaceId, scope.workspaceId),
            gte(integrationRequests.createdAt, since),
          ),
        );
      /* Asking for the same thing again today is fine and adds nothing. */
      if ((recent[0]?.same ?? 0) === 0) {
        if ((recent[0]?.n ?? 0) >= PER_WORKSPACE_PER_DAY) {
          throw new RateLimitedError("That is enough requests for today. Thank you.");
        }
        await deps.db.insert(integrationRequests).values({
          id: deps.newId(),
          workspaceId: scope.workspaceId,
          userId: scope.actorUserId ?? null,
          name: body.name,
          createdAt: deps.clock.now(),
        });
      }
      res.status(202).json({ recorded: true });
    },
  );
  return router;
}
