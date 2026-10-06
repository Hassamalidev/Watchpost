/*
 * Deploy routes. Workspace API: the deploy log (viewers and above) and the deploy URL (admins create
 * or rotate it; it is shown once). Token URL `/api/deploys/:token` takes a JSON deploy from CI;
 * `/api/deploys/:token/github` takes GitHub `deployment_status` webhooks (signature checked against the
 * raw body).
 */
import express, { Router, type RequestHandler } from "express";
import type { RedisClient } from "../../infra/redis.js";
import { createRateLimiter } from "../../middleware/rate-limit.js";
import { requireRole } from "../../middleware/roles.js";
import { inputOf, validate } from "../../middleware/validate.js";
import { scopeOf } from "../../middleware/workspace.js";
import type { DeploysService } from "./deploys.service.js";
import { listDeploysQuery, recordDeployBody } from "./validators/index.js";

const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

export function createDeploysRouter(
  service: DeploysService,
  guards: { session: RequestHandler; workspace: RequestHandler },
): Router {
  const router = Router({ mergeParams: true });
  router.use(["/deploys", "/deploy-hook"], guards.session, guards.workspace);

  router.get(
    "/deploys",
    requireRole("viewer"),
    validate({ query: listDeploysQuery }),
    async (req, res) => {
      const { query } = inputOf<{ query: typeof listDeploysQuery }>(req, res);
      const to = query.before ? new Date(query.before) : new Date();
      const from = new Date(to.getTime() - query.hours * 3_600_000);
      res.json({ data: await service.list(scopeOf(req, res), from, to) });
    },
  );
  router.get("/deploy-hook", requireRole("viewer"), async (req, res) => {
    res.json(await service.hook(scopeOf(req, res)));
  });
  router.post("/deploy-hook", requireRole("admin"), async (req, res) => {
    res.status(201).json(await service.rotateHook(scopeOf(req, res)));
  });
  return router;
}

/*
 * Raw-body router mounted at /api/deploys (before the JSON parser, so before the global per-IP limit).
 * Its own limits: per IP against token guessing, per token against a leaked URL flooding the log.
 */
export function createDeployIngestRouter(service: DeploysService, redis: RedisClient): Router {
  const router = Router();
  router.use(createRateLimiter({ redis, name: "deploys-ip", windowMs: 60_000, limit: 120 }));
  router.use(
    "/:token",
    createRateLimiter({
      redis,
      name: "deploys-token",
      windowMs: 60_000,
      limit: 30,
      keyOf: (req) => String(req.params.token ?? ""),
    }),
  );
  const notFound = (res: express.Response) => res.status(404).json({ error: "not_found" });

  router.post(
    "/:token/github",
    express.raw({ type: () => true, limit: "1mb" }),
    async (req, res) => {
      const token = String(req.params.token);
      if (!TOKEN.test(token)) return notFound(res);
      const outcome = await service.recordGithub(
        token,
        req.get("x-github-event"),
        req.get("x-hub-signature-256"),
        Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
      );
      if (outcome === "not_found") return notFound(res);
      if (outcome === "bad_signature") {
        return res.status(401).json({ error: "bad_signature" });
      }
      return res.status(outcome === "recorded" ? 201 : 202).json({ outcome });
    },
  );

  router.post(
    "/:token",
    express.json({ limit: "16kb" }),
    validate({ body: recordDeployBody }),
    async (req, res) => {
      const token = String(req.params.token);
      if (!TOKEN.test(token)) return notFound(res);
      const { body } = inputOf<{ body: typeof recordDeployBody }>(req, res);
      const outcome = await service.record(token, {
        version: body.version,
        service: body.service,
        environment: body.environment,
        url: body.url,
        description: body.description,
        at: body.at ? new Date(body.at) : undefined,
      });
      if (outcome === "not_found") return notFound(res);
      return res.status(201).json({ outcome });
    },
  );
  return router;
}
