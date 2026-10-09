/*
 * Status pages (PRODUCT.md §6.6): a public page per product with components (linked to monitors or
 * set by hand), 90-day uptime bars, incidents with updates, and scheduled maintenance. The same
 * shapes serve the editor in the app and the public page.
 */
import { z } from "zod";
import type { MonitorStatus } from "../constants/product.js";
import { STATUS_TONES } from "./ai.js";

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
    /* How AI-drafted updates should sound. */
    tone: z.enum(STATUS_TONES).default("neutral"),
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

/*
 * A customer's own host name for a page: at least two labels, letters, digits and hyphens, no
 * scheme, port or path. Lowercased.
 */
/* Who may open a page: everyone, people with the password, or visitors from listed networks. */
export const STATUS_VISIBILITIES = ["public", "password", "ip_allowlist"] as const;
export type StatusVisibility = (typeof STATUS_VISIBILITIES)[number];
export const STATUS_ALLOWED_IPS_MAX = 50;

/* An address or a network in CIDR form, IPv4 or IPv6. The server checks it again, strictly. */
export function looksLikeIpOrCidr(value: string): boolean {
  const [address = "", prefix, ...rest] = value.split("/");
  if (rest.length > 0) return false;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  const isV4 = v4 !== null && v4.slice(1).every((part) => Number(part) <= 255);
  const isV6 = !isV4 && address.includes(":") && /^[0-9a-f:.]{2,45}$/i.test(address);
  if (!isV4 && !isV6) return false;
  if (prefix === undefined) return true;
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= (isV4 ? 32 : 128);
}

export const setStatusAccessSchema = z
  .object({
    visibility: z.enum(STATUS_VISIBILITIES),
    /* A new password; leave out to keep the one the page has. Never sent back. */
    password: z.string().min(8).max(200).optional(),
    allowedIps: z
      .array(
        z
          .string()
          .trim()
          .toLowerCase()
          .max(49)
          .refine(looksLikeIpOrCidr, "must be an IP address or a network like 203.0.113.0/24"),
      )
      .max(STATUS_ALLOWED_IPS_MAX)
      .optional(),
  })
  .strict();
export type SetStatusAccessInput = z.infer<typeof setStatusAccessSchema>;

export const unlockStatusPageSchema = z.object({ password: z.string().min(1).max(200) });

export const customDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])$/,
    "enter a domain like status.yourcompany.com, without https:// or a path",
  );

export const setStatusDomainSchema = z.object({ domain: customDomainSchema.nullable() }).strict();

/* A visitor asks for updates by email; they get nothing until they confirm (double opt-in). */
export const subscribeStatusSchema = z.object({
  /* Tidied first, then checked: " Ada@Example.org " is a fine address once trimmed. */
  email: z.string().trim().toLowerCase().max(320).pipe(z.email()),
});

export interface StatusSubscriberView {
  id: string;
  email: string;
  /* Null until the visitor opened the confirmation link. */
  confirmedAt: string | null;
  createdAt: string;
}

export interface StatusSubscribersView {
  confirmed: number;
  pending: number;
  /* How many confirmed subscribers the plan allows; 0 means the plan has none. */
  limit: number;
  /* The newest ones, confirmed or not. */
  data: StatusSubscriberView[];
}

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
    /* Set when the message started as an AI draft, so the update is recorded as one. */
    aiGenerationId: z.uuid().optional(),
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
    aiGenerationId: z.uuid().optional(),
  })
  .strict();
export type PostStatusUpdateInput = z.infer<typeof postStatusUpdateSchema>;

/*
 * Asks for an AI draft of a public update. `notes` is what the team knows, in their own words; it
 * may name internal systems, which never reach the draft.
 */
export const draftStatusUpdateSchema = z
  .object({
    status: z.enum(STATUS_INCIDENT_STATUSES),
    title: z.string().trim().min(1).max(200),
    impact: z.enum(STATUS_IMPACTS).optional(),
    componentIds: z.array(z.uuid()).max(STATUS_PAGE_MAX_COMPONENTS).default([]),
    notes: z.string().trim().max(2_000).default(""),
    tone: z.enum(STATUS_TONES).optional(),
  })
  .strict();
export type DraftStatusUpdateInput = z.infer<typeof draftStatusUpdateSchema>;

export interface StatusDraftView {
  message: string;
  generationId: string;
}

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
  /* Who may open the page. The password itself is never sent back. */
  visibility: StatusVisibility;
  hasPassword: boolean;
  allowedIps: string[];
  branding: StatusBranding;
  settings: StatusPageSettings;
  components: StatusComponentView[];
  customDomain: string | null;
  /* Set once DNS was seen pointing at us; only then is the domain served and given a certificate. */
  domainVerifiedAt: string | null;
  domainCheckedAt: string | null;
  /* Why the last check didn't pass, in plain words. */
  domainError: string | null;
  /* What the customer's CNAME record must point to; null when this server has none configured. */
  cnameTarget: string | null;
  /* Whether updates can be drafted by AI on this server. */
  aiDrafts: boolean;
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

/* What a visitor without access gets from a private page: enough to show who it belongs to. */
export interface PublicStatusLocked {
  /* What would open it: the page's password, or coming from one of its networks. */
  locked: Exclude<StatusVisibility, "public">;
  page: { name: string; slug: string; url: string; branding: StatusBranding };
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
