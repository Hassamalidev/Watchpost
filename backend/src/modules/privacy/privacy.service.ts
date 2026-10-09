/*
 * Privacy tooling (PRODUCT.md §13 "Privacy"). The export asks each module for what it shows the
 * team anyway, so secrets come out masked the same way. Deletion is a request that waits 30 days:
 * monitoring stops at once, nothing is removed until the wait is over, and then everything is.
 */
import {
  WORKSPACE_DELETION_DAYS,
  WORKSPACE_EXPORT_MAX_INCIDENTS,
  WORKSPACE_EXPORT_VERSION,
  type WorkspaceDeletionView,
  type WorkspaceExport,
} from "@app/shared";
import type { Clock } from "../../core/clock.js";
import { ConflictError, ForbiddenError, ValidationError } from "../../core/errors.js";
import type { SessionContext } from "../../core/session.js";
import { createWorkspaceScope, type WorkspaceScope } from "../../core/workspace-scope.js";
import type { Logger } from "../../infra/logger.js";
import type { Outbox } from "../../infra/outbox/index.js";
import type { Db } from "../../infra/db/index.js";
import type { BillingService } from "../billing/index.js";
import type { ChannelsService } from "../channels/index.js";
import type { ContactsService } from "../contacts/index.js";
import type { IncidentsService } from "../incidents/index.js";
import type { MaintenanceService } from "../maintenance/index.js";
import type { MonitorsService } from "../monitors/index.js";
import type { OncallService } from "../oncall/index.js";
import type { ResultsService } from "../results/index.js";
import type { StatuspagesService } from "../statuspages/index.js";
import type { WorkspacesService } from "../workspaces/index.js";
import type { PrivacyRepository } from "./privacy.repository.js";
import type { WorkspaceDeletionRow } from "./schema/workspace-deletions.js";

const PAGE = 100;
const ERASE_BATCH = 5;

export interface PrivacyService {
  /* Everything the team put into the workspace, as one document. */
  export(scope: WorkspaceScope): Promise<WorkspaceExport>;
  deletion(scope: WorkspaceScope): Promise<WorkspaceDeletionView>;
  /* The owner asks for the workspace to be deleted; `confirm` is its name, typed out. */
  requestDeletion(
    scope: WorkspaceScope,
    confirm: string,
    session: Pick<SessionContext, "email">,
  ): Promise<WorkspaceDeletionView>;
  cancelDeletion(scope: WorkspaceScope): Promise<WorkspaceDeletionView>;
  /* System (sweep): erases workspaces whose wait is over. Returns how many. */
  eraseDue(): Promise<number>;
}

export interface PrivacyServiceDeps {
  db: Db;
  repository: PrivacyRepository;
  clock: Clock;
  logger: Logger;
  outbox: Outbox;
  webOrigin: string;
  /* Removes every row of a workspace; answers the tables that still hold some. */
  eraseRows: (workspaceId: string) => Promise<string[]>;
  workspaces: Pick<
    WorkspacesService,
    "workspaceName" | "getSettings" | "listMembers" | "listClients" | "parentOf"
  >;
  billing: Pick<BillingService, "paidSubscription">;
  monitors: Pick<MonitorsService, "list" | "setPaused">;
  incidents: Pick<IncidentsService, "list">;
  maintenance: Pick<MaintenanceService, "list">;
  channels: Pick<ChannelsService, "list">;
  contacts: Pick<ContactsService, "listMethods">;
  oncall: Pick<OncallService, "list" | "listEscalationPolicies">;
  statuspages: Pick<StatuspagesService, "list" | "listIncidents" | "subscribers">;
  results: Pick<ResultsService, "eraseEvidence">;
}

const NONE: WorkspaceDeletionView = {
  scheduled: false,
  requestedAt: null,
  requestedBy: null,
  deleteAfter: null,
};

const toView = (row: WorkspaceDeletionRow | undefined): WorkspaceDeletionView =>
  row === undefined
    ? NONE
    : {
        scheduled: true,
        requestedAt: row.requestedAt.toISOString(),
        requestedBy: row.requestedBy,
        deleteAfter: row.deleteAfter.toISOString(),
      };

