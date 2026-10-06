/* Zod request schemas, built from @app/shared. */
import { createOverrideSchema, createScheduleSchema, updateScheduleSchema } from "@app/shared";
import { z } from "zod";

export const createScheduleBody = createScheduleSchema;
export const updateScheduleBody = updateScheduleSchema;
export const createOverrideBody = createOverrideSchema;
export const scheduleIdParams = z.object({ scheduleId: z.uuid() });
export const overrideIdParams = z.object({ scheduleId: z.uuid(), overrideId: z.uuid() });
export const onCallQuery = z.object({ at: z.iso.datetime({ offset: true }).optional() });
export const timelineQuery = z.object({
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
});
