/*
 * Alert channels (PRODUCT.md §6.4, §9.4): configuration (encrypted, AAD `channel:<id>`), adapters and
 * health. `deliver` sends one rendered message through a channel and records the outcome; deciding
 * what to send, retries and fallbacks belong to `alerting`. A channel turns "failing" only when
 * alerting gives up on a delivery, and "healthy" again on the next success; both emit
 * `channel.health_changed`.
 */
import {
  CHANNEL_TYPES,
  channelRulesSchema,
  integrationForChannel,
  mergeChannelRules,
  type ChannelRules,
  type ChannelRulesPatch,
  type IntegrationId,
  type ChannelType,
  type CreateChannelInput,
} from "@app/shared";
import type { Clock } from "../../core/clock.js";
import { NotFoundError, ValidationError } from "../../core/errors.js";
import { createWorkspaceScope, type WorkspaceScope } from "../../core/workspace-scope.js";
import type { ActionLinks } from "../../infra/action-links.js";
import type { TokenCipher } from "../../infra/crypto.js";
import type { Db } from "../../infra/db/index.js";
import type { Logger } from "../../infra/logger.js";
import type { Outbox } from "../../infra/outbox/index.js";
import type { WebPush } from "../../infra/webpush.js";
import { renderPlain } from "./adapters/render.js";
import type { ChannelsRepository } from "./channels.repository.js";
import type { PaidSends } from "./phones.service.js";
import type { ChannelRow } from "./schema/channels.js";
import { ChannelDeliveryError, type AlertEvent, type AnyChannelAdapter } from "./types/adapter.js";

export interface ChannelView {
  id: string;
  type: ChannelRow["type"];
  name: string;
  status: ChannelRow["status"];
  /* The gallery entry it shows as (an Opsgenie channel on the JSM host is Jira Service Management). */
  integration: IntegrationId;
  /* Which events and severities the channel accepts. */
  rules: ChannelRules;
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
  rules: ChannelRules;
  lastError: string | null;
}

export interface ChannelsService {
  /* Every channel type, and whether this server can deliver to it (the Slack app needs its keys). */
  types(): Array<{ type: ChannelType; available: boolean }>;
  list(scope: WorkspaceScope): Promise<ChannelView[]>;
  get(scope: WorkspaceScope, id: string): Promise<ChannelDetail>;
  create(scope: WorkspaceScope, input: CreateChannelInput): Promise<ChannelDetail>;
  update(
    scope: WorkspaceScope,
    id: string,
    input: {
      name?: string | undefined;
      config?: Record<string, unknown> | undefined;
      rules?: ChannelRulesPatch | undefined;
    },
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
  }): Promise<{ providerRef: string | null; skipped?: string }>;
  /*
   * System: one alert event straight to a person's own address (a contact method), with no channel
   * behind it. A text or a call is charged to the workspace's alert credits first, like a channel's.
   */
  deliverDirect(input: {
    type: "email" | "sms" | "voice" | "push";
    address: string;
    event: AlertEvent;
    idempotencyKey: string;
    /* Push only: the browser's keys, and whose device it is (their acknowledge link is theirs). */
    push?: { p256dh: string; auth: string; recipientEmail: string | null } | undefined;
    /* Whose address it is, so their reply acts as them. */
    userId?: string | null | undefined;
  }): Promise<{ providerRef: string | null }>;
  /*
   * System: the channel whose first message about this incident has this provider reference (a
   * Slack `channel:ts`, a Telegram `chat:message`). A button press is trusted only when it comes
   * from a message we sent for that incident.
   */
  messageTarget(
    providerRef: string,
    incidentId: string,
  ): Promise<{ workspaceId: string; channelId: string; channelName: string } | undefined>;
  /* System: alerting gave up on a delivery through this channel. */
  markFailing(channelId: string): Promise<void>;
  /* How often and how patiently deliveries to this channel type are retried. */
  retryPolicy(type: ChannelRow["type"]): { attempts: number; backoffMs: number } | undefined;
}