export function createPrivacyService(deps: PrivacyServiceDeps): PrivacyService {
  const { repository, clock } = deps;

  /* Every page of a cursor-paged list, up to `max` items. */
  async function all<T>(
    page: (cursor: string | undefined) => Promise<{ data: T[]; nextCursor: string | null }>,
    max = Number.POSITIVE_INFINITY,
  ): Promise<{ items: T[]; more: boolean }> {
    const items: T[] = [];
    let cursor: string | undefined;
    for (;;) {
      const { data, nextCursor } = await page(cursor);
      items.push(...data);
      if (nextCursor === null) return { items, more: false };
      if (items.length >= max) return { items: items.slice(0, max), more: true };
      cursor = nextCursor;
    }
  }

  const service: PrivacyService = {
    async export(scope) {
      const [name, settings, members, monitors, incidents, maintenance, channels, methods] =
        await Promise.all([
          deps.workspaces.workspaceName(scope),
          deps.workspaces.getSettings(scope),
          deps.workspaces.listMembers(scope),
          all((cursor) => deps.monitors.list(scope, { limit: PAGE, cursor })),
          all(
            (cursor) => deps.incidents.list(scope, { limit: PAGE, cursor }),
            WORKSPACE_EXPORT_MAX_INCIDENTS,
          ),
          deps.maintenance.list(scope),
          deps.channels.list(scope),
          deps.contacts.listMethods(scope),
        ]);
      const [schedules, escalationPolicies, pages] = await Promise.all([
        deps.oncall.list(scope),
        deps.oncall.listEscalationPolicies(scope),
        deps.statuspages.list(scope),
      ]);
      const statusPages: WorkspaceExport["statusPages"] = [];
      for (const page of pages) {
        statusPages.push({
          page,
          incidents: await deps.statuspages.listIncidents(scope, page.id),
          subscribers: await deps.statuspages.subscribers(scope, page.id),
        });
      }
      return {
        version: WORKSPACE_EXPORT_VERSION,
        exportedAt: clock.now().toISOString(),
        workspace: { id: scope.workspaceId, name, settings },
        members,
        monitors: monitors.items,
        incidents: incidents.items,
        maintenance,
        channels,
        contactMethods: methods,
        onCall: { schedules, escalationPolicies },
        statusPages,
        notes: [
          "Passwords, tokens and other secrets are masked, here as in the app.",
          ...(incidents.more
            ? [`Only the newest ${WORKSPACE_EXPORT_MAX_INCIDENTS} incidents are included.`]
            : []),
          "Check results are not included: read them through the API (docs/api.md) or the reports.",
          "The audit log has its own download in Settings (CSV).",
        ],
      };
    },

    async deletion(scope) {
      return toView(await repository.findDeletion(scope));
    },

    async requestDeletion(scope, confirm, session) {
      if (scope.role !== "owner") {
        throw new ForbiddenError("Only an owner can delete the workspace.");
      }
      const name = await deps.workspaces.workspaceName(scope);
      if (confirm.trim() !== name.trim()) {
        throw new ValidationError("Type the workspace's name exactly to confirm.");
      }
      if ((await deps.billing.paidSubscription(scope)) !== null) {
        throw new ConflictError(
          "This workspace has a subscription. Cancel it on the Billing page first; the workspace can be deleted once the subscription has ended.",
        );
      }
      if ((await deps.workspaces.listClients(scope)).length > 0) {
        throw new ConflictError("Delete this workspace's client workspaces first.");
      }
      const now = clock.now();
      const row: WorkspaceDeletionRow = {
        workspaceId: scope.workspaceId,
        requestedBy: session.email,
        requestedAt: now,
        deleteAfter: new Date(now.getTime() + WORKSPACE_DELETION_DAYS * 86_400_000),
      };
      if (!(await repository.insertDeletion(row))) {
        return toView(await repository.findDeletion(scope));
      }

      /* Monitoring stops now: nobody should be paged for a workspace that is on its way out. */
      const active = await all((cursor) =>
        deps.monitors.list(scope, { limit: PAGE, cursor, paused: false }),
      );
      for (const monitor of active.items) {
        await deps.monitors.setPaused(scope, monitor.id, true);
      }

      const members = await deps.workspaces.listMembers(scope);
      await deps.db.transaction(async (tx) => {
        for (const member of members) {
          if (member.role !== "owner" && member.role !== "admin") continue;
          await deps.outbox.emit(
            tx,
            "email.requested",
            {
              template: "workspace-deletion",
              to: member.email,
              data: {
                workspaceName: name,
                requestedBy: session.email,
                deleteAfter: row.deleteAfter.toISOString(),
                days: WORKSPACE_DELETION_DAYS,
                monitors: active.items.length,
                url: `${deps.webOrigin}/w/${scope.workspaceId}/settings`,
              },
              idempotencyKey: `workspace-deletion.${scope.workspaceId}.${now.getTime()}.${member.userId}`,
            },
            { workspaceId: scope.workspaceId },
          );
        }
      });
      return toView(row);
    },

    async cancelDeletion(scope) {
      if (scope.role !== "owner") {
        throw new ForbiddenError("Only an owner can cancel the deletion.");
      }
      await repository.deleteDeletion(scope);
      return NONE;
    },

    async eraseDue() {
      const due = await repository.dueDeletions(clock.now(), ERASE_BATCH);
      let erased = 0;
      for (const request of due) {
        const { workspaceId } = request;
        const scope = createWorkspaceScope({ workspaceId });
        /* A subscription started or a client added during the wait: a person has to look. */
        if ((await deps.billing.paidSubscription(scope)) !== null) {
          deps.logger.warn({ workspaceId }, "workspace not erased: it has a subscription");
          continue;
        }
        if ((await deps.workspaces.listClients(scope)).length > 0) {
          deps.logger.warn({ workspaceId }, "workspace not erased: it has client workspaces");
          continue;
        }
        const objects = await deps.results.eraseEvidence(workspaceId);
        const left = await deps.eraseRows(workspaceId);
        if (left.length > 0) {
          /* The request went with the rows or stays due; either way the next run tries again. */
          deps.logger.error({ workspaceId, left }, "workspace erasure left rows behind");
          continue;
        }
        await repository.recordErasure({
          erasedWorkspaceId: workspaceId,
          requestedAt: request.requestedAt,
          erasedAt: clock.now(),
          objects,
        });
        deps.logger.info({ workspaceId, objects }, "workspace erased");
        erased += 1;
      }
      return erased;
    },
  };
  return service;
}
