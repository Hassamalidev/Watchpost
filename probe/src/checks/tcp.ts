/*
 * TCP port check (PRODUCT.md §6.1): connect (optionally over TLS), optionally send a payload and
 * wait for an expected substring in the reply.
 */
import type { MonitorConfig } from "@app/shared";
import { failure, type CheckContext, type CheckOutcome } from "../executor/executor.js";
import { connectVetted } from "../net/connect.js";
import { CheckError } from "../net/errors.js";

function readUntil(
  socket: NodeJS.ReadWriteStream & { destroy(): void },
  expect: string,
  deadline: number,
) {
  return new Promise<{ matched: boolean; received: string }>((resolve) => {
    let received = "";
    const done = (matched: boolean) => {
      clearTimeout(timer);
      socket.removeAllListeners("data");
      resolve({ matched, received: received.slice(0, 200) });
    };
    const timer = setTimeout(() => done(false), Math.max(1, deadline - Date.now()));
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString("utf8");
      if (received.includes(expect)) done(true);
      if (received.length > 65_536) done(false);
    });
    socket.once("end", () => done(received.includes(expect)));
    socket.once("error", () => done(false));
  });
}

export async function runTcp(config: MonitorConfig, ctx: CheckContext): Promise<CheckOutcome> {
  if (config.type !== "tcp") throw new Error("runTcp got a non-TCP config");
  const started = performance.now();
  const deadline = Date.now() + ctx.timeoutMs;
  let conn;
  try {
    conn = await connectVetted({
      host: config.host,
      port: config.port,
      policy: ctx.policy,
      timeoutMs: ctx.timeoutMs,
      ...(config.tls ? { tls: { rejectUnauthorized: true, ca: ctx.ca } } : {}),
    });
  } catch (err) {
    if (err instanceof CheckError)
      return failure(err.code, err.message, Math.round(performance.now() - started));
    throw err;
  }
  try {
    if (config.send !== undefined) conn.socket.write(config.send);
    if (config.expect !== undefined) {
      const { matched, received } = await readUntil(conn.socket, config.expect, deadline);
      if (!matched) {
        return {
          ...failure("tcp_expect_failed", `expected "${config.expect}", got "${received}"`),
          latencyMs: Math.round(performance.now() - started),
          ip: conn.ip,
        };
      }
    }
    const total = Math.round(performance.now() - started);
    return {
      ok: true,
      latencyMs: total,
      ip: conn.ip,
      timings: { ...conn.timings, total },
      ...(conn.tls ? { tls: conn.tls } : {}),
    };
  } finally {
    conn.socket.destroy();
  }
}
