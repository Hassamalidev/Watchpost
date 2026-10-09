/*
 * The audit log (PRODUCT.md §6.11). Entries come from two places, neither of which a module has to
 * remember to call:
 *
 * - the trail middleware (audit.trail.ts) writes one for every request that changed something
 *   through the app's API or the public API;
 * - sign-in hooks report changes to people (invited, joined, removed, role changed), which go
 *   through the auth library and not through our routes.
 *
 * Every plan records everything. Every plan can read its security events; the rest of the log is
 * part of Business (`auditLog`).
 */
import {
  AUDIT_RETENTION_DAYS,
  type AuditActorType,
  type AuditCategory,
  type AuditEntryView,
  type AuditLogPage,
  type PlanFeature,
} from "@app/shared";
import type { Clock } from "../../core/clock.js";
import type { WorkspaceScope } from "../../core/workspace-scope.js";
import type { Logger } from "../../infra/logger.js";
import type { AuditRepository, AuditRow } from "./audit.repository.js";

export interface AuditEntry {
  workspaceId: string;
  category: AuditCategory;
  action: string;
  actor: { type: AuditActorType; id?: string | undefined; label: string };
  targetId?: string | undefined;
  detail?: string | undefined;
  ip?: string | undefined;
}

export interface AuditService {
  /* Never throws: a log that can't be written must not undo what was done. */
  record(entry: AuditEntry): Promise<void>;
  list(
    scope: WorkspaceScope,
    filters: { limit: number; cursor?: string | undefined; category?: AuditCategory | undefined },
  ): Promise<AuditLogPage>;
  /* The log as CSV, newest first, for the last `days` days. */
  csv(scope: WorkspaceScope, days: number): Promise<string>;
  /* System: deletes entries older than the retention; returns how many. */
  purge(): Promise<number>;
}

const EXPORT_MAX_ROWS = 50_000;
const EXPORT_PAGE = 1_000;

/* A CSV cell that a spreadsheet won't run as a formula. */
function cell(value: string | null): string {
  if (value === null) return "";
  const text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function createAuditService(deps: {
  repository: AuditRepository;
  hasFeature: (scope: WorkspaceScope, feature: PlanFeature) => Promise<boolean>;
  clock: Clock;
  logger: Logger;
  newId: () => string;
}): AuditService {
  const { repository: repo, clock } = deps;

  const toView = (row: AuditRow): AuditEntryView => ({
    id: row.id,
    at: row.at.toISOString(),
    category: row.category,
    action: row.action,
    actor: { type: row.actorType, id: row.actorId, label: row.actorLabel },
    targetId: row.targetId,
    detail: row.detail,
    ip: row.ip,
  });

  /* What the plan lets this workspace read. */
  async function visible(scope: WorkspaceScope, asked: AuditCategory | undefined) {
    const full = await deps.hasFeature(scope, "auditLog");
    return { securityOnly: !full, category: full ? asked : ("security" as const) };
  }

  return {
    async record(entry) {
      try {
        await repo.insert({
          id: deps.newId(),
          workspaceId: entry.workspaceId,
          at: clock.now(),
          category: entry.category,
          action: entry.action.slice(0, 120),
          actorType: entry.actor.type,
          actorId: entry.actor.id ?? null,
          actorLabel: entry.actor.label.slice(0, 200),
          targetId: entry.targetId?.slice(0, 200) ?? null,
          detail: entry.detail?.slice(0, 200) ?? null,
          ip: entry.ip?.slice(0, 64) ?? null,
        });
      } catch (err) {
        deps.logger.error({ err, action: entry.action }, "audit entry could not be written");
      }
    },

    async list(scope, filters) {
      const { securityOnly, category } = await visible(scope, filters.category);
      const rows = await repo.list(scope, {
        limit: filters.limit + 1,
        before: filters.cursor,
        category,
      });
      const page = rows.slice(0, filters.limit);
      return {
        data: page.map(toView),
        nextCursor: rows.length > filters.limit ? (page.at(-1)?.id ?? null) : null,
        securityOnly,
      };
    },

    async csv(scope, days) {
      const { category } = await visible(scope, undefined);
      const since = new Date(clock.now().getTime() - days * 86_400_000);
      const lines = ["Time (UTC),Actor,Actor type,Category,Action,Target,Detail,IP"];
      let before: string | undefined;
      while (lines.length <= EXPORT_MAX_ROWS) {
        const rows = await repo.list(scope, { limit: EXPORT_PAGE, before, category, since });
        for (const row of rows) {
          lines.push(
            [
              row.at.toISOString(),
              row.actorLabel,
              row.actorType,
              row.category,
              row.action,
              row.targetId,
              row.detail,
              row.ip,
            ]
              .map(cell)
              .join(","),
          );
        }
        if (rows.length < EXPORT_PAGE) break;
        before = rows.at(-1)?.id;
      }
      return `${lines.join("\r\n")}\r\n`;
    },

    purge: () =>
      repo.deleteBefore(new Date(clock.now().getTime() - AUDIT_RETENTION_DAYS * 86_400_000)),
  };
}
