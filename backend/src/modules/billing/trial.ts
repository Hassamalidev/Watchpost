/*
 * The card-less 14-day Pro trial (PRODUCT.md §5, P3-T03): emails on day 1, day 7, day 12 and when it
 * ends. The trial date lives in workspace_settings; the drop to Free is the plan resolver's job (the
 * billing clock announces it). This file only decides which email is due and sends each one once.
 */
import type { Clock } from "../../core/clock.js";
import { createWorkspaceScope } from "../../core/workspace-scope.js";
import { PLANS, TRIAL_PLAN } from "../../config/plans.js";
import type { Db } from "../../infra/db/index.js";
import type { BillingEmailKind } from "../../infra/email/index.js";
import type { Logger } from "../../infra/logger.js";
import { TRIAL_DAYS, type WorkspacesService } from "../workspaces/index.js";
import type { BillingRepository } from "./billing.repository.js";
import type { PaddleSync } from "./paddle-sync.js";

const DAY_MS = 86_400_000;
const TRIAL_LENGTH_DAYS = TRIAL_DAYS;
/* The welcome email only makes sense on the first day. */
const WELCOME_WINDOW_MS = DAY_MS;
/* "Your trial ended" is not sent for trials that ended long ago (a backfill, a long outage). */
const ENDED_WINDOW_MS = 3 * DAY_MS;
const PAGE = 200;

export type TrialNotice = "day1" | "day7" | "day12" | "ended";

const EMAIL: Record<TrialNotice, BillingEmailKind> = {
  day1: "trial_started",
  day7: "trial_midway",
  day12: "trial_ending",
  ended: "trial_ended",
};

/* Notices in order, with how long before the trial end each becomes due. */
const STAGES: Array<{ notice: TrialNotice; beforeEndMs: number }> = [
  { notice: "day1", beforeEndMs: TRIAL_LENGTH_DAYS * DAY_MS },
  { notice: "day7", beforeEndMs: 7 * DAY_MS },
  { notice: "day12", beforeEndMs: 2 * DAY_MS },
  { notice: "ended", beforeEndMs: 0 },
];

/*
 * Which notice is due now, which earlier ones to mark as handled without sending, and whether the due
 * one is still worth sending. Pure, so the calendar is tested without a database.
 */
export function dueTrialNotice(
  now: Date,
  trialEndsAt: Date,
): { notice: TrialNotice; send: boolean; skipped: TrialNotice[] } | null {
  const untilEnd = trialEndsAt.getTime() - now.getTime();
  const due = STAGES.filter((stage) => untilEnd <= stage.beforeEndMs);
  const current = due.at(-1);
  if (current === undefined) return null;
  const sinceDue = current.beforeEndMs - untilEnd;
  const send =
    current.notice === "day1"
      ? sinceDue < WELCOME_WINDOW_MS
      : current.notice === "ended"
        ? sinceDue < ENDED_WINDOW_MS
        : true;
  return { notice: current.notice, send, skipped: due.slice(0, -1).map((s) => s.notice) };
}

export interface TrialService {
  /* Sends the trial email that is due for one workspace, at most once. Returns what it sent. */
  notify(workspaceId: string, trialEndsAt: Date): Promise<TrialNotice | null>;
  /* Visits every workspace whose trial is running or just ended. Returns emails sent. */
  sweep(): Promise<number>;
}

const longDate = (date: Date) =>
  new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeZone: "UTC" }).format(date);

export function createTrialService(deps: {
  db: Db;
  repository: BillingRepository;
  workspaces: Pick<WorkspacesService, "trialsEndingBetween">;
  paddleSync: Pick<PaddleSync, "notify">;
  clock: Clock;
  logger: Logger;
}): TrialService {
  const { repository: repo, clock } = deps;

  const service: TrialService = {
    async notify(workspaceId, trialEndsAt) {
      const now = clock.now();
      const due = dueTrialNotice(now, trialEndsAt);
      if (due === null) return null;
      /* A workspace that already subscribed doesn't need trial reminders. */
      const live = await repo.liveSubscription(deps.db, createWorkspaceScope({ workspaceId }));
      const subscribed = live !== undefined && live.status !== "paused";
      return deps.db.transaction(async (tx) => {
        for (const notice of due.skipped) await repo.claimTrialNotice(tx, workspaceId, notice);
        const claimed = await repo.claimTrialNotice(tx, workspaceId, due.notice);
        if (!claimed || !due.send || subscribed) return null;
        await deps.paddleSync.notify(
          tx,
          workspaceId,
          EMAIL[due.notice],
          {
            planName: PLANS[TRIAL_PLAN].name,
            date: longDate(trialEndsAt),
            daysLeft: Math.max(0, Math.ceil((trialEndsAt.getTime() - now.getTime()) / DAY_MS)),
          },
          `trial:${due.notice}:${workspaceId}`,
        );
        return due.notice;
      });
    },

    async sweep() {
      const now = clock.now();
      const from = new Date(now.getTime() - ENDED_WINDOW_MS);
      const to = new Date(now.getTime() + (TRIAL_LENGTH_DAYS + 1) * DAY_MS);
      let sent = 0;
      let afterId: string | undefined;
      for (;;) {
        const trials = await deps.workspaces.trialsEndingBetween({
          from,
          to,
          afterId,
          limit: PAGE,
        });
        /*
         * Most workspaces have nothing due: their notice was handled on an earlier run. One query
         * finds those; notices too late to send are marked in one statement; only real emails take a
         * transaction each.
         */
        const handled = await repo.handledTrialNotices(
          deps.db,
          trials.map((t) => t.workspaceId),
        );
        const silent: Array<{ workspaceId: string; kind: string }> = [];
        for (const trial of trials) {
          const due = dueTrialNotice(now, trial.trialEndsAt);
          if (due === null || handled.has(`${trial.workspaceId}:${due.notice}`)) continue;
          if (!due.send) {
            for (const kind of [...due.skipped, due.notice]) {
              silent.push({ workspaceId: trial.workspaceId, kind });
            }
            continue;
          }
          try {
            if ((await service.notify(trial.workspaceId, trial.trialEndsAt)) !== null) sent += 1;
          } catch (err) {
            deps.logger.warn(
              { err, workspaceId: trial.workspaceId },
              "could not send a trial email",
            );
          }
        }
        await repo.markTrialNotices(deps.db, silent);
        if (trials.length < PAGE) return sent;
        afterId = trials.at(-1)?.workspaceId;
      }
    },
  };
  return service;
}
