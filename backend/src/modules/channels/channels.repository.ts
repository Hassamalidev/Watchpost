/* Queries on channels and message_refs, owned by the channels module. */
import { and, asc, desc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import { assertWorkspaceScope, type WorkspaceScope } from "../../core/workspace-scope.js";
import { tenantWhere, withWorkspace, type DbOrTx } from "../../infra/db/index.js";
import {
  channels,
  directRefs,
  messageRefs,
  phoneNumbers,
  slackInstallations,
  telegramChats,
  type ChannelRow,
  type PhoneNumberRow,
  type SlackInstallationRow,
} from "./schema/channels.js";

export type ChannelsRepository = ReturnType<typeof createChannelsRepository>;

export function createChannelsRepository() {
  return {
    async list(tx: DbOrTx, scope: WorkspaceScope): Promise<ChannelRow[]> {
      return tx
        .select()
        .from(channels)
        .where(tenantWhere(scope, channels))
        .orderBy(asc(channels.name), asc(channels.id));
    },

    async findScoped(
      tx: DbOrTx,
      scope: WorkspaceScope,
      id: string,
    ): Promise<ChannelRow | undefined> {
      const rows = await tx
        .select()
        .from(channels)
        .where(tenantWhere(scope, channels, eq(channels.id, id)))
        .limit(1);
      return rows[0];
    },

    async insert(
      tx: DbOrTx,
      scope: WorkspaceScope,
      row: Omit<typeof channels.$inferInsert, "workspaceId">,
    ): Promise<ChannelRow> {
      const [created] = await tx.insert(channels).values(withWorkspace(scope, row)).returning();
      if (created === undefined) throw new Error("channel insert returned nothing");
      return created;
    },

    async updateScoped(
      tx: DbOrTx,
      scope: WorkspaceScope,
      id: string,
      patch: Partial<Pick<ChannelRow, "name" | "configEnc" | "rules">>,
    ): Promise<ChannelRow | undefined> {
      const [row] = await tx
        .update(channels)
        .set({ ...patch, updatedAt: sql`now()` })
        .where(tenantWhere(scope, channels, eq(channels.id, id)))
        .returning();
      return row;
    },

    async deleteScoped(tx: DbOrTx, scope: WorkspaceScope, id: string): Promise<boolean> {
      const rows = await tx
        .delete(channels)
        .where(tenantWhere(scope, channels, eq(channels.id, id)))
        .returning({ id: channels.id });
      return rows.length > 0;
    },

    /* System queries (alerting). */

    async findById(tx: DbOrTx, id: string, lock = false): Promise<ChannelRow | undefined> {
      const query = tx.select().from(channels).where(eq(channels.id, id)).limit(1);
      const rows = lock ? await query.for("update") : await query;
      return rows[0];
    },

    async existing(
      tx: DbOrTx,
      scope: WorkspaceScope,
      ids: string[],
    ): Promise<Array<Pick<ChannelRow, "id" | "type" | "name" | "status" | "rules">>> {
      assertWorkspaceScope(scope);
      if (ids.length === 0) return [];
      return tx
        .select({
          id: channels.id,
          type: channels.type,
          name: channels.name,
          status: channels.status,
          rules: channels.rules,
        })
        .from(channels)
        .where(and(eq(channels.workspaceId, scope.workspaceId), inArray(channels.id, ids)));
    },

    async recordSuccess(tx: DbOrTx, id: string, at: Date): Promise<ChannelRow | undefined> {
      const [row] = await tx
        .update(channels)
        .set({ lastSuccessAt: at, failureCount: 0, updatedAt: sql`now()` })
        .where(eq(channels.id, id))
        .returning();
      return row;
    },

    async recordFailure(tx: DbOrTx, id: string, at: Date, error: string): Promise<void> {
      await tx
        .update(channels)
        .set({
          lastFailureAt: at,
          lastError: error.slice(0, 1_000),
          failureCount: sql`${channels.failureCount} + 1`,
          updatedAt: sql`now()`,
        })
        .where(eq(channels.id, id));
    },

    async setStatus(tx: DbOrTx, id: string, status: ChannelRow["status"]): Promise<void> {
      await tx
        .update(channels)
        .set({ status, updatedAt: sql`now()` })
        .where(eq(channels.id, id));
    },

    async threadRef(tx: DbOrTx, incidentId: string, channelId: string): Promise<string | null> {
      const rows = await tx
        .select({ providerRef: messageRefs.providerRef })
        .from(messageRefs)
        .where(and(eq(messageRefs.incidentId, incidentId), eq(messageRefs.channelId, channelId)))
        .limit(1);
      return rows[0]?.providerRef ?? null;
    },

    async setConfig(tx: DbOrTx, id: string, configEnc: string): Promise<void> {
      await tx
        .update(channels)
        .set({ configEnc, updatedAt: sql`now()` })
        .where(eq(channels.id, id));
    },

    /* Slack installations */

    async upsertSlackInstallation(
      tx: DbOrTx,
      row: typeof slackInstallations.$inferInsert,
    ): Promise<SlackInstallationRow> {
      const [saved] = await tx
        .insert(slackInstallations)
        .values(row)
        .onConflictDoUpdate({
          target: [slackInstallations.workspaceId, slackInstallations.teamId],
          set: {
            teamName: row.teamName,
            botUserId: row.botUserId,
            botTokenEnc: row.botTokenEnc,
            scopes: row.scopes,
            installedBy: row.installedBy,
            updatedAt: sql`now()`,
          },
        })
        .returning();
      if (saved === undefined) throw new Error("slack installation upsert returned nothing");
      return saved;
    },

    async slackInstallations(tx: DbOrTx, scope: WorkspaceScope): Promise<SlackInstallationRow[]> {
      assertWorkspaceScope(scope);
      return tx
        .select()
        .from(slackInstallations)
        .where(eq(slackInstallations.workspaceId, scope.workspaceId))
        .orderBy(asc(slackInstallations.teamName));
    },

    async slackInstallation(tx: DbOrTx, id: string): Promise<SlackInstallationRow | undefined> {
      const rows = await tx
        .select()
        .from(slackInstallations)
        .where(eq(slackInstallations.id, id))
        .limit(1);
      return rows[0];
    },

    /* System: every workspace this Slack team is installed in. */
    async slackTeamWorkspaces(tx: DbOrTx, teamId: string): Promise<string[]> {
      const rows = await tx
        .select({ workspaceId: slackInstallations.workspaceId })
        .from(slackInstallations)
        .where(eq(slackInstallations.teamId, teamId));
      return rows.map((r) => r.workspaceId);
    },

    /* Telegram links */

    async upsertTelegramLink(
      tx: DbOrTx,
      row: {
        id: string;
        workspaceId: string;
        channelId: string;
        linkToken: string;
        tokenExpiresAt: Date;
      },
    ): Promise<void> {
      await tx
        .insert(telegramChats)
        .values(row)
        .onConflictDoUpdate({
          target: telegramChats.channelId,
          set: { linkToken: row.linkToken, tokenExpiresAt: row.tokenExpiresAt },
        });
    },

    /* Consumes a link token (once, before it expires); returns the channel it links. */
    async consumeTelegramToken(
      tx: DbOrTx,
      token: string,
      chat: { chatId: string; chatTitle: string | null },
      now: Date,
    ): Promise<{ channelId: string; workspaceId: string } | undefined> {
      const [row] = await tx
        .update(telegramChats)
        .set({ ...chat, linkToken: null, tokenExpiresAt: null, linkedAt: now })
        .where(and(eq(telegramChats.linkToken, token), gt(telegramChats.tokenExpiresAt, now)))
        .returning({ channelId: telegramChats.channelId, workspaceId: telegramChats.workspaceId });
      return row;
    },

    /* Phone numbers (SMS and voice). */

    async findPhone(
      tx: DbOrTx,
      scope: WorkspaceScope,
      phone: string,
    ): Promise<PhoneNumberRow | undefined> {
      const rows = await tx
        .select()
        .from(phoneNumbers)
        .where(tenantWhere(scope, phoneNumbers, eq(phoneNumbers.phone, phone)))
        .limit(1);
      return rows[0];
    },

    /* Stores a new code for the number; a number that is already verified stays verified. */
    async savePhoneCode(
      tx: DbOrTx,
      scope: WorkspaceScope,
      row: Pick<
        typeof phoneNumbers.$inferInsert,
        | "id"
        | "phone"
        | "codeHash"
        | "codeExpiresAt"
        | "sendCount"
        | "sendWindowStart"
        | "createdBy"
      >,
    ): Promise<void> {
      const code = {
        codeHash: row.codeHash,
        codeExpiresAt: row.codeExpiresAt,
        sendCount: row.sendCount,
        sendWindowStart: row.sendWindowStart,
        attempts: 0,
      };
      await tx
        .insert(phoneNumbers)
        .values(withWorkspace(scope, { ...row, attempts: 0 }))
        .onConflictDoUpdate({
          target: [phoneNumbers.workspaceId, phoneNumbers.phone],
          set: code,
        });
    },

    async countPhoneAttempt(tx: DbOrTx, scope: WorkspaceScope, phone: string): Promise<void> {
      await tx
        .update(phoneNumbers)
        .set({ attempts: sql`${phoneNumbers.attempts} + 1` })
        .where(tenantWhere(scope, phoneNumbers, eq(phoneNumbers.phone, phone)));
    },

    async markPhoneVerified(
      tx: DbOrTx,
      scope: WorkspaceScope,
      phone: string,
      at: Date,
    ): Promise<void> {
      await tx
        .update(phoneNumbers)
        .set({ verifiedAt: at, codeHash: null, codeExpiresAt: null, attempts: 0 })
        .where(tenantWhere(scope, phoneNumbers, eq(phoneNumbers.phone, phone)));
    },

    /* System (inbound replies): every workspace that verified this number. */
    async workspacesWithPhone(tx: DbOrTx, phone: string): Promise<string[]> {
      const rows = await tx
        .select({ workspaceId: phoneNumbers.workspaceId })
        .from(phoneNumbers)
        .where(and(eq(phoneNumbers.phone, phone), isNotNull(phoneNumbers.verifiedAt)));
      return rows.map((r) => r.workspaceId);
    },

    async phoneChannels(tx: DbOrTx, workspaceIds: string[]): Promise<ChannelRow[]> {
      if (workspaceIds.length === 0) return [];
      return tx
        .select()
        .from(channels)
        .where(
          and(
            inArray(channels.workspaceId, workspaceIds),
            inArray(channels.type, ["sms", "voice"]),
          ),
        );
    },

    /* The newest alert sent through any of these channels, optionally for one incident. */
    async latestRef(
      tx: DbOrTx,
      channelIds: string[],
      incidentId?: string,
    ): Promise<
      { workspaceId: string; incidentId: string; channelId: string; createdAt: Date } | undefined
    > {
      if (channelIds.length === 0) return undefined;
      const rows = await tx
        .select({
          workspaceId: messageRefs.workspaceId,
          incidentId: messageRefs.incidentId,
          channelId: messageRefs.channelId,
          createdAt: messageRefs.createdAt,
        })
        .from(messageRefs)
        .where(
          and(
            inArray(messageRefs.channelId, channelIds),
            incidentId === undefined ? undefined : eq(messageRefs.incidentId, incidentId),
          ),
        )
        .orderBy(desc(messageRefs.createdAt), desc(messageRefs.id))
        .limit(1);
      return rows[0];
    },

    /* The channel whose first message for this incident has exactly this provider reference. */
    async messageTarget(
      tx: DbOrTx,
      providerRef: string,
      incidentId: string,
    ): Promise<{ workspaceId: string; channelId: string; channelName: string } | undefined> {
      const rows = await tx
        .select({
          workspaceId: messageRefs.workspaceId,
          channelId: messageRefs.channelId,
          channelName: channels.name,
        })
        .from(messageRefs)
        .innerJoin(channels, eq(channels.id, messageRefs.channelId))
        .where(
          and(eq(messageRefs.providerRef, providerRef), eq(messageRefs.incidentId, incidentId)),
        )
        .limit(1);
      return rows[0];
    },

    async saveDirectRef(tx: DbOrTx, row: typeof directRefs.$inferInsert): Promise<void> {
      await tx
        .insert(directRefs)
        .values(row)
        .onConflictDoUpdate({
          target: [directRefs.incidentId, directRefs.address],
          set: { createdAt: sql`now()`, userId: row.userId ?? null },
        });
    },

    /* The newest alert sent straight to this number, optionally for one incident. */
    async latestDirectRef(
      tx: DbOrTx,
      address: string,
      incidentId?: string,
    ): Promise<
      | { workspaceId: string; incidentId: string; userId: string | null; createdAt: Date }
      | undefined
    > {
      const rows = await tx
        .select({
          workspaceId: directRefs.workspaceId,
          incidentId: directRefs.incidentId,
          userId: directRefs.userId,
          createdAt: directRefs.createdAt,
        })
        .from(directRefs)
        .where(
          and(
            eq(directRefs.address, address),
            incidentId === undefined ? undefined : eq(directRefs.incidentId, incidentId),
          ),
        )
        .orderBy(desc(directRefs.createdAt), desc(directRefs.id))
        .limit(1);
      return rows[0];
    },

    async saveThreadRef(tx: DbOrTx, row: typeof messageRefs.$inferInsert): Promise<void> {
      await tx
        .insert(messageRefs)
        .values(row)
        .onConflictDoNothing({ target: [messageRefs.incidentId, messageRefs.channelId] });
    },
  };
}