export const channelAad = (id: string) => `channel:${id}`;
const aad = channelAad;
const iso = (d: Date | null) => (d === null ? null : d.toISOString());
/* Stored rules may be partial (`{}` for channels from before rules existed); defaults fill the rest. */
const rulesOf = (row: Pick<ChannelRow, "rules">): ChannelRules =>
  channelRulesSchema.parse(row.rules);

export function createChannelsService(deps: {
  db: Db;
  repository: ChannelsRepository;
  adapters: AnyChannelAdapter[];
  cipher: TokenCipher;
  outbox: Outbox;
  clock: Clock;
  logger: Logger;
  newId: () => string;
  /* Charges and meters paid channels; without it they can't send. */
  credits?: PaidSends | undefined;
  /* Notifications to a person's devices, with a signed acknowledge link. */
  webPush?: WebPush | undefined;
  actionLinks?: ActionLinks | undefined;
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

  /* A config that can't be read still lists; it shows as its type's plain entry. */
  const integrationOf = (row: ChannelRow): IntegrationId => {
    try {
      return integrationForChannel(row.type, configOf(row) as Record<string, unknown>).id;
    } catch {
      return integrationForChannel(row.type).id;
    }
  };

  const toView = (row: ChannelRow): ChannelView => ({
    id: row.id,
    type: row.type,
    name: row.name,
    status: row.status,
    integration: integrationOf(row),
    rules: rulesOf(row),
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
    row: Pick<ChannelRow, "id" | "type" | "name" | "status" | "rules"> & {
      workspaceId: string;
      lastError?: string | null;
    },
  ): ChannelSummary => ({
    id: row.id,
    workspaceId: row.workspaceId,
    type: row.type,
    name: row.name,
    status: row.status,
    rules: rulesOf(row),
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
    types: () => CHANNEL_TYPES.map((type) => ({ type, available: adapters.has(type) })),

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
        ...(input.rules === undefined ? {} : { rules: input.rules }),
      });
      return toDetail(row);
    },

    async update(scope, id, input) {
      const row = await mustFind(scope, id);
      const patch: Partial<Pick<ChannelRow, "name" | "configEnc" | "rules">> = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.rules !== undefined) patch.rules = mergeChannelRules(rulesOf(row), input.rules);
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

    async messageTarget(providerRef, incidentId) {
      return repo.messageTarget(deps.db, providerRef, incidentId);
    },

    async deliverDirect({ type, address, event, idempotencyKey, userId, push }) {
      if (type === "push") {
        if (deps.webPush === undefined || push === undefined) {
          throw new ChannelDeliveryError(
            "Notifications on devices aren't set up on this server.",
            true,
          );
        }
        const { incident } = event;
        const plain = renderPlain(event);
        /* A signed, single-use link, so "Acknowledge" on the notification needs no session. */
        const acknowledgeUrl =
          deps.actionLinks !== undefined &&
          push.recipientEmail !== null &&
          event.kind !== "test" &&
          incident.status === "triggered"
            ? deps.actionLinks.url({
                workspaceId: event.workspace.id,
                incidentId: incident.id,
                action: "acknowledge",
                recipient: push.recipientEmail,
              })
            : null;
        const outcome = await deps.webPush.send(
          { endpoint: address, p256dh: push.p256dh, auth: push.auth },
          {
            title: plain.title,
            body: event.explanation?.headline ?? incident.title,
            url: incident.url,
            /* One notification per incident on the device: a later one replaces it. */
            tag: `incident-${incident.id}`,
            incidentNumber: incident.number,
            kind: event.kind,
            acknowledgeUrl,
          },
        );
        if (outcome.ok) return { providerRef: null };
        throw new ChannelDeliveryError(
          outcome.gone
            ? "This device no longer accepts notifications; it was removed."
            : `The push service answered HTTP ${outcome.status}.`,
          outcome.gone,
        );
      }
      const adapter = adapters.get(type);
      if (adapter === undefined) {
        throw new ChannelDeliveryError(
          type === "email"
            ? 'No adapter for "email" channels.'
            : "Text messages and calls aren't set up on this server.",
          true,
        );
      }
      const wrap = (err: unknown) =>
        err instanceof ChannelDeliveryError
          ? err
          : new ChannelDeliveryError(err instanceof Error ? err.message : String(err), true);
      let config: unknown;
      try {
        config = adapter.parseConfig(type === "email" ? { to: [address] } : { phone: address });
      } catch (err) {
        throw wrap(err);
      }
      if (adapter.skip?.(event) === true) return { providerRef: null };

      /* Paid messages: take the credits first; a refusal means nothing is sent (§11). */
      const scope = createWorkspaceScope({ workspaceId: event.workspace.id });
      let price: ReturnType<NonNullable<typeof adapter.cost>> | undefined;
      try {
        price = adapter.cost?.(config);
      } catch (err) {
        throw wrap(err);
      }
      if (price !== undefined) {
        if (deps.credits === undefined) {
          throw new ChannelDeliveryError("Paid messages aren't set up on this server.", true);
        }
        const charged = await deps.credits.charge(scope, {
          credits: price.credits,
          refId: idempotencyKey,
          incidentId: event.kind === "test" ? undefined : event.incident.id,
        });
        if (!charged.ok) {
          throw new ChannelDeliveryError(
            `Not sent: this message costs ${price.credits} alert credit${price.credits === 1 ? "" : "s"} and the workspace has ${charged.balance}. Add credits under Billing.`,
            true,
          );
        }
      }
      let providerRef: string | null;
      try {
        const sent = await adapter.send(config, adapter.render(event), {
          idempotencyKey,
          threadRef: null,
        });
        providerRef = sent.providerRef ?? null;
      } catch (err) {
        /* Alerting returns the credits when it gives up on the delivery. */
        throw err instanceof ChannelDeliveryError
          ? err
          : new ChannelDeliveryError(err instanceof Error ? err.message : String(err));
      }
      if (price !== undefined) {
        await deps.credits?.recordUsage(scope, {
          provider: "twilio",
          kind: price.kind,
          units: 1,
          costMicros: price.costMicros,
          ref: idempotencyKey,
        });
      }
      /* A reply to a text ("1") or a keypress on a call is matched to the newest alert sent there. */
      if (type !== "email" && event.kind === "triggered") {
        await repo.saveDirectRef(deps.db, {
          id: deps.newId(),
          workspaceId: event.workspace.id,
          incidentId: event.incident.id,
          address,
          userId: userId ?? null,
        });
      }
      return { providerRef };
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

      if (adapter.skip?.(event) === true) {
        return { providerRef: null, skipped: "This channel isn't used for this kind of update." };
      }

      /* Paid channels: take the credits first; a refusal means nothing is sent (§11). */
      const price = adapter.cost?.(config);
      const scope = createWorkspaceScope({ workspaceId: row.workspaceId });
      if (price !== undefined) {
        if (deps.credits === undefined) {
          throw new ChannelDeliveryError("Paid messages aren't set up on this server.", true);
        }
        const charged = await deps.credits.charge(scope, {
          credits: price.credits,
          refId: idempotencyKey,
          incidentId: event.kind === "test" ? undefined : event.incident.id,
        });
        if (!charged.ok) {
          throw new ChannelDeliveryError(
            `Not sent: this message costs ${price.credits} alert credit${price.credits === 1 ? "" : "s"} and the workspace has ${charged.balance}. Add credits under Billing.`,
            true,
          );
        }
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
        /* A test isn't retried, so its credits go straight back; alerting returns the others. */
        if (price !== undefined && event.kind === "test") {
          await deps.credits?.refundCharge(scope, idempotencyKey);
        }
        throw failure;
      }
      if (price !== undefined) {
        await deps.credits?.recordUsage(scope, {
          provider: "twilio",
          kind: price.kind,
          units: 1,
          costMicros: price.costMicros,
          ref: idempotencyKey,
        });
      }

      /* Phone channels keep the newest alert per incident too: replies are matched to it. */
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
