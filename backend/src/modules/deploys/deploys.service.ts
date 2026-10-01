/*
 * Deploy markers (P1-T26): "the outage started 2 minutes after deploy abc123" is the most useful
 * sentence in an incident. Each workspace gets one deploy URL. CI posts to it with a one-line curl, or
 * GitHub sends `deployment_status` webhooks to `<url>/github`, signed with a secret derived from the
 * URL token and the server's auth secret (so knowing the URL alone isn't enough to forge one; rotating
 * the auth secret means re-entering the GitHub secret). The token is stored hashed and shown once.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Clock } from "../../core/clock.js";
import { createWorkspaceScope, type WorkspaceScope } from "../../core/workspace-scope.js";
import type { Db } from "../../infra/db/index.js";
import type { Logger } from "../../infra/logger.js";
import type { DeploysRepository } from "./deploys.repository.js";
import type { DeployRow, DeploySource } from "./schema/deploys.js";

export interface DeployView {
  id: string;
  source: DeploySource;
  service: string | null;
  version: string;
  environment: string | null;
  url: string | null;
  description: string | null;
  deployedAt: string;
}

export interface DeployInput {
  version: string;
  service?: string | undefined;
  environment?: string | undefined;
  url?: string | undefined;
  description?: string | undefined;
  at?: Date | undefined;
}

export interface HookStatus {
  configured: boolean;
  createdAt: string | null;
}

export interface NewHook {
  url: string;
  githubUrl: string;
  githubSecret: string;
}

export type GithubOutcome = "recorded" | "duplicate" | "ignored" | "bad_signature" | "not_found";

export interface DeploysService {
  hook(scope: WorkspaceScope): Promise<HookStatus>;
  /* Creates or replaces the deploy URL; the URL and GitHub secret are shown once. */
  rotateHook(scope: WorkspaceScope): Promise<NewHook>;
  record(token: string, input: DeployInput): Promise<"recorded" | "not_found">;
  recordGithub(
    token: string,
    event: string | undefined,
    signature: string | undefined,
    rawBody: Buffer,
  ): Promise<GithubOutcome>;
  list(scope: WorkspaceScope, from: Date, to: Date): Promise<DeployView[]>;
  /* The newest deploy in the `minutes` before `at`, for alert explanations. */
  latestBefore(scope: WorkspaceScope, at: Date, minutes: number): Promise<DeployView | undefined>;
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
/* Deploy times can't be far in the future or older than a week. */
const MAX_PAST_MS = 7 * 86_400_000;
const MAX_FUTURE_MS = 5 * 60_000;

const toView = (row: DeployRow): DeployView => ({
  id: row.id,
  source: row.source,
  service: row.service,
  version: row.version,
  environment: row.environment,
  url: row.url,
  description: row.description,
  deployedAt: row.deployedAt.toISOString(),
});

interface GithubDeploymentStatus {
  deployment_status?: {
    id?: number;
    state?: string;
    environment_url?: string;
    target_url?: string;
    description?: string;
    created_at?: string;
  };
  deployment?: { sha?: string; ref?: string; environment?: string; description?: string };
  repository?: { full_name?: string };
}

export function createDeploysService(deps: {
  db: Db;
  repository: DeploysRepository;
  clock: Clock;
  logger: Logger;
  newId: () => string;
  /* Public origin the deploy URL is served on (the web origin proxies /api). */
  publicOrigin: string;
  authSecret: string;
}): DeploysService {
  const repo = deps.repository;
  const githubSecretFor = (token: string) =>
    createHmac("sha256", deps.authSecret).update(`deploy-hook:${token}`).digest("base64url");

  function deployTime(at: Date | undefined): Date {
    const now = deps.clock.now();
    if (at === undefined) return now;
    const ms = at.getTime();
    if (ms > now.getTime() + MAX_FUTURE_MS || ms < now.getTime() - MAX_PAST_MS) return now;
    return at;
  }

  async function insert(
    workspaceId: string,
    source: DeploySource,
    input: DeployInput,
    externalId: string | null,
  ): Promise<boolean> {
    return repo.insert(deps.db, createWorkspaceScope({ workspaceId }), {
      id: deps.newId(),
      source,
      externalId,
      service: input.service ?? null,
      version: input.version,
      environment: input.environment ?? null,
      /* Only http(s): the URL becomes a link in the app. */
      url: input.url !== undefined && /^https?:\/\//i.test(input.url) ? input.url : null,
      description: input.description ?? null,
      deployedAt: deployTime(input.at),
    });
  }

  return {
    async hook(scope) {
      const row = await repo.hook(deps.db, scope);
      return { configured: row !== undefined, createdAt: row?.createdAt.toISOString() ?? null };
    },

    async rotateHook(scope) {
      const token = randomBytes(24).toString("base64url");
      await deps.db.transaction((tx) =>
        repo.replaceHook(tx, scope, {
          id: deps.newId(),
          tokenHash: hashToken(token),
          createdBy: scope.actorUserId ?? null,
        }),
      );
      const url = `${deps.publicOrigin}/api/deploys/${token}`;
      return { url, githubUrl: `${url}/github`, githubSecret: githubSecretFor(token) };
    },

    async record(token, input) {
      const workspaceId = await repo.workspaceForToken(deps.db, hashToken(token));
      if (workspaceId === undefined) return "not_found";
      await insert(workspaceId, "api", input, null);
      return "recorded";
    },

    async recordGithub(token, event, signature, rawBody) {
      const workspaceId = await repo.workspaceForToken(deps.db, hashToken(token));
      if (workspaceId === undefined) return "not_found";
      const expected = Buffer.from(
        `sha256=${createHmac("sha256", githubSecretFor(token)).update(rawBody).digest("hex")}`,
      );
      const given = Buffer.from(signature ?? "");
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        return "bad_signature";
      }
      if (event !== "deployment_status") return "ignored";
      let payload: GithubDeploymentStatus;
      try {
        payload = JSON.parse(rawBody.toString("utf8")) as GithubDeploymentStatus;
      } catch {
        return "ignored";
      }
      const status = payload.deployment_status;
      const sha = payload.deployment?.sha;
      if (status?.state !== "success" || typeof sha !== "string" || status.id === undefined) {
        return "ignored";
      }
      const created = status.created_at ? new Date(status.created_at) : undefined;
      const recorded = await insert(
        workspaceId,
        "github",
        {
          version: sha.slice(0, 12),
          service: payload.repository?.full_name?.slice(0, 100),
          environment: payload.deployment?.environment?.slice(0, 50),
          url: (status.environment_url || status.target_url)?.slice(0, 2_000),
          description: (status.description || payload.deployment?.description)?.slice(0, 500),
          at: created && !Number.isNaN(created.getTime()) ? created : undefined,
        },
        `github:${status.id}`,
      );
      return recorded ? "recorded" : "duplicate";
    },

    async list(scope, from, to) {
      return (await repo.between(deps.db, scope, from, to, 200)).map(toView);
    },

    async latestBefore(scope, at, minutes) {
      const [row] = await repo.between(
        deps.db,
        scope,
        new Date(at.getTime() - minutes * 60_000),
        at,
        1,
      );
      return row === undefined ? undefined : toView(row);
    },
  };
}
