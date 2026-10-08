/*
 * Reports (PRODUCT.md §6.10, §9.9).
 *
 * - SLA report: uptime, downtime, incidents, MTTA, MTTR and latency percentiles for one monitor, a
 *   group, a status page's monitors or the whole workspace. Uptime comes from the detection module's
 *   SLA calculation, the same one the monitor page and the status page use, so the numbers agree.
 * - Schedules email a report's headline numbers and a link to its PDF to people inside or outside
 *   the workspace, once per week or month.
 * - The monthly uptime email goes to owners and admins on plans that include it.
 * - The weekly digest (P1-T18) goes to owners and admins from Monday 08:00 UTC, with a short AI
 *   paragraph when AI is set up and there is something to say.
 *
 * Every scheduled send is claimed in the database first, so a period goes out once and a worker that
 * was down catches up later.
 */
import { createHash } from "node:crypto";
import {
  REPORT_MAX_DAYS,
  REPORT_MAX_MONITORS,
  REPORT_MAX_SCHEDULES,
  type PlanFeature,
  type ReportScheduleInput,
  type ReportScheduleView,
  type ReportTarget,
  type SlaReport,
  type SlaReportRow,
} from "@app/shared";
import type { Clock } from "../../core/clock.js";
import { NotFoundError, QuotaExceededError, ValidationError } from "../../core/errors.js";
import { createWorkspaceScope, type WorkspaceScope } from "../../core/workspace-scope.js";
import type { Db } from "../../infra/db/index.js";
import type { Logger } from "../../infra/logger.js";
import type { Outbox } from "../../infra/outbox/index.js";
import { renderPdf } from "../../infra/pdf.js";
import type { TokenSigner } from "../../infra/signed-token.js";
import type { AiService } from "../ai/index.js";
import { combineUptime, type DetectionService } from "../detection/index.js";
import type { IncidentsService } from "../incidents/index.js";
import type { MonitorsService } from "../monitors/index.js";
import type { RollupsService } from "../results/index.js";
import type { StatuspagesService } from "../statuspages/index.js";
import type { WorkspacesService } from "../workspaces/index.js";
import type { ReportScheduleRow, ReportsRepository } from "./reports.repository.js";
import {
  duePeriod,
  minutesText,
  periodLabel,
  slaCsv,
  slaFileName,
  slaPdf,
  weekStartOf,
} from "./sla.js";

export { weekStartOf };

const DAY = 86_400_000;
const PAGE = 500;
const TOP_MONITORS = 5;
const MONITOR_PAGE = 200;
/* How long a report link in an email works, and how long its unsubscribe link does. */
const LINK_DAYS = 90;
const UNSUBSCRIBE_DAYS = 400;

export interface SlaQuery {
  target: ReportTarget;
  from: Date;
  to: Date;
  excludeMaintenance: boolean;
}

/* What a report link in an email carries: the whole question, so the link answers it by itself. */
export interface ReportLinkPayload {
  w: string;
  k: ReportTarget["kind"];
  i?: string;
  f: number;
  t: number;
  x: boolean;
  b?: string;
}

export interface ReportUnsubscribePayload {
  s: string;
  w: string;
  r: string;
}

export interface ReportFile {
  fileName: string;
  body: Buffer | string;
}

