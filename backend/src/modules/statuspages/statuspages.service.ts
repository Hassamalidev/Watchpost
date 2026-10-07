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
  type UpdateStatusPageInput,
} from "@app/shared";
import type { z } from "zod";
import type { updateStatusIncidentSchema } from "@app/shared";
import type { Clock } from "../../core/clock.js";
import {
  ConflictError,
  NotFoundError,
  QuotaExceededError,
  ValidationError,
} from "../../core/errors.js";
import { createWorkspaceScope, type WorkspaceScope } from "../../core/workspace-scope.js";
import type { PlanFeatures, PlanLimits } from "../../config/plans.js";
import type { Db, DbOrTx } from "../../infra/db/index.js";
import type { Logger } from "../../infra/logger.js";
import type { Outbox } from "../../infra/outbox/index.js";
import type { DetectionService } from "../detection/index.js";
import type { MaintenanceService } from "../maintenance/index.js";
import type { MonitorsService } from "../monitors/index.js";
import { renderAtom, renderRss } from "./feeds.js";
import type { StatuspagesRepository } from "./statuspages.repository.js";
import type {
  StatusComponentRow,
  StatusIncidentRow,
  StatusPageRow,
  StatusUpdateRow,
} from "./schema/statuspages.js";

type UpdateStatusIncidentInput = z.infer<typeof updateStatusIncidentSchema>;

/* How a page is looked up from outside: its subdomain, or the host name of a custom domain. */
export type PublicRef = { slug: string } | { host: string };

/* How far ahead scheduled maintenance is announced on a page. */
const MAINTENANCE_AHEAD_DAYS = 14;
const DAY_MS = 86_400_000;
const MAX_PAGE_INCIDENTS = 50;

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

  async function refresh(...slugs: string[]): Promise<void> {
    await deps.revalidate([...new Set(slugs)].map(statusPageTag));
  }

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
        subscribe: false,
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
      await refresh(page.slug);
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
      await refresh(before.slug, row.slug);
      return viewOf(deps.db, row);
    },

    async delete(scope, id) {
      const page = await mustFindPage(deps.db, scope, id);
      await repo.deletePage(scope, id);
      await refresh(page.slug);
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
      await refresh(page.slug);
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
      await refresh(page.slug);
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
        /* A draft that goes public is announced with its latest update. */
        if (!before.published && incident.published) {
          const [latest] = await repo.updatesOf(tx, [incident.id]);
          if (latest !== undefined) {
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
      await refresh(page.slug);
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
      await refresh(page.slug);
      return view;
    },

    async deleteIncident(scope, pageId, incidentId) {
      const page = await mustFindPage(deps.db, scope, pageId);
      await mustFindIncident(deps.db, scope, pageId, incidentId);
      await repo.deleteIncident(scope, incidentId);
      await refresh(page.slug);
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
      if (pages.length > 0) await refresh(...pages.map((p) => p.slug));
      return pages.length;
    },

    async onMonitorDeleted(monitorId) {
      const unlinked = await repo.unlinkMonitor(monitorId);
      const pages = await repo.pagesByIds([...new Set(unlinked.map((c) => c.pageId))]);
      if (pages.length > 0) await refresh(...pages.map((p) => p.slug));
      return unlinked.length;
    },

    async onUpdatePublished(statusPageId) {
      const [page] = await repo.pagesByIds([statusPageId]);
      if (page !== undefined) await refresh(page.slug);
    },
  };
  return service;
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string; cause?: { code?: string } } | null)?.code;
  const cause = (err as { cause?: { code?: string } } | null)?.cause?.code;
  return code === "23505" || cause === "23505";
}
