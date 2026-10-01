/* Zod request schemas for the deploys API. */
import { z } from "zod";

/* What CI posts to the deploy URL. `version` is the commit, tag or build number. */
export const recordDeployBody = z
  .object({
    version: z.string().trim().min(1).max(100),
    service: z.string().trim().min(1).max(100).optional(),
    environment: z.string().trim().min(1).max(50).optional(),
    url: z
      .url({ protocol: /^https?$/ })
      .max(2_000)
      .optional(),
    description: z.string().trim().min(1).max(500).optional(),
    at: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

export const listDeploysQuery = z.object({
  before: z.iso.datetime({ offset: true }).optional(),
  hours: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .default(24 * 7),
});
