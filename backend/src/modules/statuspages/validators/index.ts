/* Zod request schemas, built from @app/shared. */
import { z } from "zod";
import {
  createStatusIncidentSchema,
  createStatusPageSchema,
  postStatusUpdateSchema,
  replaceStatusComponentsSchema,
  setStatusDomainSchema,
  updateStatusIncidentSchema,
  updateStatusPageSchema,
} from "@app/shared";

export const pageIdParams = z.object({ pageId: z.uuid() });
export const incidentIdParams = z.object({ pageId: z.uuid(), incidentId: z.uuid() });

export const createPageBody = createStatusPageSchema;
export const updatePageBody = updateStatusPageSchema;
export const replaceComponentsBody = replaceStatusComponentsSchema;
export const createIncidentBody = createStatusIncidentSchema;
export const updateIncidentBody = updateStatusIncidentSchema;
export const postUpdateBody = postStatusUpdateSchema;
export const setDomainBody = setStatusDomainSchema;
/* Caddy's on-demand TLS check: `?domain=<host>`. */
export const tlsAskQuery = z.object({ domain: z.string().trim().toLowerCase().min(1).max(253) });

/*
 * A page is named by its subdomain, or by the host name of a custom domain (which has a dot; a
 * subdomain never does).
 */
export const publicRefParams = z.object({
  ref: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(253)
    .regex(/^[a-z0-9.-]+$/),
});