export interface ReportsService {
  /* Sends digests that are due; returns how many workspaces got one. */
  sendWeeklyDigests(): Promise<number>;
  /* One workspace's digest for last week, if due and not sent yet. True if it was sent. */
  sendDigest(workspaceId: string): Promise<boolean>;
  /* The report on screen: every plan, within the plan's history. */
  sla(scope: WorkspaceScope, query: SlaQuery): Promise<SlaReport>;
  /* The same report as a file. `brandName` replaces our name on the PDF (white-label plans). */
  slaCsv(scope: WorkspaceScope, query: SlaQuery): Promise<ReportFile>;
  slaPdf(
    scope: WorkspaceScope,
    query: SlaQuery,
    brandName?: string | undefined,
  ): Promise<ReportFile>;
  listSchedules(scope: WorkspaceScope): Promise<ReportScheduleView[]>;
  createSchedule(scope: WorkspaceScope, input: ReportScheduleInput): Promise<ReportScheduleView>;
  updateSchedule(
    scope: WorkspaceScope,
    id: string,
    input: ReportScheduleInput,
  ): Promise<ReportScheduleView>;
  deleteSchedule(scope: WorkspaceScope, id: string): Promise<void>;
  /* Sends the scheduled reports that are due; returns how many schedules sent one. */
  sendScheduledReports(): Promise<number>;
  /* Sends the monthly uptime emails that are due; returns how many workspaces got one. */
  sendMonthlyEmails(): Promise<number>;
  /* One workspace's monthly uptime email, if due and not sent yet. True if it was sent. */
  sendMonthlyEmail(workspaceId: string): Promise<boolean>;
  /* Public: the PDF behind a link from a report email; undefined for a bad or expired link. */
  sharedPdf(token: string): Promise<ReportFile | undefined>;
  /* Public: takes the address in an unsubscribe link off its schedule. False for a bad link. */
  unsubscribe(token: string): Promise<boolean>;
}

