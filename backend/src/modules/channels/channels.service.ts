/*
 * Alert channels (PRODUCT.md §6.4, §9.4): configuration (encrypted, AAD `channel:<id>`), adapters and
 * health. `deliver` sends one rendered message through a channel and records the outcome; deciding
 * what to send, retries and fallbacks belong to `alerting`. A channel turns "failing" only when
 * alerting gives up on a delivery, and "healthy" again on the next success; both emit
 * `channel.health_changed`.
 */
import type { CreateChannelInput } from "@app/shared";
import type { Clock } from "../../core/clock.js";
import { NotFoundError, ValidationError } from "../../core/errors.js";
import type { WorkspaceScope } from "../../core/workspace-scope.js";
import type { TokenCipher } from "../../infra/crypto.js";
import type { Db } from "../../infra/db/index.js";
import type { Logger } from "../../infra/logger.js";
import type { Outbox } from "../../infra/outbox/index.js";
import type { ChannelsRepository } from "./channels.repository.js";
import type { ChannelRow } from "./schema/channels.js";
import { ChannelDeliveryError, type AlertEvent, type AnyChannelAdapter } from "./types/adapter.js";

export interface ChannelView {
  id: string;
  type: ChannelRow["type"];
  name: string;
  status: ChannelRow["status"];
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface ChannelDetail extends ChannelView {
  config: Record<string, unknown>;
}

export interface ChannelSummary {
  id: string;
  workspaceId: string;
  type: ChannelRow["type"];
  name: string;
  status: ChannelRow["status"];
  lastError: string | null;
}

export interface ChannelsService {
  list(scope: WorkspaceScope): Promise<ChannelView[]>;
  get(scope: WorkspaceScope, id: string): Promise<ChannelDetail>;
  create(scope: WorkspaceScope, input: CreateChannelInput): Promise<ChannelDetail>;
  update(
    scope: WorkspaceScope,
    id: string,
    input: { name?: string | undefined; config?: Record<string, unknown> | undefined },
  ): Promise<ChannelDetail>;
  delete(scope: WorkspaceScope, id: string): Promise<void>;
  /* System: which of these channels exist in the workspace. */
  existing(scope: WorkspaceScope, ids: string[]): Promise<ChannelSummary[]>;
  summary(channelId: string): Promise<ChannelSummary | undefined>;
  /* System: renders and sends one alert event. Throws ChannelDeliveryError on failure. */
  deliver(input: {
    channelId: string;
    event: AlertEvent;
    idempotencyKey: string;
  }): Promise<{ providerRef: string | null }>;
  /* System: alerting gave up on a delivery through this channel. */
  markFailing(channelId: string): Promise<void>;
  /* How often and how patiently deliveries to this channel type are retried. */
  retryPolicy(type: ChannelRow["type"]): { attempts: number; backoffMs: number } | undefined;
}

export const channelAad = (id: string) => `channel:${id}`;
const aad = channelAad;
const iso = (d: Date | null) => (d === null ? null : d.toISOString());

export function createChannelsService(deps: {
  db: Db;
  repository: ChannelsRepository;
  adapters: AnyChannelAdapter[];
  cipher: TokenCipher;
  outbox: Outbox;
  clock: Clock;
  logger: Logger;
  newId: () => string;
}): ChannelsService {
  const { repository: repo, clock } = deps;
  const adapters = new Map(deps.adapters.map((a) => [a.type, a]));

  const adapterFor = (type: ChannelRow["type"]) => {
    const adapter = adapters.get(type);
    if (adapter === undefined) {
      throw new ValidationError(`"${type}" channels aren't available yet.`);
    }
    return adapter;
  };

  const toView = (row: ChannelRow): ChannelView => ({
    id: row.id,
    type: row.type,
    name: row.name,
    status: row.status,
    lastSuccessAt: iso(row.lastSuccessAt),
    lastFailureAt: iso(row.lastFailureAt),
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
  });

  const configOf = (row: ChannelRow): unknown =>
    JSON.parse(deps.cipher.decrypt(row.configEnc, aad(row.id)));

  const toDetail = (row: ChannelRow): ChannelDetail => {
    const adapter = adapterFor(row.type);
    const config = adapter.parseConfig(configOf(row));
    return {
      ...toView(row),
      config: adapter.redact ? adapter.redact(config) : (config as Record<string, unknown>),
    };
  };

  const toSummary = (
    row: Pick<ChannelRow, "id" | "type" | "name" | "status"> & {
      workspaceId: string;
      lastError?: string | null;
    },
  ): ChannelSummary => ({
    id: row.id,
    workspaceId: row.workspaceId,
    type: row.type,
    name: row.name,
    status: row.status,
    lastError: row.lastError ?? null,
  });

  const prepare = (
    adapter: AnyChannelAdapter,
    input: unknown,
    workspaceId: string,
    previous: unknown,
  ): Promise<unknown> =>
    adapter.prepare
      ? adapter.prepare(input, { workspaceId, previous })
      : Promise.resolve(adapter.parseConfig(input));

  async function mustFind(scope: WorkspaceScope, id: string): Promise<ChannelRow> {
    const row = await repo.findScoped(deps.db, scope, id);
    if (row === undefined) throw new NotFoundError("Channel not found.");
    return row;
  }

  async function setHealth(channelId: string, workspaceId: string, status: ChannelRow["status"]) {
    await deps.db.transaction(async (tx) => {
      const row = await repo.findById(tx, channelId, true);
      if (row === undefined || row.status === status) return;
      await repo.setStatus(tx, channelId, status);
      await deps.outbox.emit(tx, "channel.health_changed", { channelId, status }, { workspaceId });
    });
  }

  return {
    async list(scope) {
      return (await repo.list(deps.db, scope)).map(toView);
    },

    async get(scope, id) {
      return toDetail(await mustFind(scope, id));
    },

    async create(scope, input) {
      const adapter = adapterFor(input.type);
      const config = await prepare(adapter, input.config, scope.workspaceId, undefined);
      const id = deps.newId();
      const row = await repo.insert(deps.db, scope, {
        id,
        type: input.type,
        name: input.name,
        configEnc: deps.cipher.encrypt(JSON.stringify(config), aad(id)),
      });
      return toDetail(row);
    },

    async update(scope, id, input) {
      const row = await mustFind(scope, id);
      const patch: Partial<Pick<ChannelRow, "name" | "configEnc">> = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.config !== undefined) {
        const config = await prepare(
          adapterFor(row.type),
          input.config,
          scope.workspaceId,
          configOf(row),
        );
        patch.configEnc = deps.cipher.encrypt(JSON.stringify(config), aad(id));
      }
      const updated = await repo.updateScoped(deps.db, scope, id, patch);
      if (updated === undefined) throw new NotFoundError("Channel not found.");
      return toDetail(updated);
    },

    async delete(scope, id) {
      if (!(await repo.deleteScoped(deps.db, scope, id))) {
        throw new NotFoundError("Channel not found.");
      }
    },

    async existing(scope, ids) {
      return (await repo.existing(deps.db, scope, ids)).map((r) =>
        toSummary({ ...r, workspaceId: scope.workspaceId }),
      );
    },

    async summary(channelId) {
      const row = await repo.findById(deps.db, channelId);
      return row === undefined ? undefined : toSummary(row);
    },

    async deliver({ channelId, event, idempotencyKey }) {
      const row = await repo.findById(deps.db, channelId);
      if (row === undefined) throw new ChannelDeliveryError("The channel was deleted.", true);
      const adapter = adapters.get(row.type);
      if (adapter === undefined) {
        throw new ChannelDeliveryError(`No adapter for "${row.type}" channels.`, true);
      }

      let config: unknown;
      try {
        config = adapter.parseConfig(configOf(row));
      } catch (err) {
        await repo.recordFailure(
          deps.db,
          channelId,
          clock.now(),
          "The stored configuration is unreadable.",
        );
        deps.logger.error({ err, channelId }, "channel config can't be decrypted or parsed");
        throw new ChannelDeliveryError("The stored configuration is unreadable.", true);
      }

      const message = adapter.render(event);
      const threadRef =
        event.kind === "test" ? null : await repo.threadRef(deps.db, event.incident.id, channelId);
      let providerRef: string | null;
      try {
        const sent = await adapter.send(config, message, { idempotencyKey, threadRef });
        providerRef = sent.providerRef ?? null;
      } catch (err) {
        const failure =
          err instanceof ChannelDeliveryError
            ? err
            : new ChannelDeliveryError(err instanceof Error ? err.message : String(err));
        await repo.recordFailure(deps.db, channelId, clock.now(), failure.message);
        throw failure;
      }

      if (event.kind === "triggered" && providerRef !== null) {
        await repo.saveThreadRef(deps.db, {
          id: deps.newId(),
          workspaceId: row.workspaceId,
          incidentId: event.incident.id,
          channelId,
          providerRef,
        });
      } else if (threadRef !== null && adapter.update !== undefined) {
        /* Best effort: the reply was sent; updating the original message is a bonus. */
        try {
          await adapter.update(config, threadRef, message);
        } catch (err) {
          deps.logger.warn({ err, channelId }, "updating the original alert message failed");
        }
      }

      await repo.recordSuccess(deps.db, channelId, clock.now());
      if (row.status === "failing") await setHealth(channelId, row.workspaceId, "healthy");
      return { providerRef };
    },

    retryPolicy: (type) => adapters.get(type)?.retry,

    async markFailing(channelId) {
      const row = await repo.findById(deps.db, channelId);
      if (row !== undefined) await setHealth(channelId, row.workspaceId, "failing");
    },
  };
}
