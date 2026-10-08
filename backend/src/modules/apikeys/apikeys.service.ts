/*
 * API keys for the public API (PRODUCT.md §6.13). A key belongs to a workspace, not to a person: it
 * keeps working when its maker leaves, and it stops when someone revokes it or it expires. It looks
 * like `wp_<12 characters>_<40 characters>`; the first part finds the row and the whole key is
 * compared by hash, so a database leak doesn't leak keys.
 *
 * Idempotency: a write sent with an `Idempotency-Key` is done once; sending the key again within 24
 * hours returns the first answer. The same key with a different request is a conflict.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  API_KEYS_PER_WORKSPACE,
  API_KEY_PREFIX,
  IDEMPOTENCY_KEY_HOURS,
  isWriteScope,
  type ApiKeyView,
  type CreateApiKeyInput,
  type CreatedApiKey,
  type PlanFeature,
} from "@app/shared";
import type { Clock } from "../../core/clock.js";
import { NotFoundError, QuotaExceededError } from "../../core/errors.js";
import { createWorkspaceScope, type WorkspaceScope } from "../../core/workspace-scope.js";
import type { ApiKeyRow, ApikeysRepository } from "./apikeys.repository.js";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const KEY_PATTERN = new RegExp(`^${API_KEY_PREFIX}_([A-Za-z0-9]{12})_[A-Za-z0-9]{40}$`);
export const WRITE_NEEDS_PLAN =
  "Changing things through the API is part of the paid plans. The Free plan can read.";

/* Letters and digits from random bytes, without the bias a plain modulo would add. */
function randomText(length: number): string {
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= 248) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}

const hashOf = (key: string) => createHash("sha256").update(key).digest("hex");

export type IdempotencyStart =
  | { state: "new" }
  | { state: "replay"; status: number; response: unknown }
  | { state: "in_progress" }
  | { state: "mismatch" };

export interface AuthenticatedKey {
  key: ApiKeyRow;
  scope: WorkspaceScope;
}

export interface ApikeysService {
  list(scope: WorkspaceScope): Promise<ApiKeyView[]>;
  /* The only moment the whole key exists outside the caller's hands. */
  create(scope: WorkspaceScope, input: CreateApiKeyInput): Promise<CreatedApiKey>;
  revoke(scope: WorkspaceScope, id: string): Promise<ApiKeyView>;
  /* System: the key behind an `Authorization` header, or undefined if it doesn't open anything. */
  authenticate(presented: string): Promise<AuthenticatedKey | undefined>;
  hasFeature(scope: WorkspaceScope, feature: PlanFeature): Promise<boolean>;
  workspaceName(scope: WorkspaceScope): Promise<string>;
  startIdempotent(
    scope: WorkspaceScope,
    key: string,
    fingerprint: string,
  ): Promise<IdempotencyStart>;
  finishIdempotent(
    scope: WorkspaceScope,
    key: string,
    answer: { status: number; response: unknown } | undefined,
  ): Promise<void>;
  /* System: forgets idempotency keys older than 24 hours; returns how many. */
  purgeIdempotencyKeys(): Promise<number>;
}

export function createApikeysService(deps: {
  repository: ApikeysRepository;
  hasFeature: (scope: WorkspaceScope, feature: PlanFeature) => Promise<boolean>;
  workspaceName: (scope: WorkspaceScope) => Promise<string>;
  clock: Clock;
  newId: () => string;
}): ApikeysService {
  const { repository: repo, clock } = deps;

  const toView = (row: ApiKeyRow): ApiKeyView => ({
    id: row.id,
    name: row.name,
    prefix: `${API_KEY_PREFIX}_${row.prefix}`,
    scopes: row.scopes,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  });

  return {
    async list(scope) {
      return (await repo.list(scope)).map(toView);
    },

    async create(scope, input) {
      if (input.scopes.some(isWriteScope) && !(await deps.hasFeature(scope, "apiWrite"))) {
        throw new QuotaExceededError(WRITE_NEEDS_PLAN);
      }
      if ((await repo.countActive(scope)) >= API_KEYS_PER_WORKSPACE) {
        throw new QuotaExceededError(
          `A workspace can have ${API_KEYS_PER_WORKSPACE} API keys. Revoke one first.`,
        );
      }
      const prefix = randomText(12);
      const key = `${API_KEY_PREFIX}_${prefix}_${randomText(40)}`;
      const now = clock.now();
      const row = await repo.insert(scope, {
        id: deps.newId(),
        name: input.name,
        prefix,
        hash: hashOf(key),
        scopes: input.scopes,
        createdBy: scope.actorUserId ?? null,
        expiresAt:
          input.expiresInDays === null
            ? null
            : new Date(now.getTime() + input.expiresInDays * 86_400_000),
        createdAt: now,
      });
      return { ...toView(row), key };
    },

    async revoke(scope, id) {
      const row = await repo.revoke(scope, id, clock.now());
      if (row === undefined) throw new NotFoundError("API key not found.");
      return toView(row);
    },

    async authenticate(presented) {
      const match = KEY_PATTERN.exec(presented);
      if (match?.[1] === undefined) return undefined;
      const row = await repo.findByPrefix(match[1]);
      if (row === undefined) return undefined;
      const given = Buffer.from(hashOf(presented), "hex");
      const stored = Buffer.from(row.hash, "hex");
      if (given.length !== stored.length || !timingSafeEqual(given, stored)) return undefined;
      const now = clock.now();
      if (row.revokedAt !== null) return undefined;
      if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) return undefined;
      await repo.touch(row.id, now);
      return { key: row, scope: createWorkspaceScope({ workspaceId: row.workspaceId }) };
    },

    hasFeature: (scope, feature) => deps.hasFeature(scope, feature),
    workspaceName: (scope) => deps.workspaceName(scope),

    async startIdempotent(scope, key, fingerprint) {
      if (await repo.claimIdempotencyKey(scope, key, fingerprint, clock.now())) {
        return { state: "new" };
      }
      const row = await repo.findIdempotencyKey(scope, key);
      /* It was released between our two reads: the caller may simply try again. */
      if (row === undefined) return { state: "in_progress" };
      if (row.fingerprint !== fingerprint) return { state: "mismatch" };
      if (row.status === null) return { state: "in_progress" };
      return { state: "replay", status: row.status, response: row.response };
    },

    async finishIdempotent(scope, key, answer) {
      if (answer === undefined) await repo.releaseIdempotencyKey(scope, key);
      else await repo.storeIdempotentAnswer(scope, key, answer.status, answer.response);
    },

    purgeIdempotencyKeys: () =>
      repo.deleteIdempotencyKeysBefore(
        new Date(clock.now().getTime() - IDEMPOTENCY_KEY_HOURS * 3_600_000),
      ),
  };
}
