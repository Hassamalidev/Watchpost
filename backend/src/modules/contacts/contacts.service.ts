/*
 * Contact methods and personal notification rules (PRODUCT.md §6.5, §9.5). Everything here is about
 * the acting user's own methods; nobody edits someone else's. A method is used only once its owner
 * has entered the one-time code sent to it; the account email is trusted already (Better Auth
 * verified it) and is added on first use, so everyone who can be paged is reachable from day one.
 * `fanOut` is what alerting asks: for this user and urgency, which address hears when.
 */
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import {
  DEFAULT_RULE_DELAYS,
  MAX_CONTACT_METHODS,
  URGENCIES,
  planFanOut,
  type ContactMethodView,
  type CreateContactMethodInput,
  type FanOutStep,
  type NotificationRuleInput,
  type NotificationRulesView,
  type Urgency,
  phoneNumberSchema,
} from "@app/shared";
import { z } from "zod";
import type { WorkspaceRole } from "@app/shared";
import type { Clock } from "../../core/clock.js";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
  ValidationError,
} from "../../core/errors.js";
import { createWorkspaceScope, type WorkspaceScope } from "../../core/workspace-scope.js";
import type { Db, DbOrTx } from "../../infra/db/index.js";
import type { Outbox } from "../../infra/outbox/index.js";
import type { TokenSigner } from "../../infra/signed-token.js";
import type { PhonesService } from "../channels/index.js";
import type { WorkspacesService } from "../workspaces/index.js";
import type { ContactsRepository } from "./contacts.repository.js";
import type { ContactMethodRow } from "./schema/contacts.js";

export const CODE_TTL_MS = 10 * 60_000;
export const CHAT_LINK_TTL_MS = 30 * 60_000;

export type ChatProvider = "slack" | "telegram";

/* What a "link your chat user" token carries. */
export interface ChatLinkClaims {
  workspaceId: string;
  provider: ChatProvider;
  externalId: string;
  externalName: string | null;
}

export interface ChatLinkView {
  id: string;
  provider: ChatProvider;
  externalName: string | null;
  linkedAt: string;
}
export const MAX_CODE_ATTEMPTS = 5;
export const MAX_CODES_PER_HOUR = 3;
const HOUR_MS = 3_600_000;

/* One step of a fan-out with the moment it is due. */
export interface TimedFanOutStep extends FanOutStep {
  dueAt: Date;
}

export interface ContactsService {
  listMethods(scope: WorkspaceScope): Promise<ContactMethodView[]>;
  addMethod(scope: WorkspaceScope, input: CreateContactMethodInput): Promise<ContactMethodView>;
  removeMethod(scope: WorkspaceScope, id: string): Promise<void>;
  /* Sends a new one-time code to the method. */
  requestCode(scope: WorkspaceScope, id: string): Promise<{ expiresAt: string }>;
  confirm(scope: WorkspaceScope, id: string, code: string): Promise<ContactMethodView>;
  rules(scope: WorkspaceScope): Promise<NotificationRulesView>;
  replaceRules(
    scope: WorkspaceScope,
    urgency: Urgency,
    rules: NotificationRuleInput[],
  ): Promise<NotificationRulesView>;
  /* System: the member a chat user is linked to, with their current role. */
  chatUser(
    workspaceId: string,
    provider: ChatProvider,
    externalId: string,
  ): Promise<{ userId: string; role: WorkspaceRole } | undefined>;
  /* System: the page where a signed-in member confirms that a chat user is theirs. */
  chatLinkUrl(claims: ChatLinkClaims): string;
  /* What a link token is about, before confirming; undefined when it is forged or expired. */
  chatLinkPreview(
    scope: WorkspaceScope,
    token: string,
  ): { provider: ChatProvider; externalName: string | null } | undefined;
  /* Ties the chat user in the token to the acting member. */
  claimChatLink(scope: WorkspaceScope, token: string): Promise<ChatLinkView[]>;
  listChatLinks(scope: WorkspaceScope): Promise<ChatLinkView[]>;
  removeChatLink(scope: WorkspaceScope, id: string): Promise<void>;
  /* System: who-hears-when for a member, counted from `from`. Empty for someone who left. */
  fanOut(
    scope: WorkspaceScope,
    userId: string,
    urgency: Urgency,
    from: Date,
  ): Promise<TimedFanOutStep[]>;
}

