/* Zod request schemas for reports. */
import { z } from "zod";
import { REPORT_TARGET_KINDS, reportScheduleInputSchema } from "@app/shared";

export const scheduleIdParams = z.object({ scheduleId: z.uuid() });
export const scheduleBody = reportScheduleInputSchema;

/*
 * `?kind=group&id=…&from=2026-09-01T00:00:00Z&to=2026-10-01T00:00:00Z`. `to` is exclusive.
 * `brand` (white-label) is read by the PDF only.
 */
export const slaQuery = z
  .object({
    kind: z.enum(REPORT_TARGET_KINDS).default("workspace"),
    id: z.uuid().optional(),
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
    excludeMaintenance: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
    brand: z.string().trim().min(1).max(80).optional(),
  })
  .refine((q) => (q.kind === "workspace") === (q.id === undefined), {
    path: ["id"],
    message: "needed for a monitor, a group or a status page, and only then",
  });

export const sharedReportParams = z.object({ token: z.string().min(20).max(2_000) });
export const unsubscribeQuery = z.object({ token: z.string().min(20).max(2_000) });
