/*
 * Which status page a host name stands for (PRODUCT.md §14): `<slug>.<STATUS_BASE_DOMAIN>` is the
 * page with that subdomain. Pure, so the request proxy stays a thin wrapper and this can be tested.
 */

/* The placeholder from .env.example counts as "not set", as it does in the API's config. */
export function statusBaseDomain(value: string | undefined): string | undefined {
  const host = value?.trim().toLowerCase();
  if (!host || host === "example.com" || host.endsWith(".example.com")) return undefined;
  return host;
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;

/* The page reference a request's Host header names, or undefined for our own hosts. */
export function statusRefForHost(
  hostHeader: string | null | undefined,
  options: { baseDomain: string | undefined },
): string | undefined {
  const host = (hostHeader ?? "").trim().toLowerCase().replace(/:\d+$/, "");
  const { baseDomain } = options;
  if (host === "" || baseDomain === undefined) return undefined;
  if (!host.endsWith(`.${baseDomain}`)) return undefined;
  const slug = host.slice(0, -(baseDomain.length + 1));
  return SLUG.test(slug) ? slug : undefined;
}

/* Where a path on a status host is served from inside the app. */
export function statusPathFor(ref: string, pathname: string): string {
  const rest = pathname === "/" ? "" : pathname.replace(/\/+$/, "");
  return `/s/${ref}${rest}`;
}
