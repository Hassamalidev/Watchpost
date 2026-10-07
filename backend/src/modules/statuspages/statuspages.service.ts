/*
 * Status pages (PRODUCT.md §6.6): pages, their components, public incidents with updates, and the
 * snapshot the public page, its JSON and its feeds are built from. A change tells the web app to
 * drop its cached copy, so visitors see it within seconds (§7.10).
 */
import {
  STATUS_PAGE_HISTORY_DAYS,
  STATUS_PAGE_UPTIME_DAYS,
  componentStatusOf,
  overallStatusOf,
  statusBrandingSchema,
  statusPageSettingsSchema,
  worseStatus,
  type ComponentStatus,
  type CreateStatusIncidentInput,
  type CreateStatusPageInput,
  type MaintenanceWindowView,
  type PostStatusUpdateInput,
  type PublicMaintenance,
  type PublicStatusComponent,
  type PublicStatusIncident,
  type PublicStatusPage,
  type StatusComponentInput,
  type StatusComponentView,
  type StatusIncidentView,
  type StatusPageView,
  type StatusSubscribersView,
  type UpdateStatusPageInput,
} from "@app/shared";
import type { z } from "zod";
import type { updateStatusIncidentSchema } from "@app/shared";
import type { Clock } from "../../core/clock.js";
import {
  ConflictError,
  NotFoundError,
  ProviderError,
  QuotaExceededError,
  ValidationError,
} from "../../core/errors.js";
import { createWorkspaceScope, type WorkspaceScope } from "../../core/workspace-scope.js";
import type { PlanFeatures, PlanLimits } from "../../config/plans.js";
import type { Db, DbOrTx, Tx } from "../../infra/db/index.js";
import type { Logger } from "../../infra/logger.js";
import type { Outbox } from "../../infra/outbox/index.js";
import type { DetectionService } from "../detection/index.js";
import type { MaintenanceService } from "../maintenance/index.js";
import type { MonitorsService } from "../monitors/index.js";
import { createHash, randomBytes } from "node:crypto";
import type { DnsLookup } from "../../infra/dns.js";
import { checkDomain, isSameOrSubdomain } from "./domains.js";
import { renderAtom, renderRss } from "./feeds.js";
import type { StatuspagesRepository } from "./statuspages.repository.js";
import type {
  StatusComponentRow,
  StatusIncidentRow,
  StatusPageRow,
  StatusSubscriberRow,
  StatusUpdateRow,
} from "./schema/statuspages.js";

type UpdateStatusIncidentInput = z.infer<typeof updateStatusIncidentSchema>;

/* How a page is looked up from outside: its subdomain, or the host name of a custom domain. */
export type PublicRef = { slug: string } | { host: string };

/* How far ahead scheduled maintenance is announced on a page. */
const MAINTENANCE_AHEAD_DAYS = 14;
const DAY_MS = 86_400_000;
const MAX_PAGE_INCIDENTS = 50;
/* A second request for the confirmation email is ignored for this long. */
const CONFIRM_RESEND_MS = 5 * 60_000;
const SUBSCRIBER_LIST_MAX = 200;
const FANOUT_BATCH = 200;
const AUTO_INCIDENT_PAGES = 500;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");

/* What happened to a link from a subscriber email, and where to send the visitor next. */
export type SubscriptionOutcome =
  { ok: true; pageUrl: string; pageName: string } | { ok: false; reason: "invalid" | "full" };

/* How long a verified domain may point elsewhere before it stops being served. */
export const DOMAIN_GRACE_DAYS = 7;
const DOMAIN_SWEEP_BATCH = 50;

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
};

export const statusPageTag = (slug: string) => `status-page:${slug}`;

