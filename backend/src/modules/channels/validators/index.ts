/* Zod request schemas for the channels API, built from @app/shared. */
import { z } from "zod";
import { createChannelSchema, updateChannelSchema } from "@app/shared";

export const channelIdParams = z.object({ channelId: z.uuid() });
export const createChannelBody = createChannelSchema;
export const updateChannelBody = updateChannelSchema;
