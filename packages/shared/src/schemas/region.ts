/* Where a check runs from: one of our regions, or one private probe (constants/regions.ts). */
import { z } from "zod";
import { REGIONS, isPrivateRegion } from "../constants/regions.js";

export const checkRegionSchema = z.union([
  z.enum(REGIONS),
  z.string().refine(isPrivateRegion, "is not a region or a private probe"),
]);
export type CheckRegion = z.infer<typeof checkRegionSchema>;

/* The private probe program we ship; a probe reporting an older one is offered an upgrade. */
export const PROBE_CURRENT_VERSION = "0.1.0";
export const PRIVATE_PROBE_OFFLINE_AFTER_MS = 5 * 60_000;

export const createPrivateProbeSchema = z
  .object({ name: z.string().trim().min(1).max(80) })
  .strict();
export type CreatePrivateProbeInput = z.infer<typeof createPrivateProbeSchema>;

export interface PrivateProbeView {
  id: string;
  name: string;
  /* What a monitor's `regions` holds to run on this probe. */
  region: string;
  /* Reported in the last five minutes. */
  online: boolean;
  lastSeenAt: string | null;
  version: string | null;
  /* The probe runs an older program than the current one. */
  upgradeAvailable: boolean;
  /* Monitors that run on it. */
  monitors: number;
  createdAt: string;
}

/* The answer to creating a probe: the only time its token is shown. */
export interface CreatedPrivateProbe extends PrivateProbeView {
  token: string;
  /* The one-line install, with the token in it. */
  command: string;
}

export const PROBE_TOKEN_PREFIX = "wpp_";
/* `wpp_<probe ID>.<secret>`: everything a probe needs besides the address of the API. */
export function parseProbeToken(token: string): { probeId: string; secret: string } | undefined {
  const match = /^wpp_([0-9a-f-]{36})\.([A-Za-z0-9_-]{32,})$/.exec(token.trim());
  return match?.[1] && match[2] ? { probeId: match[1], secret: match[2] } : undefined;
}
