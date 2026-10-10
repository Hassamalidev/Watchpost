/*
 * The network path to a target (PRODUCT.md P8-T04). The probe runs the system's own tool:
 * `tracepath` first, which needs no special rights (it is in the probe image), then `traceroute`
 * where that is what the machine has. A probe with neither says so; nothing here opens raw sockets.
 */
import { spawn } from "node:child_process";
import type { Traceroute } from "@app/shared";

type Hop = Traceroute["hops"][number];

export const TRACE_MAX_HOPS = 20;

/*
 * tracepath -n:
 *  1?: [LOCALHOST]                      pmtu 1500
 *  1:  192.0.2.1                                             0.531ms
 *  2:  no reply
 *  9:  203.0.113.34                                         85.300ms reached
 */
export function parseTracepath(output: string): { hops: Hop[]; reached: boolean } {
  const byHop = new Map<number, Hop>();
  let reached = false;
  for (const line of output.split("\n")) {
    const m = /^\s*(\d+)(\?)?:\s+(.*)$/.exec(line);
    if (m === null || m[2] === "?") continue;
    const hop = Number(m[1]);
    const rest = m[3] ?? "";
    if (/^no reply/.test(rest)) {
      if (!byHop.has(hop)) byHop.set(hop, { hop, ip: null, rttMs: null });
      continue;
    }
    const parts = /^(\S+)\s+([\d.]+)ms/.exec(rest);
    if (parts === null) continue;
    byHop.set(hop, { hop, ip: parts[1] ?? null, rttMs: Number(parts[2]) });
    if (/\breached\b/.test(rest)) reached = true;
  }
  return { hops: [...byHop.values()].sort((a, b) => a.hop - b.hop), reached };
}

/*
 * traceroute -n -q 1:
 *  1  192.0.2.1  0.512 ms
 *  2  *
 */
export function parseTraceroute(output: string, target: string): { hops: Hop[]; reached: boolean } {
  const hops: Hop[] = [];
  for (const line of output.split("\n")) {
    const m = /^\s*(\d+)\s+(\S+)(?:\s+([\d.]+)\s*ms)?/.exec(line);
    if (m === null) continue;
    const hop = Number(m[1]);
    if (m[2] === "*") hops.push({ hop, ip: null, rttMs: null });
    else hops.push({ hop, ip: m[2] ?? null, rttMs: m[3] === undefined ? null : Number(m[3]) });
  }
  return { hops, reached: hops.at(-1)?.ip === target };
}

/* A command's output, cut off at the time limit; undefined when the command doesn't exist. */
export type RunCommand = (
  command: string,
  args: string[],
  timeoutMs: number,
) => Promise<string | undefined>;

export const runCommand: RunCommand = (command, args, timeoutMs) =>
  new Promise((resolve) => {
    let output = "";
    let settled = false;
    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(output);
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (output.length < 64_000) output += chunk.toString("utf8");
    });
    child.once("error", (err: NodeJS.ErrnoException) =>
      finish(err.code === "ENOENT" ? undefined : output),
    );
    child.once("close", () => finish(output));
  });

/* The path to an address, or undefined when this machine has no tool to trace one. */
export async function tracePath(
  address: string,
  options: { timeoutMs?: number; run?: RunCommand } = {},
): Promise<Traceroute | undefined> {
  const run = options.run ?? runCommand;
  const timeoutMs = options.timeoutMs ?? 8_000;
  /* The address is one we resolved and vetted ourselves; it is still passed as a single argument. */
  if (!/^[0-9a-fA-F:.]+$/.test(address)) return undefined;
  const hops = String(TRACE_MAX_HOPS);
  const viaTracepath = await run("tracepath", ["-n", "-m", hops, address], timeoutMs);
  if (viaTracepath !== undefined) {
    return { tool: "tracepath", ...limit(parseTracepath(viaTracepath)) };
  }
  const viaTraceroute = await run(
    "traceroute",
    ["-n", "-q", "1", "-w", "1", "-m", hops, address],
    timeoutMs,
  );
  if (viaTraceroute !== undefined) {
    return { tool: "traceroute", ...limit(parseTraceroute(viaTraceroute, address)) };
  }
  return undefined;
}

/* Trailing hops that never answered say nothing; one is kept to show the path went quiet. */
function limit(result: { hops: Hop[]; reached: boolean }): { hops: Hop[]; reached: boolean } {
  const hops = result.hops.slice(0, TRACE_MAX_HOPS);
  let last = hops.length;
  while (last > 0 && hops[last - 1]?.ip === null) last -= 1;
  return { hops: hops.slice(0, Math.min(hops.length, last + 1)), reached: result.reached };
}
