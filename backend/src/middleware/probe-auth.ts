/*
 * Probe request authentication (PRODUCT.md §7.6): verifies X-Probe-Id / -Timestamp / -Signature over
 * the exact raw body before anything is parsed, rejects requests more than 60 s off, then parses JSON.
 * The secret lookup comes from the probes module through the container.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import express, { type RequestHandler } from "express";
import { PROBE_HEADERS, PROBE_MAX_CLOCK_SKEW_SECONDS, probeSigningString } from "@app/shared";
import { UnauthorizedError, ValidationError } from "../core/errors.js";
import "./context.js";

export interface AuthenticatedProbe {
  id: string;
  region: string;
  kind: "managed" | "private";
  workspaceId: string | null;
}

export type LookupProbe = (
  probeId: string,
) => Promise<{ probe: AuthenticatedProbe; secret: string } | undefined>;

declare module "express-serve-static-core" {
  interface Locals {
    probe?: AuthenticatedProbe;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REJECTED = "Probe authentication failed.";

export function verifySignature(input: {
  secret: string;
  timestamp: string;
  method: string;
  path: string;
  body: Buffer;
  signature: string;
}): boolean {
  const expected = createHmac("sha256", input.secret)
    .update(
      probeSigningString({
        timestamp: input.timestamp,
        method: input.method,
        path: input.path,
        bodySha256Hex: createHash("sha256").update(input.body).digest("hex"),
      }),
    )
    .digest();
  const given = Buffer.from(input.signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function probeAuth(options: {
  lookup: LookupProbe;
  now?: () => number;
  maxBodyBytes?: number;
}): RequestHandler[] {
  const now = options.now ?? Date.now;
  const raw = express.raw({ type: () => true, limit: options.maxBodyBytes ?? 2_000_000 });

  const verify: RequestHandler = async (req, res, next) => {
    const probeId = req.header(PROBE_HEADERS.id) ?? "";
    const timestamp = req.header(PROBE_HEADERS.timestamp) ?? "";
    const signature = req.header(PROBE_HEADERS.signature) ?? "";
    if (
      !UUID.test(probeId) ||
      !/^\d{1,12}$/.test(timestamp) ||
      !/^[0-9a-f]{64}$/i.test(signature)
    ) {
      next(new UnauthorizedError(REJECTED));
      return;
    }
    if (Math.abs(now() / 1_000 - Number(timestamp)) > PROBE_MAX_CLOCK_SKEW_SECONDS) {
      next(new UnauthorizedError("Probe clock is more than 60 s off; check NTP."));
      return;
    }
    const found = await options.lookup(probeId.toLowerCase());
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const path = req.originalUrl.split("?")[0] ?? "";
    if (
      found === undefined ||
      !verifySignature({
        secret: found.secret,
        timestamp,
        method: req.method,
        path,
        body,
        signature,
      })
    ) {
      next(new UnauthorizedError(REJECTED));
      return;
    }
    res.locals.probe = found.probe;
    if (body.length === 0) {
      req.body = {};
    } else {
      try {
        req.body = JSON.parse(body.toString("utf8"));
      } catch {
        next(new ValidationError("The request body is not valid JSON."));
        return;
      }
    }
    next();
  };

  return [raw, verify];
}

export function probeOf(res: { locals: { probe?: AuthenticatedProbe } }): AuthenticatedProbe {
  const probe = res.locals.probe;
  if (probe === undefined) throw new UnauthorizedError(REJECTED);
  return probe;
}
