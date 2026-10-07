/* Drizzle queries for this module's own tables only (tables go in schema/). */
import { and, asc, eq, sql } from "drizzle-orm";
import type { ContactMethodType, Urgency } from "@app/shared";
import type { WorkspaceScope } from "../../core/workspace-scope.js";
import { tenantWhere, withWorkspace, type DbOrTx } from "../../infra/db/index.js";
import {
  chatLinks,
  contactMethods,
  notificationRules,
  type ChatLinkRow,
  type ContactMethodRow,
  type NotificationRuleRow,
} from "./schema/contacts.js";

export type ContactsRepository = ReturnType<typeof createContactsRepository>;

export function createContactsRepository() {
  const ofUser = (scope: WorkspaceScope, userId: string) =>
    tenantWhere(scope, contactMethods, eq(contactMethods.userId, userId));

  return {
    async listMethods(
      db: DbOrTx,
      scope: WorkspaceScope,
      userId: string,
    ): Promise<ContactMethodRow[]> {
      return db
        .select()
        .from(contactMethods)
        .where(ofUser(scope, userId))
        .orderBy(asc(contactMethods.createdAt), asc(contactMethods.id));
    },

    async findMethod(
      db: DbOrTx,
      scope: WorkspaceScope,
      userId: string,
      id: string,
      forUpdate = false,
    ): Promise<ContactMethodRow | undefined> {
      const query = db
        .select()
        .from(contactMethods)
        .where(and(ofUser(scope, userId), eq(contactMethods.id, id)))
        .limit(1);
      const rows = await (forUpdate ? query.for("update") : query);
      return rows[0];
    },

    /* Returns nothing when the user already has this address. */
    async insertMethod(
      db: DbOrTx,
      scope: WorkspaceScope,
      row: {
        id: string;
        userId: string;
        type: ContactMethodType;
        address: string;
        label: string | null;
        verifiedAt: Date | null;
        pushKeys?: { p256dh: string; auth: string } | null;
      },
    ): Promise<ContactMethodRow | undefined> {
      const [created] = await db
        .insert(contactMethods)
        .values(withWorkspace(scope, row))
        .onConflictDoNothing()
        .returning();
      return created;
    },

    async updateMethod(
      db: DbOrTx,
      scope: WorkspaceScope,
      id: string,
      patch: Partial<
        Pick<
          ContactMethodRow,
          | "verifiedAt"
          | "codeHash"
          | "codeExpiresAt"
          | "codeAttempts"
          | "codeSendCount"
          | "codeWindowStart"
        >
      >,
    ): Promise<void> {
      await db
        .update(contactMethods)
        .set({ ...patch, updatedAt: sql`now()` })
        .where(tenantWhere(scope, contactMethods, eq(contactMethods.id, id)));
    },

    async countWrongCode(db: DbOrTx, scope: WorkspaceScope, id: string): Promise<void> {
      await db
        .update(contactMethods)
        .set({ codeAttempts: sql`${contactMethods.codeAttempts} + 1`, updatedAt: sql`now()` })
        .where(tenantWhere(scope, contactMethods, eq(contactMethods.id, id)));
    },

    /* System: a method by ID, whoever owns it (delivery reads a push subscription this way). */
    async findMethodById(
      db: DbOrTx,
      scope: WorkspaceScope,
      id: string,
    ): Promise<ContactMethodRow | undefined> {
      const rows = await db
        .select()
        .from(contactMethods)
        .where(tenantWhere(scope, contactMethods, eq(contactMethods.id, id)))
        .limit(1);
      return rows[0];
    },

    async deleteMethod(db: DbOrTx, scope: WorkspaceScope, id: string): Promise<void> {
      await db
        .delete(contactMethods)
        .where(tenantWhere(scope, contactMethods, eq(contactMethods.id, id)));
    },

    async findChatLink(
      db: DbOrTx,
      scope: WorkspaceScope,
      provider: ChatLinkRow["provider"],
      externalId: string,
    ): Promise<ChatLinkRow | undefined> {
      const rows = await db
        .select()
        .from(chatLinks)
        .where(
          tenantWhere(
            scope,
            chatLinks,
            eq(chatLinks.provider, provider),
            eq(chatLinks.externalId, externalId),
          ),
        )
        .limit(1);
      return rows[0];
    },

    async listChatLinks(db: DbOrTx, scope: WorkspaceScope, userId: string): Promise<ChatLinkRow[]> {
      return db
        .select()
        .from(chatLinks)
        .where(tenantWhere(scope, chatLinks, eq(chatLinks.userId, userId)))
        .orderBy(asc(chatLinks.createdAt), asc(chatLinks.id));
    },

    /* A chat user belongs to one member: linking again moves it to whoever linked last. */
    async saveChatLink(
      db: DbOrTx,
      scope: WorkspaceScope,
      row: Pick<ChatLinkRow, "id" | "userId" | "provider" | "externalId" | "externalName">,
    ): Promise<void> {
      await db
        .insert(chatLinks)
        .values(withWorkspace(scope, row))
        .onConflictDoUpdate({
          target: [chatLinks.workspaceId, chatLinks.provider, chatLinks.externalId],
          set: { userId: row.userId, externalName: row.externalName, createdAt: sql`now()` },
        });
    },

    async deleteChatLink(
      db: DbOrTx,
      scope: WorkspaceScope,
      userId: string,
      id: string,
    ): Promise<boolean> {
      const rows = await db
        .delete(chatLinks)
        .where(tenantWhere(scope, chatLinks, eq(chatLinks.userId, userId), eq(chatLinks.id, id)))
        .returning({ id: chatLinks.id });
      return rows.length > 0;
    },

    async listRules(
      db: DbOrTx,
      scope: WorkspaceScope,
      userId: string,
    ): Promise<NotificationRuleRow[]> {
      return db
        .select()
        .from(notificationRules)
        .where(tenantWhere(scope, notificationRules, eq(notificationRules.userId, userId)))
        .orderBy(asc(notificationRules.delayMinutes), asc(notificationRules.id));
    },

    async insertRules(
      db: DbOrTx,
      scope: WorkspaceScope,
      rows: Array<{
        id: string;
        userId: string;
        urgency: Urgency;
        delayMinutes: number;
        contactMethodId: string;
      }>,
    ): Promise<void> {
      if (rows.length === 0) return;
      await db
        .insert(notificationRules)
        .values(rows.map((row) => withWorkspace(scope, row)))
        .onConflictDoNothing();
    },

    async deleteRules(
      db: DbOrTx,
      scope: WorkspaceScope,
      userId: string,
      urgency: Urgency,
    ): Promise<void> {
      await db
        .delete(notificationRules)
        .where(
          tenantWhere(
            scope,
            notificationRules,
            eq(notificationRules.userId, userId),
            eq(notificationRules.urgency, urgency),
          ),
        );
    },
  };
}
