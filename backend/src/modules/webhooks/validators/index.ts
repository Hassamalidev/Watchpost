/* Zod request schemas for outbound webhooks. */
import { z } from "zod";
import { WEBHOOK_EVENT_TYPES, createWebhookSchema, updateWebhookSchema } from "@app/shared";

export const webhookIdParams = z.object({ webhookId: z.uuid() });
export const deliveryParams = z.object({ webhookId: z.uuid(), deliveryId: z.uuid() });
export const createWebhookBody = createWebhookSchema;
export const updateWebhookBody = updateWebhookSchema;
export const testWebhookBody = z
  .object({ type: z.enum(WEBHOOK_EVENT_TYPES).default("incident.triggered") })
  .strict();
export const deliveriesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
