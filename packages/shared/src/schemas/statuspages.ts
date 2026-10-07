/*
 * Status pages (PRODUCT.md §6.6): a public page per product with components (linked to monitors or
 * set by hand), 90-day uptime bars, incidents with updates, and scheduled maintenance. The same
 * shapes serve the editor in the app and the public page.
 */
import { z } from "zod";
import type { MonitorStatus } from "../constants/product.js";

export const COMPONENT_STATUSES = [
  "operational",
  "degraded",
  "partial_outage",
  "major_outage",
  "maintenance",
  /* A linked monitor that has no result yet or is paused. */
  "unknown",
] as const;
export type ComponentStatus = (typeof COMPONENT_STATUSES)[number];

/* What a person may set by hand (never "unknown"). */
export const MANUAL_COMPONENT_STATUSES = [
  "operational",
  "degraded",
  "partial_outage",
  "major_outage",
  "maintenance",
] as const;

export const STATUS_INCIDENT_STATUSES = [
  "investigating",
  "identified",
  "monitoring",
  "resolved",
] as const;
export type StatusIncidentStatus = (typeof STATUS_INCIDENT_STATUSES)[number];

/* How badly the listed components are affected while the incident is open. */
export const STATUS_IMPACTS = ["degraded", "partial_outage", "major_outage"] as const;
export type StatusImpact = (typeof STATUS_IMPACTS)[number];

export const STATUS_PAGE_MAX_COMPONENTS = 100;
/* Days of uptime bars and of incident history a page shows. */
export const STATUS_PAGE_UPTIME_DAYS = 90;
export const STATUS_PAGE_HISTORY_DAYS = 14;

/* Subdomains we keep for ourselves. */
export const RESERVED_STATUS_SLUGS = [
  "www",
  "app",
  "api",
  "admin",
  "status",
  "mail",
  "hb",
  "docs",
  "help",
  "support",
  "blog",
  "pages",
] as const;

export const statusSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/,
    "use 3 to 63 lowercase letters, digits or hyphens, not starting or ending with a hyphen",
  )
  .refine(
    (s) => !(RESERVED_STATUS_SLUGS as readonly string[]).includes(s),
    "this name is reserved",
  );

const httpsUrl = z
  .url()
  .max(2_048)
  .refine((u) => u.startsWith("https://"), "must start with https://");

export const statusBrandingSchema = z
  .object({
    logoUrl: httpsUrl.nullable().default(null),
    faviconUrl: httpsUrl.nullable().default(null),
    /* The page's accent color, as #rrggbb. */
    accentColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, "use a color like #2563eb")
      .nullable()
      .default(null),
    /* One or two sentences under the title. */
    description: z.string().trim().max(300).nullable().default(null),
    /* Where "Contact support" goes. */
    supportUrl: httpsUrl.nullable().default(null),
  })
  .strict();
export type StatusBranding = z.infer<typeof statusBrandingSchema>;

export const statusPageSettingsSchema = z
  .object({
    showUptime: z.boolean().default(true),
    /* Open a page incident by itself when a linked monitor stays down (§6.6). */
    autoIncidents: z
      .object({
        enabled: z.boolean().default(false),
        afterMinutes: z.number().int().min(1).max(120).default(5),
        /* "draft" holds the incident for a person to publish. */
        publish: z.enum(["auto", "draft"]).default("auto"),
      })
      .strict()
      .default({ enabled: false, afterMinutes: 5, publish: "auto" }),
    /* Let visitors subscribe to updates by email (needs a plan with subscribers). */
    subscribers: z.boolean().default(true),
  })
  .strict();
export type StatusPageSettings = z.infer<typeof statusPageSettingsSchema>;

export const statusComponentInputSchema = z
  .object({
    /* Present for a component the page already has; absent for a new one. */
    id: z.uuid().optional(),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(300).nullable().default(null),
    /* The monitor whose state the component shows; null for one set by hand. */
    monitorId: z.uuid().nullable().default(null),
    manualStatus: z.enum(MANUAL_COMPONENT_STATUSES).nullable().default(null),
    /* Components with the same group name are shown together. */
    group: z.string().trim().min(1).max(80).nullable().default(null),
    showUptime: z.boolean().default(true),
  })
  .strict();
export type StatusComponentInput = z.infer<typeof statusComponentInputSchema>;

export const createStatusPageSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    slug: statusSlugSchema,
    branding: statusBrandingSchema.optional(),
    settings: statusPageSettingsSchema.optional(),
    /* Start the page with one component per monitor listed here. */
    monitorIds: z.array(z.uuid()).max(STATUS_PAGE_MAX_COMPONENTS).optional(),
    published: z.boolean().default(true),
  })
  .strict();
export type CreateStatusPageInput = z.infer<typeof createStatusPageSchema>;

export const updateStatusPageSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    slug: statusSlugSchema.optional(),
    branding: statusBrandingSchema.optional(),
    settings: statusPageSettingsSchema.optional(),
    published: z.boolean().optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, "nothing to update");
export type UpdateStatusPageInput = z.infer<typeof updateStatusPageSchema>;

/* The whole ordered list: components left out are removed. */
export const replaceStatusComponentsSchema = z
  .object({ components: z.array(statusComponentInputSchema).max(STATUS_PAGE_MAX_COMPONENTS) })
  .strict();

