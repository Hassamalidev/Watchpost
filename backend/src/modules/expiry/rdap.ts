/*
 * Domain registration expiry through RDAP (PRODUCT.md §9.8). IANA's bootstrap file maps each TLD to
 * its registry's RDAP servers; the registry's domain record carries an "expiration" event. TLDs with
 * no RDAP service are reported as unsupported rather than guessed (a WHOIS fallback is in the
 * backlog).
 */
import type { OutboundHttp } from "../../infra/http/outbound.js";

export const RDAP_BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";

export type RdapLookup =
  | { status: "ok"; expiresAt: Date; registrar: string | null }
  | { status: "unsupported"; error: string }
  | { status: "error"; error: string };

/* TLD → RDAP base URLs, from IANA's `dns.json`. */
export function parseBootstrap(body: unknown): Map<string, string[]> {
  const services = (body as { services?: unknown } | undefined)?.services;
  const map = new Map<string, string[]>();
  if (!Array.isArray(services)) return map;
  for (const service of services) {
    if (!Array.isArray(service) || service.length < 2) continue;
    const [tlds, urls] = service as [unknown, unknown];
    if (!Array.isArray(tlds) || !Array.isArray(urls)) continue;
    const https = urls.filter(
      (u): u is string => typeof u === "string" && u.startsWith("https://"),
    );
    if (https.length === 0) continue;
    for (const tld of tlds) if (typeof tld === "string") map.set(tld.toLowerCase(), https);
  }
  return map;
}

export async function fetchBootstrap(http: OutboundHttp): Promise<Map<string, string[]>> {
  const res = await http.request({
    method: "GET",
    url: RDAP_BOOTSTRAP_URL,
    headers: { accept: "application/json" },
    timeoutMs: 15_000,
  });
  if (res.status !== 200) throw new Error(`IANA RDAP bootstrap answered HTTP ${res.status}`);
  const map = parseBootstrap(JSON.parse(res.body));
  if (map.size === 0) throw new Error("IANA RDAP bootstrap had no services");
  return map;
}

/* The expiration date and registrar name in an RDAP domain record. */
export function parseDomainRecord(body: unknown): {
  expiresAt: Date | null;
  registrar: string | null;
} {
  const record = body as { events?: unknown; entities?: unknown } | undefined;
  let expiresAt: Date | null = null;
  if (Array.isArray(record?.events)) {
    for (const event of record.events as Array<{ eventAction?: unknown; eventDate?: unknown }>) {
      if (event.eventAction === "expiration" && typeof event.eventDate === "string") {
        const date = new Date(event.eventDate);
        if (!Number.isNaN(date.getTime())) expiresAt = date;
      }
    }
  }
  let registrar: string | null = null;
  if (Array.isArray(record?.entities)) {
    for (const entity of record.entities as Array<{ roles?: unknown; vcardArray?: unknown }>) {
      if (!Array.isArray(entity.roles) || !entity.roles.includes("registrar")) continue;
      const card = Array.isArray(entity.vcardArray) ? (entity.vcardArray[1] as unknown) : undefined;
      if (Array.isArray(card)) {
        const fn = card.find((field) => Array.isArray(field) && field[0] === "fn") as
          unknown[] | undefined;
        if (typeof fn?.[3] === "string") registrar = fn[3];
      }
    }
  }
  return { expiresAt, registrar };
}

export async function lookupDomain(
  http: OutboundHttp,
  bootstrap: Map<string, string[]>,
  domain: string,
): Promise<RdapLookup> {
  const name = domain.toLowerCase().replace(/\.$/, "");
  const tld = name.split(".").at(-1) ?? "";
  const bases = bootstrap.get(tld);
  if (bases === undefined) {
    return {
      status: "unsupported",
      error: `Domain expiry isn't available for .${tld} domains: the registry has no RDAP service.`,
    };
  }
  let lastError = "no RDAP server answered";
  for (const base of bases) {
    const url = `${base.endsWith("/") ? base : `${base}/`}domain/${encodeURIComponent(name)}`;
    try {
      const res = await http.request({
        method: "GET",
        url,
        headers: { accept: "application/rdap+json, application/json" },
        timeoutMs: 15_000,
      });
      if (res.status === 404) {
        return {
          status: "error",
          error: `${name} isn't registered, or isn't a registrable domain (use example.com, not www.example.com).`,
        };
      }
      if (res.status !== 200) {
        lastError = `the registry's RDAP server answered HTTP ${res.status}`;
        continue;
      }
      const { expiresAt, registrar } = parseDomainRecord(JSON.parse(res.body));
      if (expiresAt === null) {
        return { status: "error", error: "The registry doesn't publish an expiration date." };
      }
      return { status: "ok", expiresAt, registrar };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return { status: "error", error: `RDAP lookup failed: ${lastError}` };
}
