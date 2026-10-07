/*
 * Importers (PRODUCT.md §6.12): a dry run that says what each object of another tool would become,
 * and an apply that creates them through the owning modules, one by one, so a single bad object
 * never stops the rest. The export is read for the request and not stored; a UptimeRobot API key is
 * used once and never kept.
 */
import {
  MAX_IMPORT_ITEMS,
  roleCan,
  type ImportItemView,
  type ImportPlanView,
  type ImportRequest,
  type ImportRunView,
} from "@app/shared";
import { AppError, ProviderError, ValidationError } from "../../core/errors.js";
import type { WorkspaceScope } from "../../core/workspace-scope.js";
import type { Db } from "../../infra/db/index.js";
import type { OutboundHttp } from "../../infra/http/outbound.js";
import type { MonitorsService } from "../monitors/index.js";
import type { OncallService } from "../oncall/index.js";
import type { WorkspacesService } from "../workspaces/index.js";
import type { ImportsRepository } from "./imports.repository.js";
import { mapImport, type PlannedItem } from "./mappers.js";
import type { ImportRow } from "./schema/imports.js";

const UPTIMEROBOT_API = "https://api.uptimerobot.com/v2/getMonitors";
const UPTIMEROBOT_PAGE = 50;

export interface ImportsService {
  /* What the import would do; nothing is created. */
  dryRun(scope: WorkspaceScope, request: ImportRequest): Promise<ImportPlanView>;
  apply(scope: WorkspaceScope, request: ImportRequest): Promise<ImportRunView>;
  history(scope: WorkspaceScope): Promise<ImportRunView[]>;
}

export interface ImportsServiceDeps {
  db: Db;
  repository: ImportsRepository;
  monitors: Pick<MonitorsService, "create" | "planLimits">;
  oncall: Pick<OncallService, "create" | "createEscalationPolicy">;
  workspaces: Pick<WorkspacesService, "listMembers">;
  http: OutboundHttp;
  newId: () => string;
}

