/*
 * Phone numbers for SMS and voice channels (PRODUCT.md §5, §10). A number must be confirmed with a
 * one-time code before a channel can use it, and its cost in alert credits is shown first. The code
 * SMS is charged like any other message, so nothing is sent that a collected payment doesn't cover.
 * Inbound replies are matched to the last incident we alerted that number about.
 */
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import type { PhoneCost } from "@app/shared";
import { rateForPhone } from "../../config/messaging-rates.js";
import type { Clock } from "../../core/clock.js";
import {
  QuotaExceededError,
  RateLimitedError,
  ValidationError,
  ProviderError,
} from "../../core/errors.js";
import { createWorkspaceScope, type WorkspaceScope } from "../../core/workspace-scope.js";
import type { TokenCipher } from "../../infra/crypto.js";
import type { Db } from "../../infra/db/index.js";
import type { Logger } from "../../infra/logger.js";
import type { MessagingProvider } from "../../infra/messaging/index.js";
import type { CreditsService } from "../credits/index.js";
import type { ChannelsRepository } from "./channels.repository.js";

export const CODE_TTL_MS = 10 * 60_000;
export const MAX_CODE_ATTEMPTS = 5;
export const MAX_CODES_PER_HOUR = 3;
const HOUR_MS = 3_600_000;

export interface ReplyTarget {
  workspaceId: string;
  incidentId: string;
  /* Null when the alert went straight to a person's own number. */
  channelId: string | null;
  channelName: string;
  /* Whose number it is, when the alert went to a person. */
  userId?: string | null;
}

export interface PhonesService {
  /* Whether this server can send SMS at all, and place calls. */
  availability(): { sms: boolean; voice: boolean };
  /* What alerting this number costs. Throws for a country that isn't served. */
  cost(phone: string): PhoneCost;
  requestCode(scope: WorkspaceScope, phone: string): Promise<{ expiresAt: string } & PhoneCost>;
  confirm(scope: WorkspaceScope, phone: string, code: string): Promise<{ verified: true }>;
  isVerified(workspaceId: string, phone: string): Promise<boolean>;
  /* System: the incident a reply or keypress from this number is about, newest alert first. */
  replyTarget(phone: string, incidentId?: string): Promise<ReplyTarget | undefined>;
}

export type PaidSends = Pick<CreditsService, "charge" | "recordUsage" | "refundCharge">;