export interface StatuspagesService {
  list(scope: WorkspaceScope): Promise<StatusPageView[]>;
  get(scope: WorkspaceScope, id: string): Promise<StatusPageView>;
  create(scope: WorkspaceScope, input: CreateStatusPageInput): Promise<StatusPageView>;
  update(scope: WorkspaceScope, id: string, input: UpdateStatusPageInput): Promise<StatusPageView>;
  delete(scope: WorkspaceScope, id: string): Promise<void>;
  /* Replaces the page's ordered component list. */
  replaceComponents(
    scope: WorkspaceScope,
    id: string,
    components: StatusComponentInput[],
  ): Promise<StatusPageView>;
  /* The page as visitors would see it now, published or not (for the editor's preview). */
  preview(scope: WorkspaceScope, id: string): Promise<PublicStatusPage>;
  listIncidents(scope: WorkspaceScope, pageId: string): Promise<StatusIncidentView[]>;
  createIncident(
    scope: WorkspaceScope,
    pageId: string,
    input: CreateStatusIncidentInput,
  ): Promise<StatusIncidentView>;
  updateIncident(
    scope: WorkspaceScope,
    pageId: string,
    incidentId: string,
    input: UpdateStatusIncidentInput,
  ): Promise<StatusIncidentView>;
  postUpdate(
    scope: WorkspaceScope,
    pageId: string,
    incidentId: string,
    input: PostStatusUpdateInput,
  ): Promise<StatusIncidentView>;
  deleteIncident(scope: WorkspaceScope, pageId: string, incidentId: string): Promise<void>;
  /*
   * Puts the page on the customer's own domain (null removes it). The domain serves nothing until
   * DNS is seen pointing at us.
   */
  setDomain(scope: WorkspaceScope, id: string, domain: string | null): Promise<StatusPageView>;
  /* Looks at DNS now and says what it found. */
  verifyDomain(scope: WorkspaceScope, id: string): Promise<StatusPageView>;
  /* System (Caddy asks before getting a certificate): only verified domains of published pages. */
  servesHost(host: string): Promise<boolean>;
  /* System (sweep): looks at the domains that are due. Returns how many were looked at. */
  checkDomains(): Promise<number>;
  /* Who asked for the page's updates by email, and how many the plan allows. */
  subscribers(scope: WorkspaceScope, pageId: string): Promise<StatusSubscribersView>;
  removeSubscriber(scope: WorkspaceScope, pageId: string, subscriberId: string): Promise<void>;
  /*
   * Public: a visitor asks for updates. Sends a confirmation email (double opt-in). Answers the
   * page's address, or undefined when the page doesn't exist or doesn't take subscribers; it never
   * says whether the address was already known.
   */
  subscribe(
    ref: PublicRef,
    email: string,
  ): Promise<{ pageUrl: string; addresses: string[] } | undefined>;
  /* Public: the link in the confirmation email. */
  confirmSubscription(token: string): Promise<SubscriptionOutcome>;
  /* Public: the unsubscribe link in every email; works once, whoever opens it. */
  unsubscribe(token: string): Promise<SubscriptionOutcome>;
  /* System (events): emails an update to the page's confirmed subscribers. Returns how many. */
  notifySubscribers(updateId: string): Promise<number>;
  /*
   * System (sweep and events): opens a page incident for a monitor that has been down longer than
   * the page allows, and resolves it when the monitor is no longer down. `monitorId` limits the look
   * to pages that show that monitor. Returns what it did.
   */
  autoIncidents(monitorId?: string): Promise<{ opened: number; resolved: number }>;
  /* Public: what a published page shows; undefined when there is no such page. */
  publicPage(ref: PublicRef): Promise<PublicStatusPage | undefined>;
  publicFeed(ref: PublicRef, format: "rss" | "atom"): Promise<string | undefined>;
  /* System (events): the pages showing this monitor are refreshed. Returns how many. */
  onMonitorChanged(monitorId: string): Promise<number>;
  /* System (events): a deleted monitor's components stay, set by hand from now on. */
  onMonitorDeleted(monitorId: string): Promise<number>;
  /* System (events): an update went out on this page. */
  onUpdatePublished(statusPageId: string): Promise<void>;
}

export interface StatuspagesServiceDeps {
  db: Db;
  repository: StatuspagesRepository;
  monitors: Pick<MonitorsService, "get" | "getForDetection">;
  detection: Pick<DetectionService, "states" | "uptimeDays" | "uptime">;
  maintenance: Pick<MaintenanceService, "list">;
  /* What the workspace's plan allows; optional so tests can build the service without billing. */
  plan?:
    | ((scope: WorkspaceScope) => Promise<{ limits: PlanLimits; features: PlanFeatures }>)
    | undefined;
  /* Tells the web app to drop cached pages with these tags. Never throws. */
  revalidate: (tags: string[]) => Promise<void>;
  outbox: Outbox;
  clock: Clock;
  logger: Logger;
  newId: () => string;
  webOrigin: string;
  /* Pages are served at <slug>.<baseDomain> when set, else at <webOrigin>/s/<slug>. */
  baseDomain: string | undefined;
  /* What customers point their own domain at; without it custom domains are off. */
  cnameTarget?: string | undefined;
  dns?: DnsLookup | undefined;
}

