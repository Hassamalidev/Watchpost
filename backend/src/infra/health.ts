/*
 * Liveness (/api/health) and readiness (/api/ready).
 * Readiness runs every registered check with a timeout; later tasks add the platform tick and outbox lag.
 */
import { Router } from "express";

export type ReadinessCheck = () => Promise<void>;

export interface ReadinessResult {
  ready: boolean;
  checks: Record<string, { ok: boolean; error?: string; latencyMs: number }>;
}

export const READINESS_TIMEOUT_MS = 2_000;

function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function runReadinessChecks(
  checks: Record<string, ReadinessCheck>,
  timeoutMs = READINESS_TIMEOUT_MS,
): Promise<ReadinessResult> {
  const entries = await Promise.all(
    Object.entries(checks).map(async ([name, check]) => {
      const started = performance.now();
      try {
        await withTimeout(check(), timeoutMs);
        return [name, { ok: true, latencyMs: Math.round(performance.now() - started) }] as const;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return [
          name,
          { ok: false, error, latencyMs: Math.round(performance.now() - started) },
        ] as const;
      }
    }),
  );
  return { ready: entries.every(([, r]) => r.ok), checks: Object.fromEntries(entries) };
}

export function createHealthRouter(checks: Record<string, ReadinessCheck>): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  router.get("/ready", async (_req, res) => {
    const result = await runReadinessChecks(checks);
    res.status(result.ready ? 200 : 503).json({
      status: result.ready ? "ready" : "not_ready",
      checks: result.checks,
    });
  });

  return router;
}
