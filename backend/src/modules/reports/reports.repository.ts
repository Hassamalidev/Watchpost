/* Queries on digest_sends, report_schedules and report_sends, owned by the reports module. */
import { and, asc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import type { ReportFrequency } from "@app/shared";
import type { WorkspaceScope } from "../../core/workspace-scope.js";
import { tenantWhere, withWorkspace, type DbOrTx } from "../../infra/db/index.js";
import { digestSends, reportSchedules, reportSends } from "./schema/reports.js";

export type ReportScheduleRow = typeof reportSchedules.$inferSelect;
type ScheduleValues = Omit<
  typeof reportSchedules.$inferInsert,
  "workspaceId" | "lastPeriodStart" | "createdAt" | "updatedAt"
>;

export type ReportsRepository = ReturnType<typeof createReportsRepository>;

export function createReportsRepository() {
  return {
    async digestSent(tx: DbOrTx, workspaceId: string, weekStart: Date): Promise<boolean> {
      const rows = await tx
        .select({ workspaceId: digestSends.workspaceId })
        .from(digestSends)
        .where(and(eq(digestSends.workspaceId, workspaceId), eq(digestSends.weekStart, weekStart)));
      return rows.length > 0;
    },

    /* True if this call claimed the week for the workspace. */
    async claimDigest(tx: DbOrTx, workspaceId: string, weekStart: Date): Promise<boolean> {
      const rows = await tx
        .insert(digestSends)
        .values({ workspaceId, weekStart })
        .onConflictDoNothing()
        .returning({ workspaceId: digestSends.workspaceId });
      return rows.length > 0;
    },

    async sendRecorded(
      tx: DbOrTx,
      workspaceId: string,
      kind: string,
      periodStart: Date,
    ): Promise<boolean> {
      const rows = await tx
        .select({ workspaceId: reportSends.workspaceId })
        .from(reportSends)
        .where(
          and(
            eq(reportSends.workspaceId, workspaceId),
            eq(reportSends.kind, kind),
            eq(reportSends.periodStart, periodStart),
          ),
        );
      return rows.length > 0;
    },

    /* True if this call claimed the period for the workspace. */
    async claimSend(
      tx: DbOrTx,
      workspaceId: string,
      kind: string,
      periodStart: Date,
    ): Promise<boolean> {
      const rows = await tx
        .insert(reportSends)
        .values({ workspaceId, kind, periodStart })
        .onConflictDoNothing()
        .returning({ workspaceId: reportSends.workspaceId });
      return rows.length > 0;
    },

    async listSchedules(tx: DbOrTx, scope: WorkspaceScope): Promise<ReportScheduleRow[]> {
      return tx
        .select()
        .from(reportSchedules)
        .where(tenantWhere(scope, reportSchedules))
        .orderBy(asc(reportSchedules.createdAt), asc(reportSchedules.id));
    },

    async countSchedules(tx: DbOrTx, scope: WorkspaceScope): Promise<number> {
      const [row] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(reportSchedules)
        .where(tenantWhere(scope, reportSchedules));
      return row?.n ?? 0;
    },

    async findSchedule(
      tx: DbOrTx,
      scope: WorkspaceScope,
      id: string,
    ): Promise<ReportScheduleRow | undefined> {
      const rows = await tx
        .select()
        .from(reportSchedules)
        .where(tenantWhere(scope, reportSchedules, eq(reportSchedules.id, id)));
      return rows[0];
    },

    async insertSchedule(
      tx: DbOrTx,
      scope: WorkspaceScope,
      values: ScheduleValues,
    ): Promise<ReportScheduleRow> {
      const rows = await tx
        .insert(reportSchedules)
        .values(withWorkspace(scope, values))
        .returning();
      const row = rows[0];
      if (row === undefined) throw new Error("report schedule insert returned no row");
      return row;
    },

    async updateSchedule(
      tx: DbOrTx,
      scope: WorkspaceScope,
      id: string,
      values: Partial<Omit<ScheduleValues, "id">>,
      now: Date,
    ): Promise<ReportScheduleRow | undefined> {
      const rows = await tx
        .update(reportSchedules)
        .set({ ...values, updatedAt: now })
        .where(tenantWhere(scope, reportSchedules, eq(reportSchedules.id, id)))
        .returning();
      return rows[0];
    },

    async deleteSchedule(tx: DbOrTx, scope: WorkspaceScope, id: string): Promise<boolean> {
      const rows = await tx
        .delete(reportSchedules)
        .where(tenantWhere(scope, reportSchedules, eq(reportSchedules.id, id)))
        .returning({ id: reportSchedules.id });
      return rows.length > 0;
    },

    /*
     * System: schedules of one frequency that haven't sent the given period and existed before it
     * ended, so a schedule's first report covers the period it was created in.
     */
    async dueSchedules(
      tx: DbOrTx,
      frequency: ReportFrequency,
      period: { from: Date; to: Date },
      options: { afterId?: string | undefined; limit: number },
    ): Promise<ReportScheduleRow[]> {
      return tx
        .select()
        .from(reportSchedules)
        .where(
          and(
            eq(reportSchedules.frequency, frequency),
            lt(reportSchedules.createdAt, period.to),
            or(
              isNull(reportSchedules.lastPeriodStart),
              lt(reportSchedules.lastPeriodStart, period.from),
            ),
            options.afterId === undefined ? undefined : gt(reportSchedules.id, options.afterId),
          ),
        )
        .orderBy(asc(reportSchedules.id))
        .limit(options.limit);
    },

    /* True if this call marked the period as sent (two workers can't both send it). */
    async claimPeriod(tx: DbOrTx, id: string, periodStart: Date): Promise<boolean> {
      const rows = await tx
        .update(reportSchedules)
        .set({ lastPeriodStart: periodStart })
        .where(
          and(
            eq(reportSchedules.id, id),
            or(
              isNull(reportSchedules.lastPeriodStart),
              lt(reportSchedules.lastPeriodStart, periodStart),
            ),
          ),
        )
        .returning({ id: reportSchedules.id });
      return rows.length > 0;
    },

    /* System (an unsubscribe link): takes one address off a schedule. */
    async removeRecipient(
      tx: DbOrTx,
      id: string,
      workspaceId: string,
      email: string,
    ): Promise<boolean> {
      const rows = await tx
        .update(reportSchedules)
        .set({ recipients: sql`array_remove(${reportSchedules.recipients}, ${email})` })
        .where(and(eq(reportSchedules.id, id), eq(reportSchedules.workspaceId, workspaceId)))
        .returning({ id: reportSchedules.id });
      return rows.length > 0;
    },
  };
}
