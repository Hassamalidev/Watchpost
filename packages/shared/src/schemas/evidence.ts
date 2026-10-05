/*
 * Evidence of a failed check (PRODUCT.md §4 pillar 2, §9.1, P2-T04): what the probe saw beyond the
 * numbers. The probe attaches a small `evidence` object to a failed result; the API stores it with
 * the result's facts as one private JSON bundle in object storage (30 days), and the incident keeps
 * the bundle's key.
 */
import { z } from "zod";

/*
 * Response headers a probe may keep. An allowlist, so cookies, tokens and anything a customer's
 * server invents never leave the probe.
 */
export const EVIDENCE_HEADERS = [
  "content-type",
  "content-length",
  "content-encoding",
  "date",
  "server",
  "location",
  "retry-after",
  "cache-control",
  "age",
  "via",
  "x-cache",
  "cf-ray",
  "cf-cache-status",
  "x-request-id",
  "x-amzn-requestid",
  "x-amz-cf-id",
  "x-served-by",
  "x-powered-by",
  "www-authenticate",
] as const;

export const EVIDENCE_HEADER_VALUE_MAX = 300;
/* Enough to recognise an error page or a JSON error; small enough to store for every failure. */
export const EVIDENCE_BODY_MAX_CHARS = 2_000;

export const checkEvidenceSchema = z.object({
  headers: z
    .record(z.string().max(64), z.string().max(EVIDENCE_HEADER_VALUE_MAX))
    .refine((h) => Object.keys(h).length <= EVIDENCE_HEADERS.length, "too many headers")
    .optional(),
  /* The start of a text body; absent for binary responses. */
  bodySnippet: z.string().max(EVIDENCE_BODY_MAX_CHARS).optional(),
  /* Size of the body the probe read (it stops at 1 MB). */
  bodyBytes: z.number().int().min(0).optional(),
  /* True when the body is longer than the snippet. */
  bodyTruncated: z.boolean().optional(),
});
export type CheckEvidence = z.infer<typeof checkEvidenceSchema>;

/* Keeps the allowlisted headers, lower-cased, with long values cut. */
export function pickEvidenceHeaders(
  headers: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const allowed = new Set<string>(EVIDENCE_HEADERS);
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (value === undefined || !allowed.has(key) || kept[key] !== undefined) continue;
    kept[key] = value.slice(0, EVIDENCE_HEADER_VALUE_MAX);
  }
  return kept;
}
