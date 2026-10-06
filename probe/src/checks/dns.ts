/*
 * DNS check (PRODUCT.md §6.1): query one record type, optionally through a chosen resolver, and
 * require every expected value to be present. Answers are normalized (lower case, no trailing dot)
 * and returned in `details.answers` so the API can detect changes (alertOnChange).
 */
import { Resolver } from "node:dns/promises";
import type { MonitorConfig } from "@app/shared";
import { failure, type CheckContext, type CheckOutcome } from "../executor/executor.js";

type DnsConfig = Extract<MonitorConfig, { type: "dns" }>;

const norm = (v: string) => v.trim().toLowerCase().replace(/\.$/, "");

const DNS_ERRORS: Record<string, CheckOutcome["errorCode"]> = {
  ENOTFOUND: "dns_nxdomain",
  ENODATA: "dns_no_records",
  ESERVFAIL: "dns_servfail",
  EREFUSED: "dns_servfail",
  ETIMEOUT: "dns_timeout",
  ECONNREFUSED: "dns_timeout",
};

async function query(resolver: Resolver, config: DnsConfig): Promise<string[]> {
  const host = config.hostname;
  switch (config.recordType) {
    case "A":
      return resolver.resolve4(host);
    case "AAAA":
      return resolver.resolve6(host);
    case "CNAME":
      return resolver.resolveCname(host);
    case "NS":
      return resolver.resolveNs(host);
    case "MX":
      return (await resolver.resolveMx(host)).map((r) => `${r.priority} ${r.exchange}`);
    case "TXT":
      return (await resolver.resolveTxt(host)).map((parts) => parts.join(""));
    case "CAA":
      return (await resolver.resolveCaa(host)).map((r) => {
        const [tag, value] = Object.entries(r).find(([k]) => k !== "critical") ?? ["", ""];
        return `${r.critical} ${tag} "${String(value)}"`;
      });
    case "SOA": {
      const soa = await resolver.resolveSoa(host);
      return [`${soa.nsname} ${soa.hostmaster} ${soa.serial}`];
    }
  }
}

/* An expected value matches an MX answer by exchange alone, or by "priority exchange". */
function contains(answers: string[], expected: string): boolean {
  const e = norm(expected);
  return answers.some((a) => a === e || a.split(" ").slice(1).join(" ") === e);
}

export async function runDns(config: MonitorConfig, ctx: CheckContext): Promise<CheckOutcome> {
  if (config.type !== "dns") throw new Error("runDns got a non-DNS config");
  const started = performance.now();
  const resolver = new Resolver({ timeout: Math.max(500, ctx.timeoutMs - 250), tries: 1 });

  if (config.resolver !== undefined) {
    const [ip, port] = splitResolver(config.resolver);
    const reason = ctx.policy.check(ip);
    if (reason !== null) return failure("ssrf_blocked", `resolver ${ip} is not allowed: ${reason}`);
    resolver.setServers([port ? `${ip.includes(":") ? `[${ip}]` : ip}:${port}` : ip]);
  }

  let answers: string[];
  try {
    answers = (await query(resolver, config)).map(norm).sort();
  } catch (err) {
    const code = DNS_ERRORS[(err as NodeJS.ErrnoException).code ?? ""] ?? "dns_servfail";
    return failure(code, (err as Error).message, Math.round(performance.now() - started));
  } finally {
    resolver.cancel();
  }
  const latencyMs = Math.round(performance.now() - started);
  if (answers.length === 0)
    return failure("dns_no_records", `no ${config.recordType} records`, latencyMs);

  const missing = config.expectedValues.filter((v) => !contains(answers, v));
  if (missing.length > 0) {
    return {
      ok: false,
      errorCode: "dns_value_mismatch",
      message: `missing ${missing.join(", ")}; got ${answers.join(", ")}`.slice(0, 500),
      latencyMs,
      details: { answers },
    };
  }
  return {
    ok: true,
    latencyMs,
    timings: { dns: latencyMs, total: latencyMs },
    details: { answers },
  };
}

/* Accepts "1.1.1.1", "2606:4700::1111" and, for tests, "127.0.0.1:5353". */
export function splitResolver(value: string): [string, number | undefined] {
  const v4WithPort = /^(\d+\.\d+\.\d+\.\d+):(\d+)$/.exec(value);
  if (v4WithPort) return [v4WithPort[1] ?? value, Number(v4WithPort[2])];
  return [value, undefined];
}
