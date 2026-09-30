/*
 * Express app factory. The middleware order is part of the architecture contract (PRODUCT.md §7.9):
 * request context → helmet/CORS → raw-body routes → JSON parser → rate limits → auth → routes → errors.
 */
import express, { type Express, type Router } from "express";
import helmet from "helmet";
import cors, { type CorsOptions } from "cors";
import type { AppConfig } from "./config/index.js";
import type { Logger } from "./infra/logger.js";
import type { RedisClient } from "./infra/redis.js";
import { createHealthRouter, type ReadinessCheck } from "./infra/health.js";
import { requestContext } from "./middleware/request-context.js";
import { createRateLimiter } from "./middleware/rate-limit.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";

export const JSON_BODY_LIMIT = "1mb";
export const DEFAULT_IP_RATE_LIMIT = { windowMs: 60_000, limit: 600 };

export interface AppDeps {
  config: Pick<AppConfig, "webOrigin" | "api">;
  logger: Logger;
  redis: RedisClient;
  readinessChecks: Record<string, ReadinessCheck>;
  /* Routers that must see the raw body (webhooks, probe protocol); mounted before express.json(). */
  rawBodyRouters?: Array<{ path: string; router: Router }>;
  /* JSON API routers, mounted after the JSON parser and rate limits. */
  routers?: Array<{ path: string; router: Router }>;
  ipRateLimit?: { windowMs: number; limit: number };
}

const isHealthPath = (path: string) => path === "/health" || path === "/ready";

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", deps.config.api.trustProxy);

  /* 1. Request ID and request-scoped logger */
  app.use(requestContext(deps.logger));

  /* 2. Security headers; CORS limited to the app origin, except the public API */
  app.use(helmet());
  const appCors: CorsOptions = { origin: deps.config.webOrigin, credentials: true };
  const publicCors: CorsOptions = { origin: "*" };
  app.use(cors((req, cb) => cb(null, req.url?.startsWith("/api/public/") ? publicCors : appCors)));

  /* 3. Raw-body routes (Better Auth, webhooks, integrations, probe protocol, token URLs) */
  for (const { path, router } of deps.rawBodyRouters ?? []) app.use(path, router);

  /* 4. JSON parser for everything else */
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  /* Health endpoints stay outside rate limits so monitors and Caddy can always reach them */
  app.use("/api", createHealthRouter(deps.readinessChecks));

  /* 5. Rate limits (per IP here; per key and per workspace are added with their routes) */
  const ipLimit = deps.ipRateLimit ?? DEFAULT_IP_RATE_LIMIT;
  app.use(
    "/api",
    createRateLimiter({ redis: deps.redis, name: "ip", ...ipLimit, skip: isHealthPath }),
  );

  /* 6–8. Authentication, workspace scope, validation and routes arrive with their modules */
  for (const { path, router } of deps.routers ?? []) app.use(path, router);

  /* 9. Errors as problem JSON */
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
