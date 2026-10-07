/*
 * Liveness (/api/health) and readiness (/api/ready).
 * Readiness runs every registered check with a timeout: Postgres, Redis, outbox lag and the worker's
 * tick (§13). Warnings are checked the same way but never make the answer "not ready": they are for
 * whoever watches the platform (the sentinel), for example a region without a healthy probe.
 */
import { Router } from "express";

export type ReadinessCheck = () => Promise<void>;

export interface ReadinessResult {
  ready: boolean;
  checks: Record<string, { ok: boolean; error?: string; latencyMs: number }>;
}

export interface ReadinessOptions {
  warnings?: Record<string, ReadinessCheck>;
}

export const READINESS_TIMEOUT_MS = 2_000;

function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/*
 * Turns any thrown value into a useful one-line message. Connection failures to "localhost" surface as
 * an AggregateError with an empty message (one error per address family), so include the inner errors.
 */
export function describeError(err: unknown): string {
  if (err instanceof AggregateError) {
    const inner = err.errors.map(describeError).filter((m) => m !== "");
    const unique = [...new Set(inner)];
    if (unique.length > 0) return unique.join("; ");
  }
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (err.message !== "") return err.message;
    if (code !== undefined) return code;
    return err.name;
  }
  return String(err);
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
        const error = describeError(err);
        return [
          name,
          { ok: false, error, latencyMs: Math.round(performance.now() - started) },
        ] as const;
      }
    }),
  );
  return { ready: entries.every(([, r]) => r.ok), checks: Object.fromEntries(entries) };
}

export function createHealthRouter(
  checks: Record<string, ReadinessCheck>,
  options: ReadinessOptions = {},
): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  router.get("/ready", async (_req, res) => {
    const [result, warnings] = await Promise.all([
      runReadinessChecks(checks),
      runReadinessChecks(options.warnings ?? {}),
    ]);
    res.status(result.ready ? 200 : 503).json({
      status: result.ready ? "ready" : "not_ready",
      checks: result.checks,
      /* What is wrong without the platform being down, by name. Empty when all is well. */
      warnings: Object.fromEntries(
        Object.entries(warnings.checks).flatMap(([name, check]) =>
          check.ok ? [] : [[name, check.error ?? "failing"]],
        ),
      ),
    });
  });

  return router;
}
