/*
 * Server-side read of a public status page (PRODUCT.md §7.10). The answer is cached under a tag;
 * the API asks `/api/revalidate` to drop that tag whenever the page changes, so visitors see a
 * status change within seconds. The timer is only a fallback for a refresh that got lost.
 */
import type { PublicStatusPage } from "@app/shared";

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const FALLBACK_SECONDS = 30;

/* The same tag the API names (`statusPageTag`). */
export const statusPageTag = (ref: string) => `status-page:${ref}`;

/* A subdomain, or the host name of a custom domain. */
export const isStatusRef = (ref: string) => /^[a-z0-9.-]{3,253}$/.test(ref);

export async function loadStatusPage(ref: string): Promise<PublicStatusPage | null> {
  if (!isStatusRef(ref)) return null;
  const res = await fetch(`${API_URL}/api/public/status/${ref}`, {
    next: { tags: [statusPageTag(ref)], revalidate: FALLBACK_SECONDS },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`status page API answered ${res.status}`);
  return (await res.json()) as PublicStatusPage;
}