export function createStatuspagesService(deps: StatuspagesServiceDeps): StatuspagesService {
  const { repository: repo, clock } = deps;
  const system = (workspaceId: string) => createWorkspaceScope({ workspaceId });

  const urlOf = (page: Pick<StatusPageRow, "slug" | "customDomain" | "domainVerifiedAt">) =>
    page.customDomain !== null && page.domainVerifiedAt !== null
      ? `https://${page.customDomain}`
      : deps.baseDomain === undefined
        ? `${deps.webOrigin}/s/${page.slug}`
        : `https://${page.slug}.${deps.baseDomain}`;

  const toComponent = (row: StatusComponentRow): StatusComponentView => ({
    id: row.id,
    name: row.name,
    description: row.description,
    monitorId: row.monitorId,
    manualStatus: row.manualStatus,
    group: row.groupName,
    showUptime: row.showUptime,
  });

  const toPage = (row: StatusPageRow, components: StatusComponentRow[]): StatusPageView => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    url: urlOf(row),
    published: row.published,
    /* Parsed again so a page saved before a field existed still has every field. */
    branding: statusBrandingSchema.parse(row.branding),
    settings: statusPageSettingsSchema.parse(row.settings),
    components: components.filter((c) => c.pageId === row.id).map(toComponent),
    customDomain: row.customDomain,
    domainVerifiedAt: row.domainVerifiedAt?.toISOString() ?? null,
    domainCheckedAt: row.domainCheckedAt?.toISOString() ?? null,
    domainError: row.domainError,
    cnameTarget: deps.cnameTarget ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });

  const toIncident = (row: StatusIncidentRow, updates: StatusUpdateRow[]): StatusIncidentView => ({
    id: row.id,
    title: row.title,
    status: row.status,
    impact: row.impact,
    componentIds: row.componentIds,
    published: row.published,
    auto: row.autoMonitorId !== null,
    startedAt: row.startedAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    updates: updates
      .filter((u) => u.statusIncidentId === row.id)
      .map((u) => ({
        id: u.id,
        status: u.status,
        message: u.body,
        at: u.createdAt.toISOString(),
      })),
  });

  async function mustFindPage(tx: DbOrTx, scope: WorkspaceScope, id: string) {
    const row = await repo.findPage(tx, scope, id);
    if (row === undefined) throw new NotFoundError("Status page not found.");
    return row;
  }

  async function viewOf(tx: DbOrTx, row: StatusPageRow): Promise<StatusPageView> {
    return toPage(row, await repo.componentsOf(tx, [row.id]));
  }

  /* The web app caches a page under its address and, when it has one, under its own domain. */
  async function refresh(
    ...pages: Array<Pick<StatusPageRow, "slug" | "customDomain">>
  ): Promise<void> {
    const refs = pages.flatMap((p) =>
      p.customDomain === null ? [p.slug] : [p.slug, p.customDomain],
    );
    await deps.revalidate([...new Set(refs)].map(statusPageTag));
  }

  /*
   * One DNS look at a page's domain, and what it means for the page. `concluded` is false when DNS
   * couldn't be asked: then nothing changes and the page is looked at again soon.
   */
  async function lookAtDomain(
    page: StatusPageRow,
  ): Promise<{ page: StatusPageRow; concluded: boolean }> {
    const target = deps.cnameTarget;
    if (page.customDomain === null || target === undefined || deps.dns === undefined) {
      return { page, concluded: false };
    }
    const now = clock.now();
    const result = await checkDomain(deps.dns, page.customDomain, target);
    if (result.ok === null) return { page, concluded: false };
    const failingSince = result.ok ? null : (page.domainFailingSince ?? now);
    /* A verified domain survives a short DNS mistake; a week of pointing elsewhere ends it. */
    const stillVerified =
      page.domainVerifiedAt !== null &&
      now.getTime() - (failingSince ?? now).getTime() < DOMAIN_GRACE_DAYS * DAY_MS;
    const row = await repo.recordDomainCheck(page.id, {
      domainCheckedAt: now,
      domainError: result.ok ? null : result.reason,
      domainFailingSince: failingSince,
      domainVerifiedAt: result.ok
        ? (page.domainVerifiedAt ?? now)
        : stillVerified
          ? page.domainVerifiedAt
          : null,
    });
    const after = row ?? page;
    if ((after.domainVerifiedAt === null) !== (page.domainVerifiedAt === null)) {
      deps.logger.info(
        {
          statusPageId: page.id,
          domain: page.customDomain,
          verified: after.domainVerifiedAt !== null,
        },
        "custom domain verification changed",
      );
      await refresh(after);
    }
    return { page: after, concluded: true };
  }

  /* A domain a customer may use: not ours, and not one that could shadow our own hosts. */
  function checkOwnDomains(domain: string) {
    const ours = [deps.baseDomain, deps.cnameTarget, hostOf(deps.webOrigin), "localhost"].filter(
      (h): h is string => h !== undefined,
    );
    if (ours.some((host) => isSameOrSubdomain(domain, host) || isSameOrSubdomain(host, domain))) {
      throw new ValidationError("That domain can't be used for a status page.", [
        { path: "body.domain", message: "use a domain of your own" },
      ]);
    }
  }

  /* How many confirmed subscribers the workspace's plan allows per page. */
  async function subscriberLimit(workspaceId: string): Promise<number> {
    if (deps.plan === undefined) return Number.MAX_SAFE_INTEGER;
    return (await deps.plan(system(workspaceId))).limits.statusSubscribers;
  }

  const subscriptionLink = (action: "confirm" | "unsubscribe", token: string) =>
    `${deps.webOrigin}/api/public/status-subscriptions/${action}?token=${encodeURIComponent(token)}`;

  /* Queues the confirmation email in the caller's transaction, with a fresh single-use token. */
  async function sendConfirmation(tx: Tx, page: StatusPageRow, subscriber: StatusSubscriberRow) {
    const token = newToken();
    await repo.updateSubscriber(tx, subscriber.id, {
      confirmTokenHash: sha256(token),
      confirmSentAt: clock.now(),
    });
    await deps.outbox.emit(
      tx,
      "email.requested",
      {
        template: "status-confirm",
        to: subscriber.email,
        data: {
          pageName: page.name,
          pageUrl: urlOf(page),
          url: subscriptionLink("confirm", token),
        },
      },
      { workspaceId: page.workspaceId },
    );
  }

  /* What a page says by itself when a service stays down, and when it is back. */
  const autoText = (name: string) => ({
    title: `${name} is unavailable`,
    opened: `We have detected that ${name} is not responding and are looking into it.`,
    resolved: `${name} is responding normally again.`,
  });

  /* Monitors of this workspace among `ids`; anything else is refused by name. */
  async function checkMonitors(scope: WorkspaceScope, ids: string[], path: string) {
    const unique = [...new Set(ids)];
    const found = (await deps.monitors.getForDetection(unique)).filter(
      (m) => m.workspaceId === scope.workspaceId,
    );
    if (found.length !== unique.length) {
      throw new ValidationError("A monitor on the page doesn't exist.", [
        { path, message: "not found" },
      ]);
    }
  }

  /* What the page shows right now. `publishedOnly` leaves drafts out (the public view). */
  async function snapshot(page: StatusPageRow, publishedOnly: boolean): Promise<PublicStatusPage> {
    const scope = system(page.workspaceId);
    const now = clock.now();
    const settings = statusPageSettingsSchema.parse(page.settings);
    const components = await repo.componentsOf(deps.db, [page.id]);
    const monitorIds = [
      ...new Set(components.flatMap((c) => (c.monitorId === null ? [] : [c.monitorId]))),
    ];
    const monitors = new Map(
      (await deps.monitors.getForDetection(monitorIds))
        .filter((m) => m.workspaceId === page.workspaceId)
        .map((m) => [m.id, m]),
    );
    const states = new Map(
      monitorIds.length === 0
        ? []
        : (await deps.detection.states(scope)).map((s) => [s.monitorId, s.status]),
    );

    const rows = await repo.incidentsOf(deps.db, page.id, {
      since: new Date(now.getTime() - STATUS_PAGE_HISTORY_DAYS * DAY_MS),
      publishedOnly,
      limit: MAX_PAGE_INCIDENTS,
    });
    const updates = await repo.updatesOf(
      deps.db,
      rows.map((r) => r.id),
    );
    const names = new Map(components.map((c) => [c.id, c.name]));
    const toPublic = (row: StatusIncidentRow): PublicStatusIncident => {
      const view = toIncident(row, updates);
      return {
        id: view.id,
        title: view.title,
        status: view.status,
        impact: view.impact,
        components: view.componentIds.flatMap((id) => names.get(id) ?? []),
        startedAt: view.startedAt,
        resolvedAt: view.resolvedAt,
        updates: view.updates,
      };
    };
    const open = rows.filter((r) => r.resolvedAt === null && r.published);

    const publicComponents: PublicStatusComponent[] = [];
    for (const c of components) {
      const monitor = c.monitorId === null ? undefined : monitors.get(c.monitorId);
      let status: ComponentStatus =
        c.monitorId === null
          ? (c.manualStatus ?? "operational")
          : monitor === undefined || monitor.paused
            ? "unknown"
            : componentStatusOf(states.get(monitor.id) ?? "pending");
      /* An open incident that names the component shows at least its impact. */
      for (const incident of open) {
        if (incident.componentIds.includes(c.id)) status = worseStatus(status, incident.impact);
      }
      let uptime: PublicStatusComponent["uptime"] = null;
      if (settings.showUptime && c.showUptime && monitor !== undefined) {
        const days = await deps.detection.uptimeDays(scope, monitor.id, {
          days: STATUS_PAGE_UPTIME_DAYS,
          excludeMaintenance: true,
        });
        const total = await deps.detection.uptime(scope, monitor.id, {
          from: new Date(now.getTime() - STATUS_PAGE_UPTIME_DAYS * DAY_MS),
          to: now,
          excludeMaintenance: true,
        });
        uptime = {
          percent: total.uptimePercent,
          days: days.map((d) => ({
            date: d.date,
            status: d.status,
            uptimePercent: d.uptimePercent,
          })),
        };
      }
      publicComponents.push({
        id: c.id,
        name: c.name,
        description: c.description,
        group: c.groupName,
        status,
        uptime,
      });
    }

    return {
      page: {
        name: page.name,
        slug: page.slug,
        url: urlOf(page),
        branding: statusBrandingSchema.parse(page.branding),
        subscribe: settings.subscribers && (await subscriberLimit(page.workspaceId)) > 0,
        showUptime: settings.showUptime,
        poweredByUrl: deps.webOrigin,
      },
      status: overallStatusOf(publicComponents.map((c) => c.status)),
      components: publicComponents,
      incidents: {
        active: rows.filter((r) => r.resolvedAt === null).map(toPublic),
        recent: rows.filter((r) => r.resolvedAt !== null).map(toPublic),
      },
      maintenance:
        monitorIds.length === 0
          ? []
          : maintenanceFor(await deps.maintenance.list(scope), components, now),
      generatedAt: now.toISOString(),
    };
  }

  /* Windows shown on pages that are in effect or start soon, for the page's own monitors. */
  function maintenanceFor(
    windows: MaintenanceWindowView[],
    components: StatusComponentRow[],
    now: Date,
  ): PublicMaintenance[] {
    const horizon = now.getTime() + MAINTENANCE_AHEAD_DAYS * DAY_MS;
    const result: PublicMaintenance[] = [];
    for (const w of windows) {
      if (!w.showOnPages || w.over) continue;
      const affected = components.filter(
        (c) =>
          c.monitorId !== null && ("all" in w.scope || w.scope.monitorIds.includes(c.monitorId)),
      );
      if (affected.length === 0) continue;
      const length = Date.parse(w.endsAt) - Date.parse(w.startsAt);
      if (w.active) {
        result.push({
          id: w.id,
          name: w.name,
          active: true,
          startsAt: null,
          endsAt: w.activeUntil,
          components: affected.map((c) => c.name),
        });
      } else if (w.nextStart !== null && Date.parse(w.nextStart) <= horizon) {
        result.push({
          id: w.id,
          name: w.name,
          active: false,
          startsAt: w.nextStart,
          endsAt: new Date(Date.parse(w.nextStart) + length).toISOString(),
          components: affected.map((c) => c.name),
        });
      }
    }
    return result.sort(
      (a, b) =>
        Number(b.active) - Number(a.active) ||
        Date.parse(a.startsAt ?? a.endsAt ?? "") - Date.parse(b.startsAt ?? b.endsAt ?? ""),
    );
  }

  async function incidentView(tx: DbOrTx, row: StatusIncidentRow): Promise<StatusIncidentView> {
    return toIncident(row, await repo.updatesOf(tx, [row.id]));
  }

  async function mustFindIncident(
    tx: DbOrTx,
    scope: WorkspaceScope,
    pageId: string,
    incidentId: string,
    lock = false,
  ) {
    const row = await repo.findIncident(tx, scope, incidentId, lock);
    if (row === undefined || row.pageId !== pageId) {
      throw new NotFoundError("Status page incident not found.");
    }
    return row;
  }

  /* Component IDs that belong to the page; anything else is refused. */
  async function checkComponents(tx: DbOrTx, pageId: string, ids: string[]): Promise<string[]> {
    const unique = [...new Set(ids)];
    const own = new Set((await repo.componentsOf(tx, [pageId])).map((c) => c.id));
    if (unique.some((id) => !own.has(id))) {
      throw new ValidationError("A component isn't on this page.", [
        { path: "body.componentIds", message: "not on this page" },
      ]);
    }
    return unique;
  }

  const service: StatuspagesService = {
    async list(scope) {
      const pages = await repo.listPages(scope);
      const components = await repo.componentsOf(
        deps.db,
        pages.map((p) => p.id),
      );
      return pages.map((p) => toPage(p, components));
    },

    async get(scope, id) {
      return viewOf(deps.db, await mustFindPage(deps.db, scope, id));
    },

    async create(scope, input) {
      const monitorIds = [...new Set(input.monitorIds ?? [])];
      await checkMonitors(scope, monitorIds, "body.monitorIds");
      const names = new Map<string, string>();
      for (const id of monitorIds) {
        const monitor = await deps.monitors.get(scope, id);
        names.set(id, monitor.publicName ?? monitor.name);
      }
      const page = await deps.db.transaction(async (tx) => {
        const limit = (await deps.plan?.(scope))?.limits.statusPages;
        if (limit !== undefined && (await repo.countPages(tx, scope)) >= limit) {
          throw new QuotaExceededError(
            `Your plan allows ${limit} status page${limit === 1 ? "" : "s"}. Upgrade to add more.`,
          );
        }
        const created = await repo.insertPage(tx, scope, {
          id: deps.newId(),
          name: input.name,
          slug: input.slug,
          branding: statusBrandingSchema.parse(input.branding ?? {}),
          settings: statusPageSettingsSchema.parse(input.settings ?? {}),
          published: input.published,
        });
        if (created === undefined) {
          throw new ConflictError(`The address "${input.slug}" is taken. Choose another.`);
        }
        await repo.insertComponents(
          tx,
          scope,
          created.id,
          monitorIds.map((monitorId, position) => ({
            id: deps.newId(),
            name: names.get(monitorId) ?? "Service",
            description: null,
            monitorId,
            manualStatus: null,
            groupName: null,
            showUptime: true,
            position,
          })),
        );
        return viewOf(tx, created);
      });
      await refresh(page);
      return page;
    },

    async update(scope, id, input) {
      const before = await mustFindPage(deps.db, scope, id);
      let row: StatusPageRow | undefined;
      try {
        row = await repo.updatePage(deps.db, scope, id, {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.slug === undefined ? {} : { slug: input.slug }),
          ...(input.branding === undefined ? {} : { branding: input.branding }),
          ...(input.settings === undefined ? {} : { settings: input.settings }),
          ...(input.published === undefined ? {} : { published: input.published }),
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictError(`The address "${input.slug}" is taken. Choose another.`);
        }
        throw err;
      }
      if (row === undefined) throw new NotFoundError("Status page not found.");
      await refresh(before, row);
      return viewOf(deps.db, row);
    },

    async delete(scope, id) {
      const page = await mustFindPage(deps.db, scope, id);
      await repo.deletePage(scope, id);
      await refresh(page);
    },

    async replaceComponents(scope, id, components) {
      await checkMonitors(
        scope,
        components.flatMap((c) => (c.monitorId === null ? [] : [c.monitorId])),
        "body.components",
      );
      const { page, view } = await deps.db.transaction(async (tx) => {
        const row = await mustFindPage(tx, scope, id);
        const current = await repo.componentsOf(tx, [id]);
        const known = new Set(current.map((c) => c.id));
        const kept = new Set<string>();
        const fresh: Parameters<StatuspagesRepository["insertComponents"]>[3] = [];
        for (const [position, c] of components.entries()) {
          const values = {
            name: c.name,
            description: c.description,
            monitorId: c.monitorId,
            /* A linked component follows its monitor; one set by hand starts as operational. */
            manualStatus: c.monitorId === null ? (c.manualStatus ?? "operational") : null,
            groupName: c.group,
            showUptime: c.showUptime,
            position,
          };
          if (c.id !== undefined && known.has(c.id) && !kept.has(c.id)) {
            kept.add(c.id);
            await repo.updateComponent(tx, scope, c.id, values);
          } else if (c.id !== undefined && !known.has(c.id)) {
            throw new ValidationError("A component isn't on this page.", [
              { path: `body.components.${position}.id`, message: "not on this page" },
            ]);
          } else {
            fresh.push({ id: deps.newId(), ...values });
          }
        }
        await repo.deleteComponents(
          tx,
          scope,
          current.filter((c) => !kept.has(c.id)).map((c) => c.id),
        );
        await repo.insertComponents(tx, scope, id, fresh);
        return { page: row, view: await viewOf(tx, row) };
      });
      await refresh(page);
      return view;
    },

    async preview(scope, id) {
      return snapshot(await mustFindPage(deps.db, scope, id), false);
    },

    async listIncidents(scope, pageId) {
      await mustFindPage(deps.db, scope, pageId);
      const rows = await repo.incidentsOf(deps.db, pageId, {
        since: new Date(clock.now().getTime() - 90 * DAY_MS),
        publishedOnly: false,
        limit: MAX_PAGE_INCIDENTS,
      });
      const updates = await repo.updatesOf(
        deps.db,
        rows.map((r) => r.id),
      );
      return rows.map((r) => toIncident(r, updates));
    },

    async createIncident(scope, pageId, input) {
      const { page, view } = await deps.db.transaction(async (tx) => {
        const row = await mustFindPage(tx, scope, pageId);
        const now = clock.now();
        const incident = await repo.insertIncident(tx, scope, {
          id: deps.newId(),
          pageId,
          title: input.title,
          status: input.status,
          impact: input.impact,
          componentIds: await checkComponents(tx, pageId, input.componentIds),
          published: input.published,
          autoMonitorId: null,
          startedAt: now,
          resolvedAt: input.status === "resolved" ? now : null,
          createdBy: scope.actorUserId ?? null,
        });
        if (incident === undefined) throw new Error("status incident insert returned nothing");
        const update = await repo.insertUpdate(tx, scope, {
          id: deps.newId(),
          statusIncidentId: incident.id,
          status: input.status,
          body: input.message,
          aiDrafted: false,
          createdBy: scope.actorUserId ?? null,
          createdAt: now,
        });
        if (incident.published) {
          await deps.outbox.emit(
            tx,
            "status_page.update_published",
            { statusPageId: pageId, statusIncidentId: incident.id, updateId: update.id },
            { workspaceId: scope.workspaceId },
          );
        }
        return { page: row, view: await incidentView(tx, incident) };
      });
      await refresh(page);
      return view;
    },

    async updateIncident(scope, pageId, incidentId, input) {
      const { page, view } = await deps.db.transaction(async (tx) => {
        const row = await mustFindPage(tx, scope, pageId);
        const before = await mustFindIncident(tx, scope, pageId, incidentId, true);
        const incident = await repo.updateIncident(tx, scope, incidentId, {
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.impact === undefined ? {} : { impact: input.impact }),
          ...(input.published === undefined ? {} : { published: input.published }),
          ...(input.componentIds === undefined
            ? {}
            : { componentIds: await checkComponents(tx, pageId, input.componentIds) }),
        });
        if (incident === undefined) throw new NotFoundError("Status page incident not found.");
        /*
         * A draft that goes public is announced with its latest update, dated now: that is when
         * the public first sees it, and everyone subscribed by now hears about it.
         */
        if (!before.published && incident.published) {
          const [latest] = await repo.updatesOf(tx, [incident.id]);
          if (latest !== undefined) {
            await repo.redateUpdate(tx, latest.id, clock.now());
            await deps.outbox.emit(
              tx,
              "status_page.update_published",
              { statusPageId: pageId, statusIncidentId: incident.id, updateId: latest.id },
              { workspaceId: scope.workspaceId },
            );
          }
        }
        return { page: row, view: await incidentView(tx, incident) };
      });
      await refresh(page);
      return view;
    },

    async postUpdate(scope, pageId, incidentId, input) {
      const { page, view } = await deps.db.transaction(async (tx) => {
        const row = await mustFindPage(tx, scope, pageId);
        const before = await mustFindIncident(tx, scope, pageId, incidentId, true);
        const now = clock.now();
        const update = await repo.insertUpdate(tx, scope, {
          id: deps.newId(),
          statusIncidentId: incidentId,
          status: input.status,
          body: input.message,
          aiDrafted: false,
          createdBy: scope.actorUserId ?? null,
          createdAt: now,
        });
        const incident = await repo.updateIncident(tx, scope, incidentId, {
          status: input.status,
          /* "Resolved" closes it; any other status on a closed incident opens it again. */
          resolvedAt: input.status === "resolved" ? (before.resolvedAt ?? now) : null,
        });
        if (incident === undefined) throw new NotFoundError("Status page incident not found.");
        if (incident.published) {
          await deps.outbox.emit(
            tx,
            "status_page.update_published",
            { statusPageId: pageId, statusIncidentId: incidentId, updateId: update.id },
            { workspaceId: scope.workspaceId },
          );
        }
        return { page: row, view: await incidentView(tx, incident) };
      });
      await refresh(page);
      return view;
    },

    async deleteIncident(scope, pageId, incidentId) {
      const page = await mustFindPage(deps.db, scope, pageId);
      await mustFindIncident(deps.db, scope, pageId, incidentId);
      await repo.deleteIncident(scope, incidentId);
      await refresh(page);
    },

    async setDomain(scope, id, domain) {
      const before = await mustFindPage(deps.db, scope, id);
      if (domain !== null) {
        if (deps.cnameTarget === undefined) {
          throw new ConflictError("Custom domains aren't set up on this server.");
        }
        const plan = await deps.plan?.(scope);
        if (plan !== undefined && !plan.features.customStatusDomain) {
          throw new QuotaExceededError(
            "Custom domains are part of the Starter plan and up. Upgrade to use your own domain.",
          );
        }
        checkOwnDomains(domain);
      }
      if (domain === before.customDomain) return viewOf(deps.db, before);
      let row: StatusPageRow | undefined;
      try {
        /* A new domain starts unverified, whatever the old one was. */
        row = await repo.updatePage(deps.db, scope, id, {
          customDomain: domain,
          domainVerifiedAt: null,
          domainCheckedAt: null,
          domainError: null,
          domainFailingSince: null,
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictError("Another status page already uses that domain.");
        }
        throw err;
      }
      if (row === undefined) throw new NotFoundError("Status page not found.");
      await refresh(before, row);
      return viewOf(deps.db, row);
    },

    async verifyDomain(scope, id) {
      const page = await mustFindPage(deps.db, scope, id);
      if (page.customDomain === null) {
        throw new ConflictError("This page has no custom domain to check.");
      }
      const looked = await lookAtDomain(page);
      if (!looked.concluded) {
        throw new ProviderError("dns", "DNS couldn't be checked just now. Try again in a minute.");
      }
      return viewOf(deps.db, looked.page);
    },

    servesHost: (host) => repo.servesHost(host.trim().toLowerCase()),

    async checkDomains() {
      const due = await repo.domainsDue(clock.now(), DOMAIN_SWEEP_BATCH);
      for (const page of due) await lookAtDomain(page);
      return due.length;
    },

    async subscribers(scope, pageId) {
      await mustFindPage(deps.db, scope, pageId);
      const [counts, rows, limit] = await Promise.all([
        repo.countSubscribers(deps.db, pageId),
        repo.listSubscribers(scope, pageId, SUBSCRIBER_LIST_MAX),
        subscriberLimit(scope.workspaceId),
      ]);
      return {
        ...counts,
        limit,
        data: rows.map((r) => ({
          id: r.id,
          email: r.email,
          confirmedAt: r.confirmedAt?.toISOString() ?? null,
          createdAt: r.createdAt.toISOString(),
        })),
      };
    },

    async removeSubscriber(scope, pageId, subscriberId) {
      await mustFindPage(deps.db, scope, pageId);
      if (!(await repo.deleteSubscriber(scope, pageId, subscriberId))) {
        throw new NotFoundError("Subscriber not found.");
      }
    },

    async subscribe(ref, email) {
      const page = await repo.findPublished(ref);
      if (page === undefined) return undefined;
      const settings = statusPageSettingsSchema.parse(page.settings);
      const limit = await subscriberLimit(page.workspaceId);
      if (!settings.subscribers || limit <= 0) return undefined;
      await deps.db.transaction(async (tx) => {
        const existing = await repo.findSubscriber(tx, page.id, email);
        /* Already subscribed: nothing to do, and nothing to tell whoever is asking. */
        if (existing?.confirmedAt != null) return;
        if (existing !== undefined) {
          const sentAt = existing.confirmSentAt?.getTime() ?? 0;
          if (clock.now().getTime() - sentAt < CONFIRM_RESEND_MS) return;
          await sendConfirmation(tx, page, existing);
          return;
        }
        /* A full list takes no new names; the visitor still gets the same answer. */
        const { confirmed, pending } = await repo.countSubscribers(tx, page.id);
        if (confirmed + pending >= limit) return;
        const created = await repo.insertSubscriber(tx, {
          id: deps.newId(),
          pageId: page.id,
          workspaceId: page.workspaceId,
          email,
          unsubToken: newToken(),
        });
        if (created !== undefined) await sendConfirmation(tx, page, created);
      });
      /* Every address the page answers at, the main one first. */
      const addresses = [
        urlOf(page),
        `${deps.webOrigin}/s/${page.slug}`,
        ...(deps.baseDomain === undefined ? [] : [`https://${page.slug}.${deps.baseDomain}`]),
      ];
      return { pageUrl: urlOf(page), addresses: [...new Set(addresses)] };
    },

    async confirmSubscription(token) {
      return deps.db.transaction(async (tx): Promise<SubscriptionOutcome> => {
        const subscriber = await repo.subscriberByConfirmHash(tx, sha256(token));
        if (subscriber === undefined) return { ok: false, reason: "invalid" };
        const [page] = await repo.pagesByIds([subscriber.pageId]);
        if (page === undefined) return { ok: false, reason: "invalid" };
        const { confirmed } = await repo.countSubscribers(tx, page.id);
        if (confirmed >= (await subscriberLimit(page.workspaceId))) {
          return { ok: false, reason: "full" };
        }
        await repo.updateSubscriber(tx, subscriber.id, {
          confirmedAt: clock.now(),
          confirmTokenHash: null,
        });
        return { ok: true, pageUrl: urlOf(page), pageName: page.name };
      });
    },

    async unsubscribe(token) {
      const removed = await repo.deleteSubscriberByToken(token);
      if (removed === undefined) return { ok: false, reason: "invalid" };
      const [page] = await repo.pagesByIds([removed.pageId]);
      if (page === undefined) return { ok: false, reason: "invalid" };
      return { ok: true, pageUrl: urlOf(page), pageName: page.name };
    },

    async notifySubscribers(updateId) {
      const found = await repo.findUpdate(updateId);
      if (found === undefined || !found.incident.published) return 0;
      const { update, incident } = found;
      const [page] = await repo.pagesByIds([incident.pageId]);
      if (page === undefined || !page.published) return 0;
      const names = new Map(
        (await repo.componentsOf(deps.db, [page.id])).map((c) => [c.id, c.name]),
      );
      const data = {
        pageName: page.name,
        pageUrl: urlOf(page),
        title: incident.title,
        status: update.status,
        message: update.body,
        components: incident.componentIds.flatMap((id) => names.get(id) ?? []),
      };
      let sent = 0;
      let afterId: string | undefined;
      for (;;) {
        const batch = await repo.confirmedSubscribers(
          deps.db,
          page.id,
          update.createdAt,
          afterId,
          FANOUT_BATCH,
        );
        if (batch.length === 0) break;
        afterId = batch.at(-1)?.id;
        /* The claim and the emails commit together, so a retry sends to nobody twice. */
        sent += await deps.db.transaction(async (tx) => {
          const fresh = new Set(
            await repo.claimNotifications(
              tx,
              page.workspaceId,
              update.id,
              batch.map((s) => s.id),
            ),
          );
          for (const subscriber of batch) {
            if (!fresh.has(subscriber.id)) continue;
            const unsubscribeUrl = subscriptionLink("unsubscribe", subscriber.unsubToken);
            await deps.outbox.emit(
              tx,
              "email.requested",
              {
                template: "status-update",
                to: subscriber.email,
                data: { ...data, unsubscribeUrl },
                idempotencyKey: `status-update.${update.id}.${subscriber.id}`,
                headers: {
                  "List-Unsubscribe": `<${unsubscribeUrl}>`,
                  "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
                },
              },
              { workspaceId: page.workspaceId },
            );
          }
          return fresh.size;
        });
        if (batch.length < FANOUT_BATCH) break;
      }
      return sent;
    },

    async autoIncidents(monitorId) {
      const pages =
        monitorId === undefined
          ? await repo.pagesWithAutoIncidents(AUTO_INCIDENT_PAGES)
          : (
              await repo.pagesByIds([
                ...new Set((await repo.componentsForMonitors([monitorId])).map((c) => c.pageId)),
              ])
            ).filter((p) => p.published);
      const result = { opened: 0, resolved: 0 };
      const statesOf = new Map<string, Map<string, { status: string; since: string }>>();
      for (const page of pages) {
        const settings = statusPageSettingsSchema.parse(page.settings);
        const scope = system(page.workspaceId);
        let states = statesOf.get(page.workspaceId);
        if (states === undefined) {
          states = new Map((await deps.detection.states(scope)).map((s) => [s.monitorId, s]));
          statesOf.set(page.workspaceId, states);
        }
        const components = (await repo.componentsOf(deps.db, [page.id])).filter(
          (c) => c.monitorId !== null && (monitorId === undefined || c.monitorId === monitorId),
        );
        const open = await repo.openAutoIncidents(deps.db, [page.id]);
        const now = clock.now();
        const changed = { value: false };

        /* Still open although the monitor is no longer down: say so and close it. */
        for (const incident of open) {
          if (monitorId !== undefined && incident.autoMonitorId !== monitorId) continue;
          if (states.get(incident.autoMonitorId ?? "")?.status === "down") continue;
          const name =
            components.find((c) => c.monitorId === incident.autoMonitorId)?.name ?? "The service";
          await deps.db.transaction(async (tx) => {
            const locked = await repo.findIncident(tx, scope, incident.id, true);
            if (locked === undefined || locked.resolvedAt !== null) return;
            const update = await repo.insertUpdate(tx, scope, {
              id: deps.newId(),
              statusIncidentId: incident.id,
              status: "resolved",
              body: autoText(name).resolved,
              aiDrafted: false,
              createdBy: null,
              createdAt: now,
            });
            await repo.updateIncident(tx, scope, incident.id, {
              status: "resolved",
              resolvedAt: now,
            });
            if (locked.published) {
              await deps.outbox.emit(
                tx,
                "status_page.update_published",
                { statusPageId: page.id, statusIncidentId: incident.id, updateId: update.id },
                { workspaceId: page.workspaceId },
              );
            }
            result.resolved += 1;
            changed.value = true;
          });
        }

        /* Down for longer than the page allows, and nothing says so yet: open one. */
        if (settings.autoIncidents.enabled) {
          const waitMs = settings.autoIncidents.afterMinutes * 60_000;
          const byMonitor = new Map<string, StatusComponentRow[]>();
          for (const c of components) {
            if (c.monitorId === null) continue;
            byMonitor.set(c.monitorId, [...(byMonitor.get(c.monitorId) ?? []), c]);
          }
          for (const [id, shown] of byMonitor) {
            const state = states.get(id);
            if (state === undefined || state.status !== "down") continue;
            if (now.getTime() - Date.parse(state.since) < waitMs) continue;
            if (open.some((i) => i.autoMonitorId === id)) continue;
            const text = autoText(shown[0]?.name ?? "A service");
            const published = settings.autoIncidents.publish === "auto";
            await deps.db.transaction(async (tx) => {
              /* The unique index decides if two sweeps race: the second insert returns nothing. */
              const incident = await repo.insertIncident(tx, scope, {
                id: deps.newId(),
                pageId: page.id,
                title: text.title,
                status: "investigating",
                impact: "major_outage",
                componentIds: shown.map((c) => c.id),
                published,
                autoMonitorId: id,
                startedAt: now,
                resolvedAt: null,
                createdBy: null,
              });
              if (incident === undefined) return;
              const update = await repo.insertUpdate(tx, scope, {
                id: deps.newId(),
                statusIncidentId: incident.id,
                status: "investigating",
                body: text.opened,
                aiDrafted: false,
                createdBy: null,
                createdAt: now,
              });
              if (published) {
                await deps.outbox.emit(
                  tx,
                  "status_page.update_published",
                  { statusPageId: page.id, statusIncidentId: incident.id, updateId: update.id },
                  { workspaceId: page.workspaceId },
                );
              }
              result.opened += 1;
              changed.value = true;
            });
          }
        }
        if (changed.value) await refresh(page);
      }
      return result;
    },

    async publicPage(ref) {
      const page = await repo.findPublished(ref);
      return page === undefined ? undefined : snapshot(page, true);
    },

    async publicFeed(ref, format) {
      const page = await service.publicPage(ref);
      if (page === undefined) return undefined;
      return format === "rss"
        ? renderRss(page)
        : renderAtom(page, `${deps.webOrigin}/api/public/status/${page.page.slug}/atom`);
    },

    async onMonitorChanged(monitorId) {
      const components = await repo.componentsForMonitors([monitorId]);
      const pages = await repo.pagesByIds([...new Set(components.map((c) => c.pageId))]);
      if (pages.length > 0) {
        /* A recovery closes the page's automatic incident at once; an outage waits for the sweep. */
        await service.autoIncidents(monitorId);
        await refresh(...pages);
      }
      return pages.length;
    },

    async onMonitorDeleted(monitorId) {
      const unlinked = await repo.unlinkMonitor(monitorId);
      const pages = await repo.pagesByIds([...new Set(unlinked.map((c) => c.pageId))]);
      if (pages.length > 0) await refresh(...pages);
      return unlinked.length;
    },

    async onUpdatePublished(statusPageId) {
      const [page] = await repo.pagesByIds([statusPageId]);
      if (page !== undefined) await refresh(page);
    },
  };
  return service;
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string; cause?: { code?: string } } | null)?.code;
  const cause = (err as { cause?: { code?: string } } | null)?.cause?.code;
  return code === "23505" || cause === "23505";
}
