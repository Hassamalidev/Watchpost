/* Zod request schemas for API keys. */
import { z } from "zod";
import { createApiKeySchema } from "@app/shared";

export const keyIdParams = z.object({ keyId: z.uuid() });
export const createKeyBody = createApiKeySchema;
