/*
 * Ping check (PRODUCT.md §6.1): ICMP through the system `ping` against the vetted address (the probe
 * image has iputils and runs with NET_RAW). No shell is involved; arguments are fixed and the target is
 * an IP literal. Without ICMP permission, falls back to a TCP connect on 443/80 (details.method = "tcp").
 */
import { execFile } from "node:child_process";
import type { MonitorConfig } from "@app/shared";
import { failure, type CheckContext, type CheckOutcome } from "../executor/executor.js";
import { connectVetted } from "../net/connect.js";
import { CheckError } from "../net/errors.js";
import { preferredAddress, resolveVetted } from "../net/resolve.js";

export interface PingStats {
  sent: number;
  received: number;
  lossPercent: number;
  avgMs?: number | undefined;
}

/* Parses Linux (iputils/busybox) and Windows ping output. */
export function parsePingOutput(output: string): PingStats | undefined {
  const linux = /(\d+) packets transmitted, (\d+) (?:packets )?received/.exec(output);
  const win = /Sent = (\d+), Received = (\d+)/.exec(output);
  const counts = linux ?? win;
  if (!counts) return undefined;
  const sent = Number(counts[1]);
  /*
   * Windows counts "Destination host unreachable" answers from a router as received;
   * only real echo replies (with bytes=) count.
   */
  const received = linux
    ? Number(counts[2])
    : (output.match(/^Reply from .*bytes=/gim) ?? []).length;
  const linuxRtt = /= [\d.]+\/([\d.]+)\/[\d.]+/.exec(output);
  const winRtt = /Average = (\d+)ms/.exec(output);
  const avg = linuxRtt?.[1] ?? winRtt?.[1];
  return {
    sent,
    received,
    lossPercent: sent === 0 ? 100 : Math.round(((sent - received) / sent) * 100),
    ...(avg !== undefined ? { avgMs: Number(avg) } : {}),
  };
}

function pingArgs(ip: string, count: number, timeoutMs: number): [string, string[]] {
  const perReplySeconds = Math.max(1, Math.floor(timeoutMs / count / 1_000));
  if (process.platform === "win32") {
    return ["ping", ["-n", String(count), "-w", String(perReplySeconds * 1_000), ip]];
  }
  return [
    "ping",
    [
      "-n",
      "-c",
      String(count),
      "-W",
      String(perReplySeconds),
      ...(ip.includes(":") ? ["-6"] : []),
      ip,
    ],
  ];
}

function execPing(
  ip: string,
  count: number,
  timeoutMs: number,
): Promise<{ output: string; spawnError?: NodeJS.ErrnoException }> {
  const [cmd, args] = pingArgs(ip, count, timeoutMs);
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs + 2_000, windowsHide: true },
      (err, stdout, stderr) => {
        const output = `${stdout}\n${stderr}`;
        const code = (err as NodeJS.ErrnoException | null)?.code;
        /* A non-zero exit just means packets were lost; only spawn/permission failures are errors. */
        if (
          err &&
          (code === "ENOENT" ||
            code === "EACCES" ||
            /Operation not permitted|permission/i.test(output))
        ) {
          resolve({ output, spawnError: err as NodeJS.ErrnoException });
        } else {
          resolve({ output });
        }
      },
    );
  });
}

async function tcpFallback(host: string, ctx: CheckContext): Promise<CheckOutcome> {
  let lastError: CheckError | undefined;
  for (const port of [443, 80]) {
    try {
      const conn = await connectVetted({
        host,
        port,
        policy: ctx.policy,
        timeoutMs: ctx.timeoutMs,
      });
      conn.socket.destroy();
      return {
        ok: true,
        latencyMs: conn.timings.connect,
        ip: conn.ip,
        details: { method: "tcp", port },
      };
    } catch (err) {
      if (!(err instanceof CheckError)) throw err;
      lastError = err;
      if (err.code === "ssrf_blocked") break;
    }
  }
  return failure(lastError?.code ?? "ping_loss", lastError?.message ?? "host unreachable over TCP");
}

export async function runPing(config: MonitorConfig, ctx: CheckContext): Promise<CheckOutcome> {
  if (config.type !== "ping") throw new Error("runPing got a non-ping config");
  let ip: string;
  try {
    const { addresses } = await resolveVetted(config.host, ctx.policy);
    ip = preferredAddress(addresses)?.address ?? "";
  } catch (err) {
    if (err instanceof CheckError) return failure(err.code, err.message);
    throw err;
  }
  const { output, spawnError } = await execPing(ip, config.count, ctx.timeoutMs);
  if (spawnError) return tcpFallback(config.host, ctx);
  const stats = parsePingOutput(output);
  if (stats === undefined) return tcpFallback(config.host, ctx);

  const details = {
    method: "icmp",
    sent: stats.sent,
    received: stats.received,
    lossPercent: stats.lossPercent,
  };
  const latencyMs = Math.round(stats.avgMs ?? 0);
  if (stats.received === 0 || stats.lossPercent > config.maxLossPercent) {
    return {
      ok: false,
      errorCode: "ping_loss",
      message: `${stats.lossPercent}% packet loss (${stats.received}/${stats.sent} replies)`,
      latencyMs,
      ip,
      details,
    };
  }
  return { ok: true, latencyMs, ip, details };
}
