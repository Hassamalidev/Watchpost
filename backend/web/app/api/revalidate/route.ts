/*
 * POST /api/revalidate (PRODUCT.md §7.10): the API and the worker call this on the private network
 * when a cached page changed. The body names cache tags; each is dropped so the next visitor gets a
 * fresh page. Guarded by REVALIDATE_SECRET; in production Caddy also keeps /api/* away from here.
 */
import { timingSafeEqual } from "node:crypto";
import { revalidateTag } from "next/cache";

/* The API's development default (`DEV_REVALIDATE_SECRET`); never accepted in production. */
const DEV_SECRET = "watchpost-dev-revalidate";
const MAX_TAGS = 50;
const MAX_TAG_LENGTH = 256;

function expectedSecret(): string | undefined {
  const configured = process.env.REVALIDATE_SECRET;
  if (configured) return configured;
  return process.env.NODE_ENV === "production" ? undefined : DEV_SECRET;
}

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request): Promise<Response> {
  const expected = expectedSecret();
  const given = request.headers.get("x-revalidate-secret") ?? "";
  if (expected === undefined || !sameSecret(given, expected)) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const body = (await request.json().catch(() => null)) as { tags?: unknown } | null;
  const tags = Array.isArray(body?.tags) ? body.tags : null;
  if (
    tags === null ||
    tags.length === 0 ||
    tags.length > MAX_TAGS ||
    !tags.every((tag) => typeof tag === "string" && tag !== "" && tag.length <= MAX_TAG_LENGTH)
  ) {
    return Response.json({ error: "invalid tags" }, { status: 400 });
  }
  /* Stale copies are never served: the next request waits for the fresh page. */
  for (const tag of tags as string[]) revalidateTag(tag, { expire: 0 });
  return Response.json({ revalidated: tags.length });
}
