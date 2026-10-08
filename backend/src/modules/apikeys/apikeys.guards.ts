/*
 * What stands in front of every `/api/v1` route (PRODUCT.md §7.9 steps 5 to 7): the key, the rate
 * limit per key, the scope, and idempotency for writes. The container mounts these; modules only
 * describe their routes.
 */
import { createHash } from "node:crypto";
import type { RequestHandler } from "express";
import { API_RATE_LIMIT_PER_MINUTE, isWriteScope, scopeAllows, type ApiScope } from "@app/shared";
import type { PublicApiGuards } from "../../composition/types.js";
import {
  ConflictError,
  ForbiddenError,
  QuotaExceededError,
  UnauthorizedError,
  ValidationError,
} from "../../core/errors.js";
import type { RedisClient } from "../../infra/redis.js";
import "../../middleware/context.js";
import { createRateLimiter } from "../../middleware/rate-limit.js";
import { WRITE_NEEDS_PLAN, type ApikeysService } from "./apikeys.service.js";

const BEARER = /^Bearer\s+(\S+)$/i;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,200}$/;

export function createApiKeyGuards(deps: {
  service: ApikeysService;
  redis: RedisClient;
  /* Requests per key and minute; tests lower it. */
  limitPerMinute?: number | undefined;
}): PublicApiGuards {
  const { service } = deps;

  const authenticate: RequestHandler = async (req, res, next) => {
    const presented = BEARER.exec(req.headers.authorization ?? "")?.[1];
    const found = presented === undefined ? undefined : await service.authenticate(presented);
    if (found === undefined) {
      res.set("www-authenticate", "Bearer");
      next(
        new UnauthorizedError(
          "Send a valid API key: `Authorization: Bearer <key>`. Keys are made in Settings → API keys.",
        ),
      );
      return;
    }
    res.locals.scope = found.scope;
    res.locals.apiKey = {
      id: found.key.id,
      name: found.key.name,
      scopes: found.key.scopes,
      expiresAt: found.key.expiresAt,
    };
    next();
  };

  const rateLimit = createRateLimiter({
    redis: deps.redis,
    name: "api-key",
    windowMs: 60_000,
    limit: deps.limitPerMinute ?? API_RATE_LIMIT_PER_MINUTE,
    keyOf: (_req, res) => res.locals.apiKey?.id ?? "none",
  });

  function requireScope(needed: ApiScope): RequestHandler {
    return async (_req, res, next) => {
      const key = res.locals.apiKey;
      const scope = res.locals.scope;
      if (key === undefined || scope === undefined) {
        next(new UnauthorizedError());
        return;
      }
      if (!scopeAllows(key.scopes, needed)) {
        next(new ForbiddenError(`This key doesn't have the \`${needed}\` scope.`));
        return;
      }
      /* The plan is asked now, not when the key was made: it may have changed since. */
      if (isWriteScope(needed) && !(await service.hasFeature(scope, "apiWrite"))) {
        next(new QuotaExceededError(WRITE_NEEDS_PLAN));
        return;
      }
      next();
    };
  }

  const idempotent: RequestHandler = async (req, res, next) => {
    const header = req.headers["idempotency-key"];
    const scope = res.locals.scope;
    if (header === undefined || req.method === "GET" || scope === undefined) {
      next();
      return;
    }
    if (typeof header !== "string" || !IDEMPOTENCY_KEY.test(header)) {
      next(
        new ValidationError("The Idempotency-Key header is invalid.", [
          { path: "headers.idempotency-key", message: "1 to 200 visible ASCII characters" },
        ]),
      );
      return;
    }
    const fingerprint = createHash("sha256")
      .update(`${req.method} ${req.originalUrl}\n${JSON.stringify(req.body ?? null)}`)
      .digest("hex");
    const start = await service.startIdempotent(scope, header, fingerprint);
    if (start.state === "mismatch") {
      next(new ConflictError("This Idempotency-Key was already used with a different request."));
      return;
    }
    if (start.state === "in_progress") {
      next(new ConflictError("A request with this Idempotency-Key is still being handled."));
      return;
    }
    if (start.state === "replay") {
      res.set("idempotency-replayed", "true").status(start.status);
      if (start.response === null) res.end();
      else res.json(start.response);
      return;
    }
    /*
     * Remember the answer when it is sent. A success is kept; an error frees the key, because a
     * request that was refused changed nothing and may be sent again once it is fixed.
     */
    let body: unknown = null;
    const json = res.json.bind(res);
    res.json = (value: unknown) => {
      body = value;
      return json(value);
    };
    res.on("finish", () => {
      const ok = res.statusCode >= 200 && res.statusCode < 300;
      void service
        .finishIdempotent(
          scope,
          header,
          ok ? { status: res.statusCode, response: body } : undefined,
        )
        .catch(() => {});
    });
    next();
  };

  return { authenticate, rateLimit, requireScope, idempotent };
}
