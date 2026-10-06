/*
 * Weekly digest v0 (PRODUCT.md §6.10, P1-T18). From Monday 08:00 UTC, each workspace's owners and
 * admins get last week's numbers: incidents opened and resolved, mean time to resolve, and the
 * monitors with the most downtime. `digest_sends` makes it once per workspace and week, and a
 * worker that was down catches up later in the week.
 */
import type { Clock } from "../../core/clock.js";
import { createWorkspaceScope } from "../../core/workspace-scope.js";
import type { Db } from "../../infra/db/index.js";
import type { Logger } from "../../infra/logger.js";
import type { Outbox } from "../../infra/outbox/index.js";
import type { DetectionService } from "../detection/index.js";
import type { IncidentsService } from "../incidents/index.js";
import type { MonitorsService } from "../monitors/index.js";
import type { WorkspacesService } from "../workspaces/index.js";
import type { ReportsRepository } from "./reports.repository.js";

const DAY = 86_400_000;
const SEND_FROM_HOUR_UTC = 8;
const PAGE = 500;
const TOP_MONITORS = 5;

/* Monday 00:00 UTC of the week containing `at`. */
export function weekStartOf(at: Date): Date {
  const day = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const sinceMonday = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - sinceMonday * DAY);
}

export interface ReportsService {
  /* Sends digests that are due; returns how many workspaces got one. */
  sendWeeklyDigests(): Promise<number>;
  /* One workspace's digest for last week, if due and not sent yet. True if it was sent. */
  sendDigest(workspaceId: string): Promise<boolean>;
}

export function createReportsService(deps: {
  db: Db;
  repository: ReportsRepository;
  workspaces: Pick<WorkspacesService, "workspaceIds" | "listMembers" | "workspaceName">;
  incidents: Pick<IncidentsService, "stats">;
  detection: Pick<DetectionService, "downtimeByMonitor">;
  monitors: Pick<MonitorsService, "getForDetection" | "list">;
  outbox: Outbox;
  clock: Clock;
  logger: Logger;
  webOrigin: string;
}): ReportsService {
  const { clock } = deps;

  async function sendOne(workspaceId: string, from: Date, to: Date): Promise<boolean> {
    const scope = createWorkspaceScope({ workspaceId });
    const [members, name, stats, downtime, monitors] = await Promise.all([
      deps.workspaces.listMembers(scope),
      deps.workspaces.workspaceName(scope),
      deps.incidents.stats(workspaceId, from, to),
      deps.detection.downtimeByMonitor(workspaceId, from, to, TOP_MONITORS),
      deps.monitors.list(scope, { limit: 200 }),
    ]);
    const recipients = members.filter((m) => m.role === "owner" || m.role === "admin");
    if (recipients.length === 0) return false;
    const names = new Map(
      (await deps.monitors.getForDetection(downtime.map((d) => d.monitorId))).map((m) => [
        m.id,
        m.name,
      ]),
    );
    const rangeSeconds = (to.getTime() - from.getTime()) / 1_000;
    const settingsUrl = `${deps.webOrigin}/w/${workspaceId}/settings`;
    const data = {
      workspaceName: name,
      weekStart: from.toISOString().slice(0, 10),
      weekEnd: new Date(to.getTime() - DAY).toISOString().slice(0, 10),
      incidents: stats.opened,
      resolved: stats.resolved,
      mttrMinutes: stats.mttrMinutes,
      monitors: downtime
        .filter((d) => d.seconds > 0)
        .map((d) => ({
          name: names.get(d.monitorId) ?? "Deleted monitor",
          uptimePercent: Math.round((1 - d.seconds / rangeSeconds) * 1_000_000) / 10_000,
          downtimeMinutes: d.seconds / 60,
        })),
      totalMonitors: monitors.data.filter((m) => m.type !== "heartbeat").length,
      url: `${deps.webOrigin}/w/${workspaceId}/overview`,
      settingsUrl,
    };

    return deps.db.transaction(async (tx) => {
      if (!(await deps.repository.claimDigest(tx, workspaceId, from))) return false;
      for (const member of recipients) {
        await deps.outbox.emit(
          tx,
          "email.requested",
          {
            template: "digest",
            to: member.email,
            data,
            idempotencyKey: `digest.${workspaceId}.${from.getTime()}.${member.userId}`,
            headers: { "List-Unsubscribe": `<${settingsUrl}>` },
          },
          { workspaceId },
        );
      }
      return true;
    });
  }

  /* Last week's range, or undefined before Monday 08:00 UTC. */
  function dueWeek(): { from: Date; to: Date } | undefined {
    const now = clock.now();
    const thisWeek = weekStartOf(now);
    if (now.getTime() < thisWeek.getTime() + SEND_FROM_HOUR_UTC * 3_600_000) return undefined;
    return { from: new Date(thisWeek.getTime() - 7 * DAY), to: thisWeek };
  }

  return {
    async sendDigest(workspaceId) {
      const week = dueWeek();
      if (week === undefined) return false;
      if (await deps.repository.digestSent(deps.db, workspaceId, week.from)) return false;
      return sendOne(workspaceId, week.from, week.to);
    },

    async sendWeeklyDigests() {
      const week = dueWeek();
      if (week === undefined) return 0;
      const { from, to } = week;
      let sent = 0;
      let afterId: string | undefined;
      for (;;) {
        const ids = await deps.workspaces.workspaceIds({
          limit: PAGE,
          ...(afterId === undefined ? {} : { afterId }),
        });
        for (const id of ids) {
          if (await deps.repository.digestSent(deps.db, id, from)) continue;
          try {
            if (await sendOne(id, from, to)) sent += 1;
          } catch (err) {
            deps.logger.error({ err, workspaceId: id }, "weekly digest failed");
          }
        }
        if (ids.length < PAGE) return sent;
        afterId = ids.at(-1);
      }
    },
  };
}
