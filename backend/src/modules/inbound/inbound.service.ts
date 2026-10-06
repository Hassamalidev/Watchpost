/*
 * Inbound alerts (PRODUCT.md §6.8): sources with a token URL, and the ingest that turns a tool's
 * payload into incidents. A trigger opens an incident unless one with the same key is already open
 * (dedup); a resolve closes that incident (auto-resolve). The key is scoped to the source, so two
 * tools can't close each other's incidents.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  type CreateInboundSourceInput,
  type InboundEvent,
  type InboundResult,
  type InboundSourceView,
} from "@app/shared";
import type { Clock } from "../../core/clock.js";
import { NotFoundError } from "../../core/errors.js";
import type { WorkspaceScope } from "../../core/workspace-scope.js";
import type { Db } from "../../infra/db/index.js";
import type { IncidentsService } from "../incidents/index.js";
import type { InboundRepository } from "./inbound.repository.js";
import { parseInbound } from "./parsers.js";
import type { InboundSourceRow } from "./schema/inbound.js";

export interface InboundService {
  list(scope: WorkspaceScope): Promise<InboundSourceView[]>;
  /* The URL carries the token and is returned only here and from `rotate`. */
  create(
    scope: WorkspaceScope,
    input: CreateInboundSourceInput,
  ): Promise<InboundSourceView & { url: string }>;
  rotate(scope: WorkspaceScope, id: string): Promise<InboundSourceView & { url: string }>;
  delete(scope: WorkspaceScope, id: string): Promise<void>;
  /* What a payload would do, without doing it (the tester). */
  preview(scope: WorkspaceScope, id: string, payload: unknown): Promise<InboundEvent[]>;
  /* Token URL: undefined for an unknown token; throws a ValidationError for an unreadable payload. */
  ingest(token: string, payload: unknown): Promise<InboundResult | undefined>;
}

export interface InboundServiceDeps {
  db: Db;
  repository: InboundRepository;
  incidents: Pick<IncidentsService, "openInbound" | "resolveByDedupKey">;
  clock: Clock;
  newId: () => string;
  /* Where the API is reached from outside. */
  publicOrigin: string;
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export function createInboundService(deps: InboundServiceDeps): InboundService {
  const { repository: repo, clock } = deps;

  const toView = (row: InboundSourceRow): InboundSourceView => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    tokenHint: row.tokenHint,
    lastReceivedAt: row.lastReceivedAt === null ? null : row.lastReceivedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  });

  const newToken = () => {
    const token = randomBytes(24).toString("base64url");
    return { token, tokenHash: hashToken(token), tokenHint: token.slice(0, 6) };
  };
  /* Email sources take what an inbound-mail provider posts; the path says so. */
  const urlOf = (row: InboundSourceRow, token: string) =>
    `${deps.publicOrigin}/api/inbound/${token}${row.kind === "email" ? "/email" : ""}`;

  return {
    async list(scope) {
      return (await repo.list(deps.db, scope)).map(toView);
    },

    async create(scope, input) {
      const { token, tokenHash, tokenHint } = newToken();
      const row = await repo.insert(deps.db, scope, {
        id: deps.newId(),
        name: input.name,
        kind: input.kind,
        tokenHash,
        tokenHint,
        createdBy: scope.actorUserId ?? null,
      });
      return { ...toView(row), url: urlOf(row, token) };
    },

    async rotate(scope, id) {
      const { token, tokenHash, tokenHint } = newToken();
      const row = await repo.setToken(deps.db, scope, id, { tokenHash, tokenHint });
      if (row === undefined) throw new NotFoundError("Inbound source not found.");
      return { ...toView(row), url: urlOf(row, token) };
    },

    async delete(scope, id) {
      if (!(await repo.delete(deps.db, scope, id))) {
        throw new NotFoundError("Inbound source not found.");
      }
    },

    async preview(scope, id, payload) {
      const source = await repo.find(deps.db, scope, id);
      if (source === undefined) throw new NotFoundError("Inbound source not found.");
      return parseInbound(source.kind, payload);
    },

    async ingest(token, payload) {
      const source = await repo.findByTokenHash(deps.db, hashToken(token));
      if (source === undefined) return undefined;
      const events = parseInbound(source.kind, payload);
      const result: InboundResult = { received: events.length, opened: 0, resolved: 0, ignored: 0 };
      for (const event of events) {
        const dedupKey = `inbound:${source.id}:${event.key}`;
        /* One transaction per alert: a bad one doesn't undo the others in the same request. */
        const outcome = await deps.db.transaction(async (tx) => {
          if (event.status === "resolve") {
            return (await deps.incidents.resolveByDedupKey(tx, source.workspaceId, dedupKey))
              ? "resolved"
              : "ignored";
          }
          const { created } = await deps.incidents.openInbound(tx, {
            workspaceId: source.workspaceId,
            dedupKey,
            title: event.title,
            severity: event.severity,
            evidence: {
              source: source.name,
              kind: source.kind,
              description: event.description,
              link: event.link,
            },
          });
          return created ? "opened" : "ignored";
        });
        result[outcome] += 1;
      }
      await repo.touch(deps.db, source.id, clock.now());
      return result;
    },
  };
}
