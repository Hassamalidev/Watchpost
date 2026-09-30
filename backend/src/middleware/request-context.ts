/* Request ID (from X-Request-Id or a new UUIDv7) and a request-scoped pino logger. */
import type { RequestHandler } from "express";
import { pinoHttp } from "pino-http";
import type { Logger } from "../infra/logger.js";
import { newId } from "../infra/ids.js";

const REQUEST_ID_HEADER = "x-request-id";
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function requestContext(logger: Logger): RequestHandler {
  return pinoHttp({
    logger,
    genReqId: (req, res) => {
      const incoming = req.headers[REQUEST_ID_HEADER];
      const id =
        typeof incoming === "string" && SAFE_REQUEST_ID.test(incoming) ? incoming : newId();
      res.setHeader("X-Request-Id", id);
      return id;
    },
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return "error";
      if (res.statusCode >= 400) return "warn";
      return "info";
    },
    autoLogging: {
      ignore: (req) => req.url === "/api/health" || req.url === "/api/ready",
    },
  });
}
