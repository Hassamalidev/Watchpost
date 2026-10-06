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
} from "@app/shared";
import { z } from "zod";
import type { Clock } from "../../core/clock.js";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
  ValidationError,
} from "../../core/errors.js";
import type { WorkspaceScope } from "../../core/workspace-scope.js";
import type { Db, DbOrTx } from "../../infra/db/index.js";
import type { Outbox } from "../../infra/outbox/index.js";
import type { WorkspacesService } from "../workspaces/index.js";
import type { ContactsRepository } from "./contacts.repository.js";
import type { ContactMethodRow } from "./schema/contacts.js";

export const CODE_TTL_MS = 10 * 60_000;
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
  outbox: Outbox;
  clock: Clock;
  newId: () => string;
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

  function normalize(input: CreateContactMethodInput): string {
    if (input.type !== "email") {
      /* SMS and voice methods arrive with P4-T02b (they need the workspace's alert credits). */
      throw new ValidationError("Only email contact methods can be added for now.", [
        { path: "body.type", message: "Only email contact methods can be added for now." },
      ]);
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
      const created = await repo.insertMethod(deps.db, scope, {
        id: deps.newId(),
        userId,
        type: input.type,
        address,
        label: input.label ?? null,
        verifiedAt: null,
      });
      if (created === undefined) throw new ConflictError("You already have this contact method.");
      await service.requestCode(scope, created.id);
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
