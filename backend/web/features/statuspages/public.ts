/*
 * Server-side read of a public status page (PRODUCT.md §7.10). The answer is cached under a tag;
 * the API asks `/api/revalidate` to drop that tag whenever the page changes, so visitors see a
 * status change within seconds. The timer is only a fallback for a refresh that got lost.
 *
 * A private page (§6.6) answers that cached read with "locked". Then the page is asked for again
 * on behalf of the visitor, uncached: this server proves itself to the API with the secret the two
 * already share, names the visitor's address and passes on the visitor's cookies.
 */
import type { PublicStatusLocked, PublicStatusPage } from "@app/shared";

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const FALLBACK_SECONDS = 30;
/* The API's development default (`DEV_REVALIDATE_SECRET`); never used in production. */
const DEV_SECRET = "watchpost-dev-revalidate";

/* The same tag the API names (`statusPageTag`). */
export const statusPageTag = (ref: string) => `status-page:${ref}`;

/* A subdomain, or the host name of a custom domain. */
export const isStatusRef = (ref: string) => /^[a-z0-9.-]{3,253}$/.test(ref);

export type LoadedStatusPage = PublicStatusPage | PublicStatusLocked;
export const isLocked = (loaded: LoadedStatusPage): loaded is PublicStatusLocked =>
  "locked" in loaded;

/* Who is looking at the page: their address and the cookies their browser sent. */
export interface StatusVisitor {
  ip?: string | undefined;
  cookie?: string | undefined;
}

/* The visitor's address as the proxy in front of this server reports it. */
export function visitorIp(header: (name: string) => string | null): string | undefined {
  const forwarded = header("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || header("x-real-ip")?.trim() || undefined;
}

function webSecret(): string | undefined {
  const configured = process.env.REVALIDATE_SECRET;
  if (configured) return configured;
  return process.env.NODE_ENV === "production" ? undefined : DEV_SECRET;
}

async function read(res: Response): Promise<LoadedStatusPage | null> {
  if (res.status === 404) return null;
  if (res.status === 401) return (await res.json()) as PublicStatusLocked;
  if (!res.ok) throw new Error(`status page API answered ${res.status}`);
  return (await res.json()) as PublicStatusPage;
}

export async function loadStatusPage(ref: string): Promise<LoadedStatusPage | null> {
  if (!isStatusRef(ref)) return null;
  return read(
    await fetch(`${API_URL}/api/public/status/${ref}`, {
      next: { tags: [statusPageTag(ref)], revalidate: FALLBACK_SECONDS },
    }),
  );
}

/* A private page for one visitor. Never cached: the answer is theirs alone. */
export async function loadStatusPageAs(
  ref: string,
  visitor: StatusVisitor,
): Promise<LoadedStatusPage | null> {
  if (!isStatusRef(ref)) return null;
  const secret = webSecret();
  return read(
    await fetch(`${API_URL}/api/public/status/${ref}`, {
      cache: "no-store",
      headers: {
        ...(secret === undefined ? {} : { "x-status-web-secret": secret }),
        ...(visitor.ip === undefined ? {} : { "x-status-visitor-ip": visitor.ip }),
        ...(visitor.cookie === undefined ? {} : { cookie: visitor.cookie }),
      },
    }),
  );
}