export function createImportsService(deps: ImportsServiceDeps): ImportsService {
  const { repository: repo } = deps;

  /* Every page of the account's monitors, read with a key the user typed for this request. */
  async function fetchUptimeRobot(apiKey: string): Promise<unknown> {
    const monitors: unknown[] = [];
    for (let offset = 0; offset < MAX_IMPORT_ITEMS; offset += UPTIMEROBOT_PAGE) {
      const res = await deps.http.request({
        method: "POST",
        url: UPTIMEROBOT_API,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          api_key: apiKey,
          format: "json",
          limit: String(UPTIMEROBOT_PAGE),
          offset: String(offset),
        }).toString(),
      });
      let body: { stat?: string; monitors?: unknown[]; pagination?: { total?: number } };
      try {
        body = JSON.parse(res.body) as typeof body;
      } catch {
        throw new ProviderError("uptimerobot", "UptimeRobot answered with something unreadable.");
      }
      if (res.status !== 200 || body.stat !== "ok" || !Array.isArray(body.monitors)) {
        throw new ValidationError("UptimeRobot refused the API key.", [
          { path: "body.apiKey", message: "UptimeRobot refused this API key." },
        ]);
      }
      monitors.push(...body.monitors);
      if (monitors.length >= (body.pagination?.total ?? 0) || body.monitors.length === 0) break;
    }
    return { monitors };
  }

  async function plan(scope: WorkspaceScope, request: ImportRequest): Promise<PlannedItem[]> {
    const data =
      request.data ??
      (request.apiKey === undefined ? undefined : await fetchUptimeRobot(request.apiKey));
    /* Only people who can be paged can be put on a schedule or an escalation step. */
    const members = (await deps.workspaces.listMembers(scope)).filter((m) =>
      roleCan(m.role, "contact:manage"),
    );
    const byEmail = new Map(members.map((m) => [m.email.toLowerCase(), m.userId] as const));
    const items = mapImport(request.source, data, (email) => byEmail.get(email));
    if (items.length > MAX_IMPORT_ITEMS) {
      throw new ValidationError(`An import can carry at most ${MAX_IMPORT_ITEMS} objects.`, [
        { path: "body.data", message: `At most ${MAX_IMPORT_ITEMS} objects per import.` },
      ]);
    }
    return items;
  }

  const view = (item: PlannedItem): ImportItemView => ({
    kind: item.kind,
    name: item.name,
    becomes: item.becomes,
    action: item.action,
    reason: item.action === "skip" ? item.reason : null,
  });

  function summarize(request: ImportRequest, items: ImportItemView[]): ImportPlanView {
    const mapped = items.filter((i) => i.action === "create").length;
    return {
      source: request.source,
      items,
      total: items.length,
      mapped,
      coveragePercent: items.length === 0 ? 0 : Math.round((mapped / items.length) * 1_000) / 10,
    };
  }

  const toRun = (row: ImportRow): ImportRunView => ({
    id: row.id,
    source: row.source,
    items: row.items,
    total: row.total,
    mapped: row.mapped,
    coveragePercent: row.total === 0 ? 0 : Math.round((row.mapped / row.total) * 1_000) / 10,
    created: row.created,
    failed: row.failed,
    createdAt: row.createdAt.toISOString(),
  });

  return {
    async dryRun(scope, request) {
      return summarize(request, (await plan(scope, request)).map(view));
    },

    async apply(scope, request) {
      const planned = await plan(scope, request);
      const limits = await deps.monitors.planLimits(scope);
      /* Imported schedules by their name in the other tool, for escalation steps that page them. */
      const scheduleIds = new Map<string, string>();
      const results: ImportItemView[] = [];
      /* Schedules first: escalations refer to them. */
      const order = { schedule: 0, monitor: 1, escalation: 2 } as const;
      const indexed = planned.map((item, index) => ({ item, index }));
      indexed.sort((a, b) => order[a.item.kind] - order[b.item.kind] || a.index - b.index);
      const done = new Map<number, ImportItemView>();
      for (const { item, index } of indexed) {
        const base = view(item);
        if (item.action === "skip") {
          done.set(index, base);
          continue;
        }
        try {
          if ("monitor" in item) {
            /* A faster interval than the plan allows is slowed to the plan's fastest. */
            const intervalSeconds = Math.max(
              item.monitor.settings.intervalSeconds ?? 300,
              limits.minIntervalSeconds,
            );
            await deps.monitors.create(scope, {
              ...item.monitor,
              settings: { ...item.monitor.settings, intervalSeconds },
            });
          } else if ("schedule" in item) {
            const created = await deps.oncall.create(scope, item.schedule);
            scheduleIds.set(item.name, created.id);
          } else {
            const steps = item.escalation.steps.map((step, i) => ({
              ...step,
              targets: step.targets.map((target) =>
                target.type === "schedule"
                  ? { ...target, id: scheduleIds.get(item.scheduleNames[i] ?? "") ?? target.id }
                  : target,
              ),
            }));
            await deps.oncall.createEscalationPolicy(scope, { ...item.escalation, steps });
          }
          done.set(index, { ...base, result: "created", error: null });
        } catch (err) {
          /* What the API would have said (a plan limit, a refused target); anything else is ours. */
          if (!(err instanceof AppError)) throw err;
          done.set(index, { ...base, result: "failed", error: err.message });
        }
      }
      for (let i = 0; i < planned.length; i += 1) results.push(done.get(i) as ImportItemView);
      const summary = summarize(request, results);
      const row = await repo.insert(deps.db, scope, {
        id: deps.newId(),
        source: request.source,
        items: results,
        total: summary.total,
        mapped: summary.mapped,
        created: results.filter((r) => r.result === "created").length,
        failed: results.filter((r) => r.result === "failed").length,
        createdBy: scope.actorUserId ?? null,
      });
      return toRun(row);
    },

    async history(scope) {
      return (await repo.list(deps.db, scope, 20)).map(toRun);
    },
  };
}
