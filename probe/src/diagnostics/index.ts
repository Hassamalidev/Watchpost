/*
 * Network diagnostics for a monitor that just failed (PRODUCT.md P8-T04): the path to the target
 * and how its name resolves, seen from this probe. Run when the API asks (a `diagnose` task, sent
 * when an incident opens), never as part of a check, so a failure is reported first and explained
 * after. Targets pass the same address rules as checks do.
 */
import ipaddr from "ipaddr.js";
import {
  diagnosticHostOf,
  type AddressPolicy,
  type MonitorConfig,
  type NetworkDiagnostics,
} from "@app/shared";
import { CheckError } from "../net/errors.js";
import { preferredAddress, resolveVetted, type Resolver } from "../net/resolve.js";
import { traceDns, type DnsTransport } from "./dns-trace.js";
import { tracePath, type RunCommand } from "./traceroute.js";

export interface DiagnosticsOptions {
  policy: AddressPolicy;
  /* Test hooks. */
  resolver?: Resolver;
  run?: RunCommand;
  transport?: DnsTransport;
  resolveNs?: (name: string) => Promise<string[]>;
  now?: () => number;
}

export async function runDiagnostics(
  config: MonitorConfig,
  options: DiagnosticsOptions,
): Promise<NetworkDiagnostics | undefined> {
  const host = diagnosticHostOf(config);
  if (host === undefined) return undefined;
  const now = options.now ?? Date.now;
  const started = now();
  const notes: string[] = [];
  const isName = !ipaddr.isValid(host);

  let address: string | null = null;
  let blocked = false;
  try {
    const { addresses } = await resolveVetted(host, options.policy, options.resolver);
    address = preferredAddress(addresses)?.address ?? null;
  } catch (err) {
    if (err instanceof CheckError && err.code === "ssrf_blocked") {
      blocked = true;
      notes.push("The target is an address this probe may not reach, so nothing was traced.");
    } else {
      notes.push(
        `The name did not resolve from here (${(err as Error).message}); no path to trace.`,
      );
    }
  }

  const [traceroute, dnsTrace] = await Promise.all([
    address === null
      ? Promise.resolve(null)
      : tracePath(address, options.run ? { run: options.run } : {}).then((result) => {
          if (result === undefined) {
            notes.push("This probe has no path-tracing tool installed.");
            return null;
          }
          return result;
        }),
    isName && !blocked
      ? traceDns(host, {
          policy: options.policy,
          ...(options.transport ? { transport: options.transport } : {}),
          ...(options.resolveNs ? { resolve: options.resolveNs } : {}),
          ...(options.now ? { now: options.now } : {}),
        })
      : Promise.resolve(null),
  ]);

  return {
    host,
    address,
    traceroute,
    dnsTrace,
    notes: notes.map((note) => note.slice(0, 300)),
    tookMs: Math.max(0, Math.round(now() - started)),
  };
}
