/* Zod request schemas for the probes module's user-facing routes. */
import { z } from "zod";

export const monitorIdParams = z.object({ monitorId: z.uuid() });
export const taskIdParams = z.object({ taskId: z.uuid() });
