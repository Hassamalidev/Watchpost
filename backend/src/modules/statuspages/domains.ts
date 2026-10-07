/*
 * Custom domains for status pages (PRODUCT.md §6.6, §16): does the customer's domain point at us?
 * It does when its CNAME chain reaches our target, or, for DNS hosts that hide the CNAME (apex
 * "flattening", proxies), when it resolves to an address our target resolves to. Only a verified
 * domain is ever given a certificate.
 */
import type { DnsLookup } from "../../infra/dns.js";

export type DomainCheck =
  | { ok: true }
  /* DNS answered and the domain doesn't point at us; `reason` is shown to the customer. */
  | { ok: false; reason: string }
  /* DNS couldn't be asked; nothing is concluded. */
  | { ok: null; reason: string };

const MAX_CNAME_HOPS = 5;

export async function checkDomain(
  dns: DnsLookup,
  domain: string,
  target: string,
): Promise<DomainCheck> {
  try {
    let name = domain;
    let seen: string | undefined;
    for (let hop = 0; hop < MAX_CNAME_HOPS; hop += 1) {
      const records = await dns.cname(name);
      if (records.includes(target)) return { ok: true };
      const [next] = records;
      if (next === undefined) break;
      seen = next;
      name = next;
    }
    /* No CNAME to us in sight: the same addresses are as good. */
    const [ours, theirs] = await Promise.all([dns.a(target), dns.a(domain)]);
    if (theirs.some((address) => ours.includes(address))) return { ok: true };
    if (seen !== undefined) {
      return {
        ok: false,
        reason: `${domain} points to ${seen}, not to ${target}. Change its CNAME record to ${target}.`,
      };
    }
    return {
      ok: false,
      reason:
        theirs.length > 0
          ? `${domain} doesn't point to ${target}. Replace its A record with a CNAME record to ${target}.`
          : `No DNS record found for ${domain}. Add a CNAME record that points to ${target}; a new record can take a few minutes to show up.`,
    };
  } catch {
    return { ok: null, reason: "DNS couldn't be checked just now. Try again in a minute." };
  }
}

/* Is `host` the same as `domain` or under it? */
export const isSameOrSubdomain = (host: string, domain: string) =>
  host === domain || host.endsWith(`.${domain}`);
