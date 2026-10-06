/*
 * Stored evidence bundles (P2-T04): one private JSON object per failed result that carried evidence,
 * and the references an incident keeps to them. See evidence.ts for what the probe attaches.
 */
import { z } from "zod";
import { tlsInfoSchema, timingsSchema } from "./results.js";

/* One stored bundle: the failed result's facts plus what the probe kept of the response. */
export const evidenceBundleSchema = z.object({
  version: z.literal(1),
  resultId: z.uuid(),
  monitorId: z.uuid(),
  region: z.string().max(64),
  checkedAt: z.iso.datetime({ offset: true }),
  errorCode: z.string().max(64).nullable(),
  message: z.string().max(500).nullable(),
  httpStatus: z.number().int().nullable(),
  latencyMs: z.number().min(0),
  timings: timingsSchema.nullable(),
  ip: z.string().max(64).nullable(),
  tls: tlsInfoSchema.nullable(),
  /* Type-specific facts from the result (final URL, redirects). */
  details: z.record(z.string(), z.unknown()).nullable(),
  headers: z.record(z.string(), z.string()),
  bodySnippet: z.string().nullable(),
  bodyBytes: z.number().int().min(0).nullable(),
  bodyTruncated: z.boolean(),
});
export type EvidenceBundle = z.infer<typeof evidenceBundleSchema>;

/* Where an incident points at a bundle: one per failing region. */
export const evidenceRefSchema = z.object({
  region: z.string().max(64),
  resultId: z.uuid(),
  checkedAt: z.iso.datetime({ offset: true }),
  key: z.string().min(1).max(300),
});
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;

/* What the incident's evidence endpoint answers per failing region. */
export type IncidentEvidenceItem =
  | { region: string; checkedAt: string; available: true; bundle: EvidenceBundle }
  /* The bundle is past its 30 days, or storage can't be read right now. */
  | { region: string; checkedAt: string; available: false };

/* evidence/<workspace>/<yyyy-mm-dd>/<result>.json: the workspace is in the key so reads can check it. */
export function evidenceKey(workspaceId: string, checkedAt: string, resultId: string): string {
  return `evidence/${workspaceId}/${checkedAt.slice(0, 10)}/${resultId}.json`;
}

export const evidenceKeyPrefix = (workspaceId: string) => `evidence/${workspaceId}/`;
