/*
 * Which status page a host name stands for (PRODUCT.md §14): `<slug>.<STATUS_BASE_DOMAIN>` is the
 * page with that subdomain, and a host that is none of ours is a customer's own domain (the API
 * serves it only once it is verified). Pure, so the request proxy stays a thin wrapper and this can
 * be tested.
 */

/* The placeholders from .env.example count as "not set", as they do in the API's config. */
export function realHost(value: string | undefined): string | undefined {
  const host = value?.trim().toLowerCase();
  if (!host || host === "example.com" || host.endsWith(".example.com")) return undefined;
  return host;
}
export const statusBaseDomain = realHost;

const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])$/;

export interface StatusHostOptions {
  baseDomain: string | undefined;
  /*
   * The app's own host (APP_DOMAIN, for example app.acme.io). Everything under its parent domain
   * (acme.io, www.acme.io, hb.acme.io) is ours. Without it custom domains are not routed.
   */
  appDomain?: string | undefined;
  /* More hosts of ours, for setups the rule above doesn't cover. */
  ownHosts?: readonly string[];
}

const under = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/* The page reference a request's Host header names, or undefined for our own hosts. */
export function statusRefForHost(
  hostHeader: string | null | undefined,
  options: StatusHostOptions,
): string | undefined {
  const host = (hostHeader ?? "").trim().toLowerCase().replace(/:\d+$/, "");
  const { baseDomain, appDomain } = options;
  if (host === "" || baseDomain === undefined) return undefined;
  if (host.endsWith(`.${baseDomain}`)) {
    const slug = host.slice(0, -(baseDomain.length + 1));
    return SLUG.test(slug) ? slug : undefined;
  }
  if (host === baseDomain || appDomain === undefined) return undefined;
  /* Internal names, IP addresses and anything that isn't a public host name are never pages. */
  if (!DOMAIN.test(host) || host === "localhost") return undefined;
  const parent = appDomain.includes(".") ? appDomain.slice(appDomain.indexOf(".") + 1) : appDomain;
  const ours = [appDomain, parent.includes(".") ? parent : appDomain, ...(options.ownHosts ?? [])];
  if (ours.some((own) => under(host, own))) return undefined;
  return host;
}

/* Where a path on a status host is served from inside the app. */
export function statusPathFor(ref: string, pathname: string): string {
  const rest = pathname === "/" ? "" : pathname.replace(/\/+$/, "");
  return `/s/${ref}${rest}`;
}