export const createStatusIncidentSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    status: z.enum(STATUS_INCIDENT_STATUSES).default("investigating"),
    impact: z.enum(STATUS_IMPACTS).default("partial_outage"),
    message: z.string().trim().min(1).max(5_000),
    componentIds: z.array(z.uuid()).max(STATUS_PAGE_MAX_COMPONENTS).default([]),
    /* Off keeps it as a draft only the team sees. */
    published: z.boolean().default(true),
  })
  .strict();
export type CreateStatusIncidentInput = z.infer<typeof createStatusIncidentSchema>;

export const updateStatusIncidentSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    impact: z.enum(STATUS_IMPACTS).optional(),
    componentIds: z.array(z.uuid()).max(STATUS_PAGE_MAX_COMPONENTS).optional(),
    published: z.boolean().optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, "nothing to update");

export const postStatusUpdateSchema = z
  .object({
    status: z.enum(STATUS_INCIDENT_STATUSES),
    message: z.string().trim().min(1).max(5_000),
  })
  .strict();
export type PostStatusUpdateInput = z.infer<typeof postStatusUpdateSchema>;

/* The page status a monitor's state stands for. */
export function componentStatusOf(status: MonitorStatus): ComponentStatus {
  switch (status) {
    case "up":
    case "verifying":
      return "operational";
    case "degraded":
      return "degraded";
    case "down":
      return "major_outage";
    case "maintenance":
      return "maintenance";
    case "pending":
    case "paused":
      return "unknown";
  }
}

/* Worst first; "unknown" never outranks a real status. */
const RANK: Record<ComponentStatus, number> = {
  major_outage: 5,
  partial_outage: 4,
  degraded: 3,
  maintenance: 2,
  operational: 1,
  unknown: 0,
};

export function worseStatus(a: ComponentStatus, b: ComponentStatus): ComponentStatus {
  return RANK[b] > RANK[a] ? b : a;
}

export const OVERALL_STATUSES = [
  "operational",
  "degraded",
  "partial_outage",
  "major_outage",
  "maintenance",
] as const;
export type OverallStatus = (typeof OVERALL_STATUSES)[number];

/*
 * One line for the banner. A major outage of every component is a major outage of the page; of
 * some, a partial one. A page with nothing to show is operational.
 */
export function overallStatusOf(statuses: readonly ComponentStatus[]): OverallStatus {
  const known = statuses.filter((s) => s !== "unknown");
  if (known.length === 0) return "operational";
  if (known.every((s) => s === "major_outage")) return "major_outage";
  if (known.some((s) => s === "major_outage" || s === "partial_outage")) return "partial_outage";
  if (known.some((s) => s === "degraded")) return "degraded";
  if (known.some((s) => s === "maintenance")) return "maintenance";
  return "operational";
}

export interface StatusComponentView {
  id: string;
  name: string;
  description: string | null;
  monitorId: string | null;
  manualStatus: (typeof MANUAL_COMPONENT_STATUSES)[number] | null;
  group: string | null;
  showUptime: boolean;
}

export interface StatusPageView {
  id: string;
  name: string;
  slug: string;
  /* Where the page is served. */
  url: string;
  published: boolean;
  branding: StatusBranding;
  settings: StatusPageSettings;
  components: StatusComponentView[];
  customDomain: string | null;
  domainVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StatusUpdateView {
  id: string;
  status: StatusIncidentStatus;
  message: string;
  at: string;
}

export interface StatusIncidentView {
  id: string;
  title: string;
  status: StatusIncidentStatus;
  impact: StatusImpact;
  componentIds: string[];
  published: boolean;
  /* Opened by the page itself because a monitor stayed down. */
  auto: boolean;
  startedAt: string;
  resolvedAt: string | null;
  updates: StatusUpdateView[];
}

export interface PublicUptimeDay {
  date: string;
  /* "none" before the monitor existed. */
  status: "up" | "minor" | "major" | "none";
  uptimePercent: number | null;
}

export interface PublicStatusComponent {
  id: string;
  name: string;
  description: string | null;
  group: string | null;
  status: ComponentStatus;
  /* Null when the component is set by hand or hides its uptime. */
  uptime: { percent: number | null; days: PublicUptimeDay[] } | null;
}

export interface PublicStatusIncident {
  id: string;
  title: string;
  status: StatusIncidentStatus;
  impact: StatusImpact;
  components: string[];
  startedAt: string;
  resolvedAt: string | null;
  updates: StatusUpdateView[];
}

export interface PublicMaintenance {
  id: string;
  name: string;
  /* In effect now. */
  active: boolean;
  startsAt: string | null;
  endsAt: string | null;
  components: string[];
}

/* Everything the public page shows; also the page's JSON API. */
export interface PublicStatusPage {
  page: {
    name: string;
    slug: string;
    url: string;
    branding: StatusBranding;
    /* Visitors can subscribe by email. */
    subscribe: boolean;
    showUptime: boolean;
    /* Where "Powered by Watchpost" links to. */
    poweredByUrl: string;
  };
  status: OverallStatus;
  components: PublicStatusComponent[];
  incidents: { active: PublicStatusIncident[]; recent: PublicStatusIncident[] };
  maintenance: PublicMaintenance[];
  generatedAt: string;
}
