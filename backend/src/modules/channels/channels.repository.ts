/* Queries on channels and message_refs, owned by the channels module. */
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { assertWorkspaceScope, type WorkspaceScope } from "../../core/workspace-scope.js";
import { tenantWhere, withWorkspace, type DbOrTx } from "../../infra/db/index.js";
import {
  channels,
  messageRefs,
  slackInstallations,
  telegramChats,
  type ChannelRow,
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
      patch: Partial<Pick<ChannelRow, "name" | "configEnc">>,
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
    ): Promise<Array<Pick<ChannelRow, "id" | "type" | "name" | "status">>> {
      assertWorkspaceScope(scope);
      if (ids.length === 0) return [];
      return tx
        .select({
          id: channels.id,
          type: channels.type,
          name: channels.name,
          status: channels.status,
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

    async saveThreadRef(tx: DbOrTx, row: typeof messageRefs.$inferInsert): Promise<void> {
      await tx
        .insert(messageRefs)
        .values(row)
        .onConflictDoNothing({ target: [messageRefs.incidentId, messageRefs.channelId] });
    },
  };
}