/* A stable ID for "this workspace's digest for this week", so a retried digest reuses its answer. */
function digestRef(workspaceId: string, weekStart: Date): string {
  const hex = createHash("sha256")
    .update(`digest:${workspaceId}:${weekStart.getTime()}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function createReportsService(deps: {
  db: Db;
  repository: ReportsRepository;
  workspaces: Pick<WorkspacesService, "workspaceIds" | "listMembers" | "workspaceName">;
  incidents: Pick<IncidentsService, "stats" | "statsByMonitor" | "noisiest">;
  detection: Pick<DetectionService, "downtimeByMonitor" | "uptimeMany">;
  monitors: Pick<MonitorsService, "getForDetection" | "list" | "get" | "listGroups" | "planLimits">;
  results: Pick<RollupsService, "latencyBetween">;
  statuspages: Pick<StatuspagesService, "get">;
  hasFeature: (scope: WorkspaceScope, feature: PlanFeature) => Promise<boolean>;
  /* Undefined in tests that don't need the digest's AI paragraph. */
  ai?: Pick<AiService, "generate" | "configured"> | undefined;
  linkSigner: TokenSigner<ReportLinkPayload>;
  unsubscribeSigner: TokenSigner<ReportUnsubscribePayload>;
  outbox: Outbox;
  clock: Clock;
  logger: Logger;
  newId: () => string;
  webOrigin: string;
}): ReportsService {
  const { clock, repository: repo } = deps;

  /* ---- SLA reports ---- */

  async function monitorsOf(scope: WorkspaceScope, target: ReportTarget) {
    if (target.kind === "monitor") {
      const monitor = await deps.monitors.get(scope, target.id ?? "");
      return { name: monitor.name, monitors: [monitor], truncated: false };
    }
    if (target.kind === "page") {
      const page = await deps.statuspages.get(scope, target.id ?? "");
      const ids = [
        ...new Set(page.components.flatMap((c) => (c.monitorId === null ? [] : [c.monitorId]))),
      ];
      const kept = ids.slice(0, REPORT_MAX_MONITORS);
      const monitors = await Promise.all(kept.map((id) => deps.monitors.get(scope, id)));
      return { name: page.name, monitors, truncated: ids.length > kept.length };
    }
    let name = "All monitors";
    if (target.kind === "group") {
      const group = (await deps.monitors.listGroups(scope)).find((g) => g.id === target.id);
      if (group === undefined) throw new NotFoundError("Group not found.");
      name = group.name;
    }
    const monitors = [];
    let cursor: string | undefined;
    let truncated = false;
    for (;;) {
      const page = await deps.monitors.list(scope, {
        limit: MONITOR_PAGE,
        ...(cursor === undefined ? {} : { cursor }),
        ...(target.kind === "group" ? { groupId: target.id } : {}),
      });
      monitors.push(...page.data);
      if (page.nextCursor === null) break;
      if (monitors.length >= REPORT_MAX_MONITORS) {
        truncated = true;
        break;
      }
      cursor = page.nextCursor;
    }
    return { name, monitors: monitors.slice(0, REPORT_MAX_MONITORS), truncated };
  }

  const mean = (sum: number, count: number) => (count === 0 ? null : Math.round(sum / count));

  /* `checkHistory` is off for links we signed ourselves: the plan was checked when they were made. */
  async function build(
    scope: WorkspaceScope,
    query: SlaQuery,
    checkHistory: boolean,
  ): Promise<SlaReport> {
    const now = clock.now();
    const from = query.from;
    const to = new Date(Math.min(query.to.getTime(), now.getTime()));
    if (from.getTime() >= to.getTime()) {
      throw new ValidationError("The period is empty.", [
        { path: "from", message: "must be before the end and in the past" },
      ]);
    }
    if (to.getTime() - from.getTime() > REPORT_MAX_DAYS * DAY) {
      throw new ValidationError(`A report covers at most ${REPORT_MAX_DAYS} days.`, [
        { path: "from", message: "too long ago for one report" },
      ]);
    }
    if (checkHistory) {
      const { historyDays } = await deps.monitors.planLimits(scope);
      /* A day of slack, so "the last 30 days" works on a plan that keeps 30. */
      if (from.getTime() < now.getTime() - (historyDays + 1) * DAY) {
        throw new QuotaExceededError(
          `Your plan keeps ${historyDays} days of history. Upgrade to report on earlier periods.`,
        );
      }
    }

    const [workspaceName, found] = await Promise.all([
      deps.workspaces.workspaceName(scope),
      monitorsOf(scope, query.target),
    ]);
    const monitors = [...found.monitors].sort(
      (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    );
    const ids = monitors.map((m) => m.id);
    const [uptime, incidentStats, latency] = await Promise.all([
      deps.detection.uptimeMany(scope, monitors, {
        from,
        to,
        excludeMaintenance: query.excludeMaintenance,
      }),
      deps.incidents.statsByMonitor(scope, ids, from, to),
      deps.results.latencyBetween(scope, ids, from, to),
    ]);
    const incidentsOf = new Map(incidentStats.map((s) => [s.monitorId, s]));

    const rows: SlaReportRow[] = monitors.flatMap((m) => {
      const u = uptime.get(m.id);
      if (u === undefined) return [];
      const i = incidentsOf.get(m.id);
      const l = latency.byMonitor.get(m.id);
      return [
        {
          monitorId: m.id,
          name: m.name,
          type: m.type,
          uptimePercent: u.uptimePercent,
          rangeSeconds: u.rangeSeconds,
          downtimeSeconds: u.downtimeSeconds,
          maintenanceSeconds: u.maintenanceSeconds,
          incidents: i?.opened ?? 0,
          mttaSeconds: mean(i?.ackSeconds ?? 0, i?.acked ?? 0),
          mttrSeconds: mean(i?.resolveSeconds ?? 0, i?.resolved ?? 0),
          p50: l?.p50 ?? null,
          p95: l?.p95 ?? null,
          p99: l?.p99 ?? null,
          checks: l?.checks ?? 0,
        },
      ];
    });
    const all = combineUptime([...uptime.values()], query.excludeMaintenance);
    const sum = (pick: (s: (typeof incidentStats)[number]) => number) =>
      incidentStats.reduce((a, s) => a + pick(s), 0);
    return {
      workspaceName,
      target: { kind: query.target.kind, id: query.target.id ?? null, name: found.name },
      from: from.toISOString(),
      to: to.toISOString(),
      excludeMaintenance: query.excludeMaintenance,
      generatedAt: now.toISOString(),
      totals: {
        uptimePercent: all.uptimePercent,
        rangeSeconds: all.rangeSeconds,
        downtimeSeconds: all.downtimeSeconds,
        maintenanceSeconds: all.maintenanceSeconds,
        incidents: sum((s) => s.opened),
        mttaSeconds: mean(
          sum((s) => s.ackSeconds),
          sum((s) => s.acked),
        ),
        mttrSeconds: mean(
          sum((s) => s.resolveSeconds),
          sum((s) => s.resolved),
        ),
        p50: latency.all.p50,
        p95: latency.all.p95,
        p99: latency.all.p99,
        checks: latency.all.checks,
      },
      rows,
      truncated: found.truncated,
    };
  }

  async function requireFeature(scope: WorkspaceScope, feature: PlanFeature, message: string) {
    if (!(await deps.hasFeature(scope, feature))) throw new QuotaExceededError(message);
  }

  async function pdfOf(report: SlaReport, brand: string | null): Promise<ReportFile> {
    return { fileName: slaFileName(report, "pdf"), body: await renderPdf(slaPdf(report, brand)) };
  }

  /* ---- Schedules ---- */

  async function targetName(scope: WorkspaceScope, target: ReportTarget): Promise<string> {
    if (target.kind === "workspace") return "All monitors";
    if (target.kind === "monitor") return (await deps.monitors.get(scope, target.id ?? "")).name;
    if (target.kind === "page") return (await deps.statuspages.get(scope, target.id ?? "")).name;
    const group = (await deps.monitors.listGroups(scope)).find((g) => g.id === target.id);
    if (group === undefined) throw new NotFoundError("Group not found.");
    return group.name;
  }

  const targetOf = (row: ReportScheduleRow): ReportTarget =>
    row.targetId === null ? { kind: row.targetKind } : { kind: row.targetKind, id: row.targetId };

  async function toView(scope: WorkspaceScope, row: ReportScheduleRow) {
    /* The monitor, group or page may have been deleted since; the schedule then says so. */
    const name = await targetName(scope, targetOf(row)).catch((err: unknown) => {
      if (err instanceof NotFoundError) return "Deleted";
      throw err;
    });
    return {
      id: row.id,
      name: row.name,
      target: { kind: row.targetKind, id: row.targetId, name },
      frequency: row.frequency,
      recipients: row.recipients,
      excludeMaintenance: row.excludeMaintenance,
      brandName: row.brandName,
      lastPeriodStart: row.lastPeriodStart?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    } satisfies ReportScheduleView;
  }

  async function checkSchedule(scope: WorkspaceScope, input: ReportScheduleInput) {
    await requireFeature(
      scope,
      "slaReports",
      "Scheduled SLA reports are part of the Pro plan. Upgrade to send them.",
    );
    if (input.brandName !== null) {
      await requireFeature(
        scope,
        "whiteLabel",
        "Reports under your own name are part of the Business plan.",
      );
    }
    /* Throws not found for a target that isn't in this workspace. */
    await targetName(scope, input.target);
  }

  const scheduleValues = (input: ReportScheduleInput) => ({
    name: input.name,
    targetKind: input.target.kind,
    targetId: input.target.id ?? null,
    frequency: input.frequency,
    recipients: input.recipients,
    excludeMaintenance: input.excludeMaintenance,
    brandName: input.brandName,
  });

  function emailData(report: SlaReport, heading: string) {
    return {
      heading,
      subject: report.target.kind === "workspace" ? report.workspaceName : report.target.name,
      period: periodLabel(report.from, report.to),
      uptimePercent: report.totals.uptimePercent,
      downtimeMinutes: Number(minutesText(report.totals.downtimeSeconds)),
      incidents: report.totals.incidents,
      monitorCount: report.rows.length,
      worst: [...report.rows]
        .filter((r) => r.downtimeSeconds > 0)
        .sort((a, b) => b.downtimeSeconds - a.downtimeSeconds)
        .slice(0, TOP_MONITORS)
        .map((r) => ({
          name: r.name,
          uptimePercent: r.uptimePercent,
          downtimeMinutes: Number(minutesText(r.downtimeSeconds)),
        })),
    };
  }

  function pdfLink(scope: WorkspaceScope, query: SlaQuery, brand: string | null): string {
    const token = deps.linkSigner.sign(
      {
        w: scope.workspaceId,
        k: query.target.kind,
        ...(query.target.id === undefined ? {} : { i: query.target.id }),
        f: query.from.getTime(),
        t: query.to.getTime(),
        x: query.excludeMaintenance,
        ...(brand === null ? {} : { b: brand }),
      },
      new Date(clock.now().getTime() + LINK_DAYS * DAY),
    );
    return `${deps.webOrigin}/api/public/reports/${token}/sla.pdf`;
  }

  async function sendSchedule(
    row: ReportScheduleRow,
    period: { from: Date; to: Date },
  ): Promise<boolean> {
    const scope = createWorkspaceScope({ workspaceId: row.workspaceId });
    if (row.recipients.length === 0) return false;
    /* A workspace that left the plan keeps its schedules; they start again when it comes back. */
    if (!(await deps.hasFeature(scope, "slaReports"))) return false;
    const brand =
      row.brandName !== null && (await deps.hasFeature(scope, "whiteLabel")) ? row.brandName : null;
    const query: SlaQuery = {
      target: targetOf(row),
      from: period.from,
      to: period.to,
      excludeMaintenance: row.excludeMaintenance,
    };
    let report: SlaReport;
    try {
      report = await build(scope, query, false);
    } catch (err) {
      /* Its monitor, group or page is gone: nothing to send until someone edits the schedule. */
      if (err instanceof NotFoundError) return false;
      throw err;
    }
    const data = {
      ...emailData(report, row.name),
      brand,
      url: pdfLink(scope, query, brand),
      linkLabel: "Download the PDF",
    };
    return deps.db.transaction(async (tx) => {
      if (!(await repo.claimPeriod(tx, row.id, period.from))) return false;
      for (const recipient of row.recipients) {
        const unsubscribeUrl = `${deps.webOrigin}/api/public/reports/unsubscribe?token=${encodeURIComponent(
          deps.unsubscribeSigner.sign(
            { s: row.id, w: row.workspaceId, r: recipient },
            new Date(clock.now().getTime() + UNSUBSCRIBE_DAYS * DAY),
          ),
        )}`;
        await deps.outbox.emit(
          tx,
          "email.requested",
          {
            template: "sla-report",
            to: recipient,
            data: { ...data, unsubscribeUrl },
            idempotencyKey: `report.${row.id}.${period.from.getTime()}.${recipient}`,
            headers: {
              "List-Unsubscribe": `<${unsubscribeUrl}>`,
              "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
            },
          },
          { workspaceId: row.workspaceId },
        );
      }
      return true;
    });
  }

  /* ---- Monthly uptime email ---- */

  async function sendMonthly(
    workspaceId: string,
    period: { from: Date; to: Date },
  ): Promise<boolean> {
    const scope = createWorkspaceScope({ workspaceId });
    if (!(await deps.hasFeature(scope, "monthlyEmailReport"))) return false;
    const recipients = (await deps.workspaces.listMembers(scope)).filter(
      (m) => m.role === "owner" || m.role === "admin",
    );
    if (recipients.length === 0) return false;
    const query: SlaQuery = {
      target: { kind: "workspace" },
      from: period.from,
      to: period.to,
      excludeMaintenance: true,
    };
    const report = await build(scope, query, false);
    if (report.rows.length === 0) return false;
    const settingsUrl = `${deps.webOrigin}/w/${workspaceId}/settings`;
    const data = {
      ...emailData(report, "Monthly uptime report"),
      brand: null,
      url: `${deps.webOrigin}/w/${workspaceId}/reports`,
      linkLabel: "Open the report",
      unsubscribeUrl: settingsUrl,
    };
    return deps.db.transaction(async (tx) => {
      if (!(await repo.claimSend(tx, workspaceId, "monthly", period.from))) return false;
      for (const member of recipients) {
        await deps.outbox.emit(
          tx,
          "email.requested",
          {
            template: "sla-report",
            to: member.email,
            data,
            idempotencyKey: `report.monthly.${workspaceId}.${period.from.getTime()}.${member.userId}`,
            headers: { "List-Unsubscribe": `<${settingsUrl}>` },
          },
          { workspaceId },
        );
      }
      return true;
    });
  }

  /* ---- Weekly digest ---- */

  /*
   * A short reading of the week by the model, or null: AI not set up, nothing to say, budget used,
   * or the call failed. The digest goes out either way.
   */
  async function digestInsight(
    scope: WorkspaceScope,
    from: Date,
    evidence: Record<string, unknown>,
  ): Promise<string | null> {
    if (deps.ai === undefined || !deps.ai.configured()) return null;
    try {
      const result = await deps.ai.generate(scope, {
        prompt: "digestInsight",
        refId: digestRef(scope.workspaceId, from),
        evidence,
        once: true,
      });
      return result.ok ? result.output.insight : null;
    } catch (err) {
      deps.logger.warn({ err, workspaceId: scope.workspaceId }, "digest insight failed");
      return null;
    }
  }

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
    const topMonitors = downtime
      .filter((d) => d.seconds > 0)
      .map((d) => ({
        name: names.get(d.monitorId) ?? "Deleted monitor",
        uptimePercent: Math.round((1 - d.seconds / rangeSeconds) * 1_000_000) / 10_000,
        downtimeMinutes: d.seconds / 60,
      }));

    let insight: string | null = null;
    if (stats.opened > 0 || topMonitors.length > 0) {
      const [before, noisiest] = await Promise.all([
        deps.incidents.stats(workspaceId, new Date(from.getTime() - 7 * DAY), from),
        deps.incidents.noisiest(scope, TOP_MONITORS),
      ]);
      insight = await digestInsight(scope, from, {
        thisWeek: {
          incidents: stats.opened,
          resolved: stats.resolved,
          meanMinutesToResolve: stats.mttrMinutes === null ? null : Math.round(stats.mttrMinutes),
        },
        lastWeek: {
          incidents: before.opened,
          resolved: before.resolved,
          meanMinutesToResolve: before.mttrMinutes === null ? null : Math.round(before.mttrMinutes),
        },
        mostDowntime: topMonitors.map((m) => ({
          name: m.name,
          minutesDown: Math.round(m.downtimeMinutes),
          uptimePercent: m.uptimePercent,
        })),
        alertedMostInLast30Days: noisiest.map((n) => ({
          name: n.name,
          incidents: n.stats.incidents,
          falseAlarms: n.stats.falseAlarms,
        })),
      });
    }

    const data = {
      workspaceName: name,
      weekStart: from.toISOString().slice(0, 10),
      weekEnd: new Date(to.getTime() - DAY).toISOString().slice(0, 10),
      incidents: stats.opened,
      resolved: stats.resolved,
      mttrMinutes: stats.mttrMinutes,
      monitors: topMonitors,
      totalMonitors: monitors.data.filter((m) => m.type !== "heartbeat").length,
      insight,
      url: `${deps.webOrigin}/w/${workspaceId}/overview`,
      settingsUrl,
    };

    return deps.db.transaction(async (tx) => {
      if (!(await repo.claimDigest(tx, workspaceId, from))) return false;
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

  /* Runs `send` for every workspace, a page at a time; one workspace's failure doesn't stop the rest. */
  async function eachWorkspace(
    what: string,
    send: (workspaceId: string) => Promise<boolean>,
  ): Promise<number> {
    let sent = 0;
    let afterId: string | undefined;
    for (;;) {
      const ids = await deps.workspaces.workspaceIds({
        limit: PAGE,
        ...(afterId === undefined ? {} : { afterId }),
      });
      for (const id of ids) {
        try {
          if (await send(id)) sent += 1;
        } catch (err) {
          deps.logger.error({ err, workspaceId: id }, `${what} failed`);
        }
      }
      if (ids.length < PAGE) return sent;
      afterId = ids.at(-1);
    }
  }

  return {
    async sendDigest(workspaceId) {
      const week = duePeriod("weekly", clock.now());
      if (week === undefined) return false;
      if (await repo.digestSent(deps.db, workspaceId, week.from)) return false;
      return sendOne(workspaceId, week.from, week.to);
    },

    async sendWeeklyDigests() {
      const week = duePeriod("weekly", clock.now());
      if (week === undefined) return 0;
      return eachWorkspace("weekly digest", async (id) => {
        if (await repo.digestSent(deps.db, id, week.from)) return false;
        return sendOne(id, week.from, week.to);
      });
    },

    async sendMonthlyEmail(workspaceId) {
      const month = duePeriod("monthly", clock.now());
      if (month === undefined) return false;
      if (await repo.sendRecorded(deps.db, workspaceId, "monthly", month.from)) return false;
      return sendMonthly(workspaceId, month);
    },

    async sendMonthlyEmails() {
      const month = duePeriod("monthly", clock.now());
      if (month === undefined) return 0;
      return eachWorkspace("monthly uptime email", async (id) => {
        if (await repo.sendRecorded(deps.db, id, "monthly", month.from)) return false;
        return sendMonthly(id, month);
      });
    },

    sla: (scope, query) => build(scope, query, true),

    async slaCsv(scope, query) {
      await requireFeature(
        scope,
        "slaReports",
        "SLA reports as files are part of the Pro plan. Upgrade to download them.",
      );
      const report = await build(scope, query, true);
      return { fileName: slaFileName(report, "csv"), body: slaCsv(report) };
    },

    async slaPdf(scope, query, brandName) {
      await requireFeature(
        scope,
        "slaReports",
        "SLA reports as files are part of the Pro plan. Upgrade to download them.",
      );
      if (brandName !== undefined) {
        await requireFeature(
          scope,
          "whiteLabel",
          "Reports under your own name are part of the Business plan.",
        );
      }
      return pdfOf(await build(scope, query, true), brandName ?? null);
    },

    async listSchedules(scope) {
      const rows = await repo.listSchedules(deps.db, scope);
      return Promise.all(rows.map((row) => toView(scope, row)));
    },

    async createSchedule(scope, input) {
      await checkSchedule(scope, input);
      if ((await repo.countSchedules(deps.db, scope)) >= REPORT_MAX_SCHEDULES) {
        throw new QuotaExceededError(
          `A workspace can have ${REPORT_MAX_SCHEDULES} report schedules. Delete one first.`,
        );
      }
      const row = await repo.insertSchedule(deps.db, scope, {
        id: deps.newId(),
        ...scheduleValues(input),
      });
      return toView(scope, row);
    },

    async updateSchedule(scope, id, input) {
      await checkSchedule(scope, input);
      const row = await repo.updateSchedule(deps.db, scope, id, scheduleValues(input), clock.now());
      if (row === undefined) throw new NotFoundError("Report schedule not found.");
      return toView(scope, row);
    },

    async deleteSchedule(scope, id) {
      if (!(await repo.deleteSchedule(deps.db, scope, id))) {
        throw new NotFoundError("Report schedule not found.");
      }
    },

    async sendScheduledReports() {
      let sent = 0;
      for (const frequency of ["weekly", "monthly"] as const) {
        const period = duePeriod(frequency, clock.now());
        if (period === undefined) continue;
        let afterId: string | undefined;
        for (;;) {
          const rows = await repo.dueSchedules(deps.db, frequency, period, {
            afterId,
            limit: PAGE,
          });
          for (const row of rows) {
            try {
              if (await sendSchedule(row, period)) sent += 1;
            } catch (err) {
              deps.logger.error({ err, scheduleId: row.id }, "scheduled report failed");
            }
          }
          if (rows.length < PAGE) break;
          afterId = rows.at(-1)?.id;
        }
      }
      return sent;
    },

    async sharedPdf(token) {
      const payload = deps.linkSigner.verify(token, clock.now());
      if (payload === undefined) return undefined;
      const scope = createWorkspaceScope({ workspaceId: payload.w });
      try {
        const report = await build(
          scope,
          {
            target:
              payload.i === undefined ? { kind: payload.k } : { kind: payload.k, id: payload.i },
            from: new Date(payload.f),
            to: new Date(payload.t),
            excludeMaintenance: payload.x,
          },
          false,
        );
        return await pdfOf(report, payload.b ?? null);
      } catch (err) {
        /* What the link was about has been deleted. */
        if (err instanceof NotFoundError) return undefined;
        throw err;
      }
    },

    async unsubscribe(token) {
      const payload = deps.unsubscribeSigner.verify(token, clock.now());
      if (payload === undefined) return false;
      await repo.removeRecipient(deps.db, payload.s, payload.w, payload.r);
      return true;
    },
  };
}
