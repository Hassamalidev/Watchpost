/*
 * Inbound alert routes (PRODUCT.md §6.8, §7.1 token URLs).
 * - /api/w/:workspaceId/inbound-sources: everyone but billing sees the sources; admins manage them
 *   and try payloads (they are integrations).
 * - /api/inbound/:token (and /:token/email): no session; the token in the URL is the credential,
 *   stored hashed. Rate limited per IP against guessing and per token against a runaway sender.
 */
import express, { Router, type RequestHandler } from "express";
import { z } from "zod";
import { createInboundSourceSchema, testInboundPayloadSchema } from "@app/shared";
import type { RedisClient } from "../../infra/redis.js";
import { createRateLimiter } from "../../middleware/rate-limit.js";
import { requirePermission } from "../../middleware/roles.js";
import { inputOf, validate } from "../../middleware/validate.js";
import { scopeOf } from "../../middleware/workspace.js";
import type { InboundService } from "./inbound.service.js";

const sourceParams = z.object({ sourceId: z.uuid() });
const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

export function createInboundRouter(
  service: InboundService,
  guards: { session: RequestHandler; workspace: RequestHandler },
): Router {
  const router = Router({ mergeParams: true });
  const read = requirePermission("channel:read");
  const manage = requirePermission("channel:manage");
  const id = validate({ params: sourceParams });
  router.use("/inbound-sources", guards.session, guards.workspace);

  router.get("/inbound-sources", read, async (req, res) => {
    res.json({ data: await service.list(scopeOf(req, res)) });
  });
  router.post(
    "/inbound-sources",
    manage,
    validate({ body: createInboundSourceSchema }),
    async (req, res) => {
      const { body } = inputOf<{ body: typeof createInboundSourceSchema }>(req, res);
      res.status(201).json(await service.create(scopeOf(req, res), body));
    },
  );
  router.post("/inbound-sources/:sourceId/rotate", manage, id, async (req, res) => {
    const { params } = inputOf<{ params: typeof sourceParams }>(req, res);
    res.json(await service.rotate(scopeOf(req, res), params.sourceId));
  });
  router.post(
    "/inbound-sources/:sourceId/test",
    manage,
    validate({ params: sourceParams, body: testInboundPayloadSchema }),
    async (req, res) => {
      const { params, body } = inputOf<{
        params: typeof sourceParams;
        body: typeof testInboundPayloadSchema;
      }>(req, res);
      res.json({ data: await service.preview(scopeOf(req, res), params.sourceId, body.payload) });
    },
  );
  router.delete("/inbound-sources/:sourceId", manage, id, async (req, res) => {
    const { params } = inputOf<{ params: typeof sourceParams }>(req, res);
    await service.delete(scopeOf(req, res), params.sourceId);
    res.status(204).end();
  });
  return router;
}

/* Raw-body router mounted at /api/inbound (before the JSON parser, with its own limits). */
export function createInboundIngestRouter(service: InboundService, redis: RedisClient): Router {
  const router = Router();
  router.use(createRateLimiter({ redis, name: "inbound-ip", windowMs: 60_000, limit: 300 }));
  router.use(
    "/:token",
    createRateLimiter({
      redis,
      name: "inbound-token",
      windowMs: 60_000,
      limit: 120,
      keyOf: (req) => String(req.params.token ?? ""),
    }),
  );
  const handle: RequestHandler = async (req, res) => {
    const token = String(req.params.token);
    const result = TOKEN.test(token) ? await service.ingest(token, req.body) : undefined;
    if (result === undefined) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.status(202).json(result);
  };
  /* Alertmanager groups can be large; anything bigger than this isn't an alert. */
  const json = express.json({ limit: "512kb", type: () => true });
  router.post("/:token", json, handle);
  router.post("/:token/email", json, handle);
  return router;
}
