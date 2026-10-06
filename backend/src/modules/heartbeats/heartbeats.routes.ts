/*
 * Heartbeat routes. Workspace API: the heartbeat's state and ping log (viewers and above) and a new
 * ping URL (members and above). Ping ingest `/api/hb/:token` (also served on `hb.<domain>/<token>`):
 * GET, POST or HEAD, with `/start`, `/fail` or `/<exit code 0-255>`; the body is optional and its
 * first 10 KB are kept as a log excerpt.
 */
import express, { Router, type RequestHandler } from "express";
import { z } from "zod";
import { requireRole } from "../../middleware/roles.js";
import { inputOf, validate } from "../../middleware/validate.js";
import { scopeOf } from "../../middleware/workspace.js";
import type { HeartbeatsService, PingSignal } from "./heartbeats.service.js";

const monitorParams = z.object({ monitorId: z.uuid() });
const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

export function createHeartbeatsRouter(
  service: HeartbeatsService,
  guards: { session: RequestHandler; workspace: RequestHandler },
): Router {
  const router = Router({ mergeParams: true });
  router.use("/heartbeats", guards.session, guards.workspace);

  router.get("/heartbeats", requireRole("viewer"), async (req, res) => {
    res.json({ data: await service.list(scopeOf(req, res)) });
  });
  router.get(
    "/heartbeats/:monitorId",
    requireRole("viewer"),
    validate({ params: monitorParams }),
    async (req, res) => {
      const { params } = inputOf<{ params: typeof monitorParams }>(req, res);
      res.json(await service.get(scopeOf(req, res), params.monitorId));
    },
  );
  router.post(
    "/heartbeats/:monitorId/token",
    requireRole("member"),
    validate({ params: monitorParams }),
    async (req, res) => {
      const { params } = inputOf<{ params: typeof monitorParams }>(req, res);
      res.status(201).json(await service.rotateToken(scopeOf(req, res), params.monitorId));
    },
  );
  return router;
}

export function signalOf(suffix: string | undefined): PingSignal | undefined {
  if (suffix === undefined || suffix === "") return { kind: "success" };
  if (suffix === "start") return { kind: "start" };
  if (suffix === "fail") return { kind: "fail" };
  if (/^\d{1,3}$/.test(suffix)) {
    const code = Number(suffix);
    if (code > 255) return undefined;
    return code === 0 ? { kind: "success", exitCode: 0 } : { kind: "fail", exitCode: code };
  }
  return undefined;
}

/* Raw-body router mounted at /api/hb (before the JSON parser). */
export function createPingRouter(service: HeartbeatsService): Router {
  const router = Router();
  router.use(express.text({ type: () => true, limit: "100kb" }));
  router.all(["/:token", "/:token/:signal"], async (req, res) => {
    if (!["GET", "POST", "HEAD", "PUT"].includes(req.method)) {
      res.status(405).type("text/plain").send("Method not allowed\n");
      return;
    }
    const token = String(req.params.token);
    const signal = signalOf(req.params.signal as string | undefined);
    if (!TOKEN.test(token) || signal === undefined) {
      res.status(404).type("text/plain").send("Not found\n");
      return;
    }
    const body = typeof req.body === "string" ? req.body : undefined;
    const outcome = await service.ping(token, signal, body);
    if (outcome === "not_found") {
      res.status(404).type("text/plain").send("Not found\n");
      return;
    }
    res.status(200).type("text/plain").send("OK\n");
  });
  return router;
}
