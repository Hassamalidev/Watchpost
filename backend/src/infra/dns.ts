/*
 * DNS lookups for checking that a customer's domain points at us (PRODUCT.md §6.6, §16). A name that
 * doesn't exist or has no such record answers with an empty list; a resolver that can't be reached
 * throws, so callers can tell "wrong" from "couldn't check".
 */
import { Resolver } from "node:dns/promises";

export interface DnsLookup {
  /* Where the name's CNAME record points; empty when it has none. Lowercase, no trailing dot. */
  cname(host: string): Promise<string[]>;
  /* The name's IPv4 addresses, following CNAMEs; empty when it has none. */
  a(host: string): Promise<string[]>;
}

/* Answers that mean "no such record", as opposed to a lookup that failed. */
const EMPTY = new Set(["ENODATA", "ENOTFOUND", "ENONAME", "NXDOMAIN"]);

const clean = (name: string) => name.toLowerCase().replace(/\.$/, "");

export function createDnsLookup(options: { timeoutMs?: number } = {}): DnsLookup {
  const resolver = new Resolver({ timeout: options.timeoutMs ?? 3_000, tries: 2 });
  const orEmpty = async (lookup: () => Promise<string[]>): Promise<string[]> => {
    try {
      return (await lookup()).map(clean);
    } catch (err) {
      if (EMPTY.has((err as NodeJS.ErrnoException).code ?? "")) return [];
      throw err;
    }
  };
  return {
    cname: (host) => orEmpty(() => resolver.resolveCname(host)),
    a: (host) => orEmpty(() => resolver.resolve4(host)),
  };
}
