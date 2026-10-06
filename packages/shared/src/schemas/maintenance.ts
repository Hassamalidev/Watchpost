/*
 * Maintenance windows (PRODUCT.md §6.2, §9.6): planned work during which a monitor's failures open no
 * incident and send no alert. One-off, or repeating by a small RRULE (see the API's recurrence.ts).
 */
import { z } from "zod";

export const MAINTENANCE_MAX_DAYS = 30;
export const MAINTENANCE_MAX_MONITORS = 500;

/* Every monitor in the workspace, or the listed ones. */
export const maintenanceScopeSchema = z.union([
  z.object({ all: z.literal(true) }).strict(),
  z.object({ monitorIds: z.array(z.uuid()).min(1).max(MAINTENANCE_MAX_MONITORS) }).strict(),
]);
export type MaintenanceScope = z.infer<typeof maintenanceScopeSchema>;

export const maintenanceWindowObject = z.object({
  name: z.string().trim().min(1).max(120),
  /* The first occurrence. */
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  /* IANA zone the repeat follows, so "Sundays at 02:00" stays at 02:00 across clock changes. */
  timezone: z.string().trim().min(1).max(64).default("UTC"),
  /* FREQ=DAILY|WEEKLY|MONTHLY with INTERVAL, BYDAY, COUNT or UNTIL; null for a one-off window. */
  rrule: z.string().trim().min(1).max(200).nullable().default(null),
  scope: maintenanceScopeSchema,
  /* Off makes the window informational: it is shown, but alerts still fire. */
  suppressAlerts: z.boolean().default(true),
  showOnPages: z.boolean().default(true),
});

const MAX_MS = MAINTENANCE_MAX_DAYS * 86_400_000;
const validSpan = (w: { startsAt?: string | undefined; endsAt?: string | undefined }) => {
  if (w.startsAt === undefined || w.endsAt === undefined) return true;
  const span = Date.parse(w.endsAt) - Date.parse(w.startsAt);
  return span > 0 && span <= MAX_MS;
};
const spanIssue = {
  message: `must be after the start, and at most ${MAINTENANCE_MAX_DAYS} days later`,
  path: ["endsAt"],
};

export const createMaintenanceWindowSchema = maintenanceWindowObject
  .strict()
  .refine(validSpan, spanIssue);
export type CreateMaintenanceWindowInput = z.infer<typeof createMaintenanceWindowSchema>;

export const updateMaintenanceWindowSchema = maintenanceWindowObject
  .partial()
  .strict()
  .refine((w) => Object.keys(w).length > 0, "nothing to update")
  .refine(validSpan, spanIssue);
export type UpdateMaintenanceWindowInput = z.infer<typeof updateMaintenanceWindowSchema>;

export interface MaintenanceWindowView {
  id: string;
  name: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  rrule: string | null;
  scope: MaintenanceScope;
  suppressAlerts: boolean;
  showOnPages: boolean;
  /* In effect right now, and until when. */
  active: boolean;
  activeUntil: string | null;
  /* The next time it starts; null when it won't again. */
  nextStart: string | null;
  /* No occurrence is left. */
  over: boolean;
  createdAt: string;
}