export function createPhonesService(deps: {
  db: Db;
  repository: ChannelsRepository;
  cipher: TokenCipher;
  messaging: MessagingProvider | undefined;
  credits: PaidSends | undefined;
  clock: Clock;
  logger: Logger;
  newId: () => string;
  /* Tests fix the code. */
  newCode?: () => string;
}): PhonesService {
  const { repository: repo, clock } = deps;
  const newCode = deps.newCode ?? (() => String(randomInt(0, 1_000_000)).padStart(6, "0"));
  const hash = (workspaceId: string, phone: string, code: string) =>
    createHash("sha256").update(`${workspaceId}:${phone}:${code}`).digest("hex");

  function cost(phone: string): PhoneCost {
    const rate = rateForPhone(phone);
    if (rate === undefined) {
      throw new ValidationError("Numbers in this country aren't supported yet.", [
        { path: "body.phone", message: "Numbers in this country aren't supported yet." },
      ]);
    }
    return {
      phone,
      country: rate.country,
      smsCredits: rate.smsCredits,
      voiceCredits: rate.voiceCredits,
    };
  }

  const service: PhonesService = {
    availability: () => ({
      sms: deps.messaging !== undefined && deps.credits !== undefined,
      voice: deps.messaging?.canCall === true && deps.credits !== undefined,
    }),

    cost,

    async requestCode(scope, phone) {
      const price = cost(phone);
      const { messaging, credits } = deps;
      if (messaging === undefined || credits === undefined) {
        throw new ValidationError("SMS isn't set up on this server yet.");
      }
      const now = clock.now();
      const existing = await repo.findPhone(deps.db, scope, phone);
      const windowOpen =
        existing?.sendWindowStart != null &&
        now.getTime() - existing.sendWindowStart.getTime() < HOUR_MS;
      const sentInWindow = windowOpen ? (existing?.sendCount ?? 0) : 0;
      if (sentInWindow >= MAX_CODES_PER_HOUR) {
        throw new RateLimitedError(
          "Too many codes were sent to this number. Try again in an hour.",
        );
      }

      const id = existing?.id ?? deps.newId();
      /* One charge per code sent. */
      const refId = `phone-code.${deps.newId()}`;
      const charged = await credits.charge(scope, { credits: price.smsCredits, refId });
      if (!charged.ok) {
        throw new QuotaExceededError(
          `Sending the code costs ${price.smsCredits} alert credit${price.smsCredits === 1 ? "" : "s"} and this workspace has ${charged.balance}. Alert credits come with a paid plan or a credit pack.`,
        );
      }

      const code = newCode();
      const expiresAt = new Date(now.getTime() + CODE_TTL_MS);
      await repo.savePhoneCode(deps.db, scope, {
        id,
        phone,
        codeHash: hash(scope.workspaceId, phone, code),
        codeExpiresAt: expiresAt,
        sendCount: sentInWindow + 1,
        sendWindowStart: windowOpen ? (existing?.sendWindowStart ?? now) : now,
        createdBy: scope.actorUserId ?? null,
      });
      try {
        await messaging.sendSms({
          to: phone,
          body: `Watchpost code: ${code}. It expires in 10 minutes. If you didn't ask for it, ignore this message.`,
        });
      } catch (err) {
        await credits.refundCharge(scope, refId);
        deps.logger.warn({ err, workspaceId: scope.workspaceId }, "verification SMS failed");
        throw new ProviderError(
          "twilio",
          "The code couldn't be sent. Check the number and try again; the credits were returned.",
        );
      }
      const rate = rateForPhone(phone);
      await credits.recordUsage(scope, {
        provider: "twilio",
        kind: "sms",
        units: 1,
        costMicros: rate?.smsMicros ?? 0,
        ref: refId,
      });
      return { ...price, expiresAt: expiresAt.toISOString() };
    },

    async confirm(scope, phone, code) {
      const row = await repo.findPhone(deps.db, scope, phone);
      const wrong = () =>
        new ValidationError("That code isn't right or has expired.", [
          { path: "body.code", message: "That code isn't right or has expired." },
        ]);
      if (row === undefined) throw wrong();
      if (row.verifiedAt !== null) return { verified: true };
      if (
        row.codeHash === null ||
        row.codeExpiresAt === null ||
        row.codeExpiresAt.getTime() <= clock.now().getTime()
      ) {
        throw wrong();
      }
      if (row.attempts >= MAX_CODE_ATTEMPTS) {
        throw new RateLimitedError("Too many wrong codes. Send a new code and try again.");
      }
      const expected = Buffer.from(row.codeHash);
      const given = Buffer.from(hash(scope.workspaceId, phone, code));
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        await repo.countPhoneAttempt(deps.db, scope, phone);
        throw wrong();
      }
      await repo.markPhoneVerified(deps.db, scope, phone, clock.now());
      return { verified: true };
    },

    async isVerified(workspaceId, phone) {
      const row = await repo.findPhone(deps.db, createWorkspaceScope({ workspaceId }), phone);
      return row !== undefined && row.verifiedAt !== null;
    },

    async replyTarget(phone, incidentId) {
      const viaChannel = await channelReplyTarget(phone, incidentId);
      const direct = await repo.latestDirectRef(deps.db, phone, incidentId);
      if (direct === undefined) return viaChannel;
      /* Whichever alert reached this number last is the one a reply is about. */
      if (viaChannel !== undefined && viaChannel.at.getTime() > direct.createdAt.getTime()) {
        return viaChannel;
      }
      return {
        workspaceId: direct.workspaceId,
        incidentId: direct.incidentId,
        channelId: null,
        channelName: "SMS",
        userId: direct.userId,
      };
    },
  };

  async function channelReplyTarget(
    phone: string,
    incidentId?: string,
  ): Promise<(ReplyTarget & { at: Date }) | undefined> {
    const workspaceIds = await repo.workspacesWithPhone(deps.db, phone);
    if (workspaceIds.length === 0) return undefined;
    /* Configs are encrypted, so the number is matched after reading each phone channel. */
    const mine = (await repo.phoneChannels(deps.db, workspaceIds)).filter((row) => {
      try {
        const config = JSON.parse(deps.cipher.decrypt(row.configEnc, `channel:${row.id}`)) as {
          phone?: string;
        };
        return config.phone === phone;
      } catch {
        return false;
      }
    });
    if (mine.length === 0) return undefined;
    const ref = await repo.latestRef(
      deps.db,
      mine.map((row) => row.id),
      incidentId,
    );
    if (ref === undefined) return undefined;
    const channel = mine.find((row) => row.id === ref.channelId);
    return {
      workspaceId: ref.workspaceId,
      incidentId: ref.incidentId,
      channelId: ref.channelId,
      channelName: channel?.name ?? "SMS",
      at: ref.createdAt,
    };
  }
  return service;
}