export interface ContactsServiceDeps {
  db: Db;
  repository: ContactsRepository;
  workspaces: Pick<WorkspacesService, "listMembers" | "workspaceName">;
  /*
   * Phone numbers are verified per workspace by `channels` (an SMS code, charged in alert credits);
   * without it only email methods can be added.
   */
  phones?: Pick<PhonesService, "requestCode" | "confirm" | "isVerified"> | undefined;
  outbox: Outbox;
  clock: Clock;
  newId: () => string;
  /* Signs "link this chat user" tokens; the page they open is under `webOrigin`. */
  linkSigner: TokenSigner<ChatLinkClaims>;
  webOrigin: string;
  /* Tests fix the code. */
  newCode?: () => string;
}

const emailAddress = z.email();

export function createContactsService(deps: ContactsServiceDeps): ContactsService {
  const { repository: repo, clock } = deps;
  const newCode = deps.newCode ?? (() => String(randomInt(0, 1_000_000)).padStart(6, "0"));
  const hash = (methodId: string, code: string) =>
    createHash("sha256").update(`${methodId}:${code}`).digest("hex");

  const toView = (row: ContactMethodRow): ContactMethodView => ({
    id: row.id,
    type: row.type,
    address: row.address,
    label: row.label,
    verified: row.verifiedAt !== null,
    createdAt: row.createdAt.toISOString(),
  });

  function actorOf(scope: WorkspaceScope): string {
    if (scope.actorUserId === undefined) {
      throw new ForbiddenError("Contact methods belong to a signed-in member.");
    }
    return scope.actorUserId;
  }

  /* The rules a method gets when it becomes usable; existing rules for it are left alone. */
  async function addDefaultRules(db: DbOrTx, scope: WorkspaceScope, method: ContactMethodRow) {
    await repo.insertRules(
      db,
      scope,
      URGENCIES.flatMap((urgency) => {
        const delayMinutes = DEFAULT_RULE_DELAYS[method.type][urgency];
        return delayMinutes === undefined
          ? []
          : [
              {
                id: deps.newId(),
                userId: method.userId,
                urgency,
                delayMinutes,
                contactMethodId: method.id,
              },
            ];
      }),
    );
  }

  /* Adds the member's account email, verified, the first time their methods are needed. */
  async function ensureAccountEmail(
    scope: WorkspaceScope,
    userId: string,
  ): Promise<ContactMethodRow[]> {
    const existing = await repo.listMethods(deps.db, scope, userId);
    if (existing.length > 0) return existing;
    const member = (await deps.workspaces.listMembers(scope)).find((m) => m.userId === userId);
    if (member === undefined) return [];
    await deps.db.transaction(async (tx) => {
      const created = await repo.insertMethod(tx, scope, {
        id: deps.newId(),
        userId,
        type: "email",
        address: member.email.toLowerCase(),
        label: null,
        verifiedAt: clock.now(),
      });
      /* Nothing came back: a concurrent request added it first, with its rules. */
      if (created !== undefined) await addDefaultRules(tx, scope, created);
    });
    return repo.listMethods(deps.db, scope, userId);
  }

  async function ownMethod(scope: WorkspaceScope, id: string): Promise<ContactMethodRow> {
    const row = await repo.findMethod(deps.db, scope, actorOf(scope), id);
    if (row === undefined) throw new NotFoundError("Contact method not found.");
    return row;
  }

  async function rulesOf(scope: WorkspaceScope, userId: string): Promise<NotificationRulesView> {
    const view: NotificationRulesView = { high: [], low: [] };
    for (const rule of await repo.listRules(deps.db, scope, userId)) {
      view[rule.urgency].push({
        contactMethodId: rule.contactMethodId,
        delayMinutes: rule.delayMinutes,
      });
    }
    return view;
  }

  function phonesOrFail(): NonNullable<ContactsServiceDeps["phones"]> {
    if (deps.phones === undefined) {
      throw new ValidationError("Text messages and calls aren't set up on this server yet.", [
        { path: "body.type", message: "Text messages and calls aren't set up on this server yet." },
      ]);
    }
    return deps.phones;
  }

  function normalize(input: CreateContactMethodInput): string {
    if (input.type !== "email") {
      const phone = phoneNumberSchema.safeParse(input.address);
      if (!phone.success) {
        const message = "Use the international format, like +14155550123.";
        throw new ValidationError(message, [{ path: "body.address", message }]);
      }
      return phone.data;
    }
    const parsed = emailAddress.safeParse(input.address.toLowerCase());
    if (!parsed.success) {
      throw new ValidationError("That isn't an email address.", [
        { path: "body.address", message: "That isn't an email address." },
      ]);
    }
    return parsed.data;
  }

  const service: ContactsService = {
    async listMethods(scope) {
      return (await ensureAccountEmail(scope, actorOf(scope))).map(toView);
    },

    async addMethod(scope, input) {
      const userId = actorOf(scope);
      const address = normalize(input);
      const existing = await ensureAccountEmail(scope, userId);
      if (existing.length >= MAX_CONTACT_METHODS) {
        throw new ValidationError(`You can have at most ${MAX_CONTACT_METHODS} contact methods.`);
      }
      if (existing.some((m) => m.type === input.type && m.address === address)) {
        throw new ConflictError("You already have this contact method.");
      }
      /*
       * A number the workspace verified before (your SMS method, when you add calls to it) is ready
       * at once. Otherwise the code goes out first: if it can't be sent, nothing is added.
       */
      let verifiedAt: Date | null = null;
      if (input.type !== "email") {
        const phones = phonesOrFail();
        if (await phones.isVerified(scope.workspaceId, address)) verifiedAt = clock.now();
        else await phones.requestCode(scope, address);
      }
      const created = await deps.db.transaction(async (tx) => {
        const row = await repo.insertMethod(tx, scope, {
          id: deps.newId(),
          userId,
          type: input.type,
          address,
          label: input.label ?? null,
          verifiedAt,
        });
        if (row !== undefined && verifiedAt !== null) await addDefaultRules(tx, scope, row);
        return row;
      });
      if (created === undefined) throw new ConflictError("You already have this contact method.");
      if (input.type === "email") await service.requestCode(scope, created.id);
      return toView(created);
    },

    async removeMethod(scope, id) {
      const userId = actorOf(scope);
      const row = await ownMethod(scope, id);
      const others = (await repo.listMethods(deps.db, scope, userId)).filter(
        (m) => m.id !== id && m.verifiedAt !== null,
      );
      if (row.verifiedAt !== null && others.length === 0) {
        throw new ConflictError(
          "This is your only verified contact method. Add and verify another one first, or alerts couldn't reach you.",
        );
      }
      await repo.deleteMethod(deps.db, scope, id);
    },

    async requestCode(scope, id) {
      const row = await ownMethod(scope, id);
      if (row.verifiedAt !== null) throw new ConflictError("This contact method is verified.");
      if (row.type !== "email") {
        const sent = await phonesOrFail().requestCode(scope, row.address);
        return { expiresAt: sent.expiresAt };
      }
      const now = clock.now();
      const windowOpen =
        row.codeWindowStart !== null && now.getTime() - row.codeWindowStart.getTime() < HOUR_MS;
      const sent = windowOpen ? row.codeSendCount : 0;
      if (sent >= MAX_CODES_PER_HOUR) {
        throw new RateLimitedError("Too many codes were sent. Try again in an hour.");
      }
      const code = newCode();
      const expiresAt = new Date(now.getTime() + CODE_TTL_MS);
      const workspaceName = await deps.workspaces.workspaceName(scope);
      await deps.db.transaction(async (tx) => {
        await repo.updateMethod(tx, scope, id, {
          codeHash: hash(id, code),
          codeExpiresAt: expiresAt,
          codeAttempts: 0,
          codeSendCount: sent + 1,
          codeWindowStart: windowOpen ? row.codeWindowStart : now,
        });
        await deps.outbox.emit(
          tx,
          "email.requested",
          {
            template: "contact-code",
            to: row.address,
            data: { code, workspaceName },
            idempotencyKey: `contact-code.${id}.${now.getTime()}`,
          },
          { workspaceId: scope.workspaceId },
        );
      });
      return { expiresAt: expiresAt.toISOString() };
    },

    async confirm(scope, id, code) {
      const userId = actorOf(scope);
      const wrong = () =>
        new ValidationError("That code isn't right or has expired.", [
          { path: "body.code", message: "That code isn't right or has expired." },
        ]);
      const phone = await repo.findMethod(deps.db, scope, userId, id);
      if (phone !== undefined && phone.type !== "email" && phone.verifiedAt === null) {
        /* Throws when the code is wrong, expired or guessed too often. */
        await phonesOrFail().confirm(scope, phone.address, code);
        const verifiedAt = clock.now();
        await deps.db.transaction(async (tx) => {
          await repo.updateMethod(tx, scope, id, { verifiedAt });
          await addDefaultRules(tx, scope, { ...phone, verifiedAt });
        });
        return toView({ ...phone, verifiedAt });
      }
      const outcome = await deps.db.transaction(async (tx) => {
        const row = await repo.findMethod(tx, scope, userId, id, true);
        if (row === undefined) return "missing" as const;
        if (row.verifiedAt !== null) return row;
        if (
          row.codeHash === null ||
          row.codeExpiresAt === null ||
          row.codeExpiresAt.getTime() <= clock.now().getTime()
        ) {
          return "wrong" as const;
        }
        if (row.codeAttempts >= MAX_CODE_ATTEMPTS) return "locked" as const;
        const expected = Buffer.from(row.codeHash);
        const given = Buffer.from(hash(id, code));
        if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
          await repo.countWrongCode(tx, scope, id);
          return "wrong" as const;
        }
        const verifiedAt = clock.now();
        await repo.updateMethod(tx, scope, id, {
          verifiedAt,
          codeHash: null,
          codeExpiresAt: null,
          codeAttempts: 0,
        });
        const verified = { ...row, verifiedAt };
        await addDefaultRules(tx, scope, verified);
        return verified;
      });
      if (outcome === "missing") throw new NotFoundError("Contact method not found.");
      if (outcome === "locked") {
        throw new RateLimitedError("Too many wrong codes. Send a new code and try again.");
      }
      if (outcome === "wrong") throw wrong();
      return toView(outcome);
    },

    async rules(scope) {
      const userId = actorOf(scope);
      await ensureAccountEmail(scope, userId);
      return rulesOf(scope, userId);
    },

    async replaceRules(scope, urgency, rules) {
      const userId = actorOf(scope);
      const methods = new Map(
        (await ensureAccountEmail(scope, userId)).map((m) => [m.id, m] as const),
      );
      const seen = new Set<string>();
      for (const [i, rule] of rules.entries()) {
        const method = methods.get(rule.contactMethodId);
        const problem =
          method === undefined
            ? "This isn't one of your contact methods."
            : method.verifiedAt === null
              ? "Verify this contact method before using it in a rule."
              : seen.has(rule.contactMethodId)
                ? "A contact method can appear once per urgency."
                : undefined;
        if (problem !== undefined) {
          throw new ValidationError(problem, [
            { path: `body.rules.${i}.contactMethodId`, message: problem },
          ]);
        }
        seen.add(rule.contactMethodId);
      }
      await deps.db.transaction(async (tx) => {
        await repo.deleteRules(tx, scope, userId, urgency);
        await repo.insertRules(
          tx,
          scope,
          rules.map((rule) => ({ id: deps.newId(), userId, urgency, ...rule })),
        );
      });
      return rulesOf(scope, userId);
    },

    async chatUser(workspaceId, provider, externalId) {
      const scope = createWorkspaceScope({ workspaceId });
      const link = await repo.findChatLink(deps.db, scope, provider, externalId);
      if (link === undefined) return undefined;
      /* The role is read now, so a demoted or removed member loses what the link could do. */
      const member = (await deps.workspaces.listMembers(scope)).find(
        (m) => m.userId === link.userId,
      );
      return member === undefined ? undefined : { userId: member.userId, role: member.role };
    },

    chatLinkUrl(claims) {
      const token = deps.linkSigner.sign(
        claims,
        new Date(clock.now().getTime() + CHAT_LINK_TTL_MS),
      );
      return `${deps.webOrigin}/w/${claims.workspaceId}/notifications?link=${encodeURIComponent(token)}`;
    },

    chatLinkPreview(scope, token) {
      const claims = deps.linkSigner.verify(token, clock.now());
      if (claims === undefined || claims.workspaceId !== scope.workspaceId) return undefined;
      return { provider: claims.provider, externalName: claims.externalName };
    },

    async claimChatLink(scope, token) {
      const userId = actorOf(scope);
      const claims = deps.linkSigner.verify(token, clock.now());
      if (claims === undefined || claims.workspaceId !== scope.workspaceId) {
        throw new ValidationError("This link has expired. Ask for a new one in the chat app.", [
          { path: "body.token", message: "This link has expired or isn't for this workspace." },
        ]);
      }
      await repo.saveChatLink(deps.db, scope, {
        id: deps.newId(),
        userId,
        provider: claims.provider,
        externalId: claims.externalId,
        externalName: claims.externalName,
      });
      return service.listChatLinks(scope);
    },

    async listChatLinks(scope) {
      return (await repo.listChatLinks(deps.db, scope, actorOf(scope))).map((row) => ({
        id: row.id,
        provider: row.provider,
        externalName: row.externalName,
        linkedAt: row.createdAt.toISOString(),
      }));
    },

    async removeChatLink(scope, id) {
      if (!(await repo.deleteChatLink(deps.db, scope, actorOf(scope), id))) {
        throw new NotFoundError("Linked account not found.");
      }
    },

    async fanOut(scope, userId, urgency, from) {
      const methods = await ensureAccountEmail(scope, userId);
      const rules = (await rulesOf(scope, userId))[urgency];
      return planFanOut(
        rules,
        methods.map((m) => ({
          id: m.id,
          type: m.type,
          address: m.address,
          verified: m.verifiedAt !== null,
        })),
      ).map((step) => ({ ...step, dueAt: new Date(from.getTime() + step.delayMinutes * 60_000) }));
    },
  };
  return service;
}
