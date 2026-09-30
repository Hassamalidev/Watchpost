/*
 * SSL certificate check (PRODUCT.md §6.1, §9.8): a verified TLS handshake that reports the certificate
 * facts. Expiry warnings at 30/14/7/3/1 days are raised by the API's daily sweep (P1-T15); the probe
 * fails only when the certificate is invalid now.
 */
import type { MonitorConfig } from "@app/shared";
import { failure, type CheckContext, type CheckOutcome } from "../executor/executor.js";
import { connectVetted } from "../net/connect.js";
import { CheckError } from "../net/errors.js";

export async function runSsl(config: MonitorConfig, ctx: CheckContext): Promise<CheckOutcome> {
  if (config.type !== "ssl") throw new Error("runSsl got a non-SSL config");
  const started = performance.now();
  try {
    const conn = await connectVetted({
      host: config.host,
      port: config.port,
      policy: ctx.policy,
      timeoutMs: ctx.timeoutMs,
      tls: { rejectUnauthorized: true, ca: ctx.ca },
    });
    conn.socket.destroy();
    const total = Math.round(performance.now() - started);
    const outcome: CheckOutcome = {
      ok: true,
      latencyMs: total,
      ip: conn.ip,
      timings: { ...conn.timings, total },
      ...(conn.tls ? { tls: conn.tls } : {}),
    };
    if (conn.tls && conn.tls.daysRemaining < 0) {
      return {
        ...outcome,
        ok: false,
        errorCode: "tls_cert_expired",
        message: `expired on ${conn.tls.validTo}`,
      };
    }
    return outcome;
  } catch (err) {
    if (err instanceof CheckError)
      return failure(err.code, err.message, Math.round(performance.now() - started));
    throw err;
  }
}
