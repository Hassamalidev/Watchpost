/*
 * Resolve a hostname and vet every address (PRODUCT.md §9.1 step 1): if ANY answer is not allowed,
 * the whole name is refused, so a record set can't smuggle in a private address.
 */
import { promises as dns } from "node:dns";
import ipaddr from "ipaddr.js";
import type { AddressPolicy } from "./address-policy.js";
import { CheckError, toCheckError } from "./errors.js";

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export const systemResolver: Resolver = async (hostname) => {
  const answers = await dns.lookup(hostname, { all: true, verbatim: true });
  return answers.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
};

/* A lookup with no deadline of the check's own never waits longer than this. */
const LOOKUP_MAX_MS = 10_000;

/*
 * The lookup is part of the check's time. The system resolver has no timeout we control and can
 * hold on for as long as the operating system likes when a zone's nameservers are dead, so the wait
 * ends at the check's deadline and the result says what happened: the name didn't resolve in time.
 */
function withinDeadline<T>(lookup: Promise<T>, host: string, deadline: number): Promise<T> {
  const ms = Math.max(1, deadline - Date.now());
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new CheckError("dns_timeout", `${host} did not resolve within ${ms} ms`)),
      ms,
    );
  });
  /* The lookup may still fail after we stopped waiting; that failure is nobody's to handle. */
  lookup.catch(() => undefined);
  return Promise.race([lookup, late]).finally(() => clearTimeout(timer));
}

export async function resolveVetted(
  hostname: string,
  policy: AddressPolicy,
  resolver: Resolver = systemResolver,
  /* When the check must be over (epoch ms). */
  deadline: number = Date.now() + LOOKUP_MAX_MS,
): Promise<{ addresses: ResolvedAddress[]; dnsMs: number }> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (policy.isDeniedHost(host)) {
    throw new CheckError("ssrf_blocked", `${host} is not allowed as a target`);
  }
  const started = performance.now();
  let addresses: ResolvedAddress[];
  if (ipaddr.isValid(host)) {
    addresses = [{ address: host, family: ipaddr.parse(host).kind() === "ipv6" ? 6 : 4 }];
  } else {
    try {
      addresses = await withinDeadline(resolver(host), host, deadline);
    } catch (err) {
      throw err instanceof CheckError ? err : toCheckError(err, "dns");
    }
  }
  const dnsMs = performance.now() - started;
  if (addresses.length === 0)
    throw new CheckError("dns_no_records", `${host} has no A or AAAA records`);
  for (const { address } of addresses) {
    const reason = policy.check(address);
    if (reason !== null) {
      throw new CheckError("ssrf_blocked", `${host} resolves to a blocked address: ${reason}`, {
        address,
      });
    }
  }
  return { addresses, dnsMs };
}

/* Probes prefer IPv4 when a name has both (more reliably routable from probe hosts). */
export function preferredAddress(
  addresses: readonly ResolvedAddress[],
): ResolvedAddress | undefined {
  return addresses.find((a) => a.family === 4) ?? addresses[0];
}

/* A `lookup` that always returns the vetted address, so the connection can't be re-resolved (rebinding). */
export function pinnedLookup(vetted: ResolvedAddress) {
  return (
    _hostname: string,
    options: { all?: boolean } | number | undefined,
    callback: (...args: unknown[]) => void,
  ) => {
    const all = typeof options === "object" && options?.all;
    if (all) callback(null, [{ address: vetted.address, family: vetted.family }]);
    else callback(null, vetted.address, vetted.family);
  };
}
