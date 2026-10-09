/*
 * Importers (PRODUCT.md §6.12): bring monitors from UptimeRobot, Uptime Kuma and Better Stack, and
 * on-call schedules and escalation policies from Opsgenie and PagerDuty. A dry run says what each object would
 * become and lists what can't be brought over, with the reason; applying creates the rest.
 */
import { z } from "zod";

export const IMPORT_SOURCES = [
  "uptimerobot",
  "uptime_kuma",
  "better_stack",
  "opsgenie",
  "pagerduty",
] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

export const IMPORT_SOURCE_LABELS: Record<ImportSource, string> = {
  uptimerobot: "UptimeRobot",
  uptime_kuma: "Uptime Kuma",
  better_stack: "Better Stack",
  opsgenie: "Opsgenie",
  pagerduty: "PagerDuty",
};

/* The most objects one import may carry. */
export const MAX_IMPORT_ITEMS = 500;

export const importRequestSchema = z
  .object({
    source: z.enum(IMPORT_SOURCES),
    /* The other tool's export or API response, as JSON. */
    data: z.unknown().optional(),
    /* UptimeRobot only: a read-only API key; used for this request and never stored. */
    apiKey: z.string().trim().min(10).max(200).optional(),
  })
  .refine((r) => r.data !== undefined || r.apiKey !== undefined, {
    message: "Paste the export, or give an API key.",
    path: ["data"],
  })
  .refine((r) => r.apiKey === undefined || r.source === "uptimerobot", {
    message: "Only UptimeRobot can be read with an API key.",
    path: ["apiKey"],
  });
export type ImportRequest = z.infer<typeof importRequestSchema>;

export type ImportItemKind = "monitor" | "schedule" | "escalation";

export interface ImportItemView {
  kind: ImportItemKind;
  /* What it is called in the other tool. */
  name: string;
  /* What it becomes here, in a few words ("HTTP check every 5 min"). */
  becomes: string | null;
  /* create: will be (or was) made here. skip: can't be brought over; `reason` says why. */
  action: "create" | "skip";
  reason: string | null;
  /* After applying: whether it was made, and the error if it wasn't. */
  result?: "created" | "failed";
  error?: string | null;
}

export interface ImportPlanView {
  source: ImportSource;
  items: ImportItemView[];
  total: number;
  mapped: number;
  /* Share of objects that can be brought over, 0 to 100. */
  coveragePercent: number;
}

export interface ImportRunView extends ImportPlanView {
  id: string;
  created: number;
  failed: number;
  createdAt: string;
}
