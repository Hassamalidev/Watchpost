/*
 * Outbound webhooks (PRODUCT.md §6.13). A workspace registers an HTTPS endpoint and the events it
 * wants; each event becomes one delivery per matching endpoint.
 *
 * - The request: `POST` with a JSON body (the standard envelope, or the endpoint's own template
 *   filled in), signed like our alert webhooks: `Watchpost-Signature: t=<unix seconds>,v1=<hex
 *   HMAC-SHA256 of "t.body">`. `Watchpost-Event-Id` is the same across retries and replays, so a
 *   receiver can drop duplicates.
 * - Any 2xx answer within 10 seconds is a success. Anything else is retried after 1, 5, 15, 60,
 *   180, 360 and 720 minutes, then the delivery has failed. `410 Gone` fails at once and switches
 *   the endpoint off, as do 20 failed deliveries in a row.
 * - The delivery row is the queue: a pending row with a due time. The first attempt runs when the
 *   event is handled, the rest from a sweep, and a crash in between loses nothing.
 */
import { createHmac, randomBytes } from "node:crypto";
import {
  WEBHOOKS_PER_WORKSPACE,
  WEBHOOK_DELIVERY_DAYS,
  WEBHOOK_DISABLE_AFTER_FAILURES,
  WEBHOOK_RETRY_MINUTES,
  renderWebhookTemplate,
  sampleWebhookEnvelope,
  webhookEventMatches,
  webhookTemplateProblem,
  type CreateWebhookInput,
  type PlanFeature,
  type UpdateWebhookInput,
  type WebhookDeliveryView,
  type WebhookEndpointView,
  type WebhookEndpointWithSecret,
  type WebhookEnvelope,
  type WebhookEventType,
} from "@app/shared";
import type { Clock } from "../../core/clock.js";
import { NotFoundError, QuotaExceededError, ValidationError } from "../../core/errors.js";
import { createWorkspaceScope, type WorkspaceScope } from "../../core/workspace-scope.js";
import type { TokenCipher } from "../../infra/crypto.js";
import { OutboundError, type OutboundHttp } from "../../infra/http/outbound.js";
import type { Logger } from "../../infra/logger.js";
import type {
  WebhookDeliveryRow,
  WebhookEndpointRow,
  WebhooksRepository,
} from "./webhooks.repository.js";

const TIMEOUT_MS = 10_000;
/* How long an attempt may hold a delivery before another worker may try it. */
const LEASE_MS = 2 * 60_000;
const SWEEP_BATCH = 200;
const NEEDS_PLAN = "Outbound webhooks are part of the paid plans.";

/* The same scheme as the alert webhook channel, so one verifier works for both. */
export function signWebhookBody(secret: string, timestamp: number, body: string): string {
  const v1 = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

const newSecret = () => `whsec_${randomBytes(24).toString("base64url")}`;

export interface WebhooksService {
  list(scope: WorkspaceScope): Promise<WebhookEndpointView[]>;
  create(scope: WorkspaceScope, input: CreateWebhookInput): Promise<WebhookEndpointWithSecret>;
  update(
    scope: WorkspaceScope,
    id: string,
    input: UpdateWebhookInput,
  ): Promise<WebhookEndpointView>;
  remove(scope: WorkspaceScope, id: string): Promise<void>;
  /* A new signing secret; the old one stops working at once. */
  rotateSecret(scope: WorkspaceScope, id: string): Promise<WebhookEndpointWithSecret>;
  deliveries(scope: WorkspaceScope, id: string, limit: number): Promise<WebhookDeliveryView[]>;
  /* Sends an example of one event now and answers how it went. */
  test(scope: WorkspaceScope, id: string, type: WebhookEventType): Promise<WebhookDeliveryView>;
  /* Sends a past delivery's event again, now, as a new delivery. */
  replay(scope: WorkspaceScope, id: string, deliveryId: string): Promise<WebhookDeliveryView>;
  /*
   * System: an event happened in a workspace. Creates a delivery for every endpoint that wants it
   * (once per event and endpoint, however often this is called) and makes the first attempt.
   */
  publish(input: {
    workspaceId: string;
    eventKey: string;
    type: WebhookEventType;
    occurredAt: Date;
    data: Record<string, unknown>;
  }): Promise<number>;
  /* System: attempts every delivery that is due; returns how many were attempted. */
  deliverDue(): Promise<number>;
  /* System: forgets deliveries older than 30 days; returns how many. */
  purgeDeliveries(): Promise<number>;
}

export function createWebhooksService(deps: {
  repository: WebhooksRepository;
  http: OutboundHttp;
  cipher: TokenCipher;
  hasFeature: (scope: WorkspaceScope, feature: PlanFeature) => Promise<boolean>;
  clock: Clock;
  logger: Logger;
  newId: () => string;
}): WebhooksService {
  const { repository: repo, clock } = deps;
  /* Encrypted values are bound to their endpoint, so one can't be copied onto another. */
  const aad = (endpointId: string, what: string) => `webhook:${endpointId}:${what}`;

  function headersOf(row: WebhookEndpointRow): Record<string, string> {
    if (row.headers === null) return {};
    return JSON.parse(deps.cipher.decrypt(row.headers, aad(row.id, "headers"))) as Record<
      string,
      string
    >;
  }

  const toView = (row: WebhookEndpointRow): WebhookEndpointView => ({
    id: row.id,
    name: row.name,
    url: row.url,
    events: row.events,
    bodyTemplate: row.bodyTemplate,
    headerNames: Object.keys(headersOf(row)),
    enabled: row.enabled,
    disabledReason: row.disabledReason,
    consecutiveFailures: row.consecutiveFailures,
    lastDeliveryAt: row.lastDeliveryAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  });

  const toDelivery = (row: WebhookDeliveryRow): WebhookDeliveryView => ({
    id: row.id,
    eventType: row.eventType as WebhookEventType,
    status: row.status,
    attempts: row.attempts,
    responseStatus: row.responseStatus,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    nextAttemptAt: row.status === "pending" ? (row.nextAttemptAt?.toISOString() ?? null) : null,
    manual: row.manual,
  });

  async function mustFind(scope: WorkspaceScope, id: string): Promise<WebhookEndpointRow> {
    const row = await repo.find(scope, id);
    if (row === undefined) throw new NotFoundError("Webhook not found.");
    return row;
  }

  async function requirePlan(scope: WorkspaceScope) {
    if (!(await deps.hasFeature(scope, "apiWrite"))) throw new QuotaExceededError(NEEDS_PLAN);
  }

  function checkTemplate(template: string | null, events: readonly string[]) {
    if (template === null) return;
    const problem = webhookTemplateProblem(template, events);
    if (problem !== undefined) {
      throw new ValidationError("The body template can't be used.", [
        { path: "body.bodyTemplate", message: problem },
      ]);
    }
  }

  /* One attempt at a delivery this caller has claimed. */
  async function send(delivery: WebhookDeliveryRow): Promise<WebhookDeliveryRow> {
    const now = clock.now();
    const fail = async (error: string, responseStatus: number | null, final: boolean) => {
      const retryIn = WEBHOOK_RETRY_MINUTES[delivery.attempts - 1];
      const over = final || retryIn === undefined;
      const updated = await repo.finishDelivery(delivery.id, {
        status: over ? "failed" : "pending",
        responseStatus,
        error,
        nextAttemptAt:
          over || retryIn === undefined ? null : new Date(now.getTime() + retryIn * 60_000),
        deliveredAt: null,
      });
      return { updated: updated ?? delivery, over };
    };

    const endpoint = await repo.endpointById(delivery.endpointId);
    if (endpoint === undefined) return delivery;
    /* A test or replay is sent even while the endpoint is off: that is how people check a fix. */
    if (!endpoint.enabled && !delivery.manual) {
      return (await fail("The webhook was switched off.", null, true)).updated;
    }
    const scope = createWorkspaceScope({ workspaceId: endpoint.workspaceId });
    if (!(await deps.hasFeature(scope, "apiWrite"))) {
      return (await fail("The workspace's plan no longer includes webhooks.", null, true)).updated;
    }

    const body =
      endpoint.bodyTemplate === null
        ? JSON.stringify(delivery.payload)
        : renderWebhookTemplate(endpoint.bodyTemplate, delivery.payload);
    const timestamp = Math.floor(now.getTime() / 1_000);
    const secret = deps.cipher.decrypt(endpoint.secret, aad(endpoint.id, "secret"));
    let status: number | null = null;
    let error: string | null = null;
    try {
      const res = await deps.http.request({
        method: "POST",
        url: endpoint.url,
        headers: {
          ...headersOf(endpoint),
          "content-type": "application/json",
          "watchpost-event-id": delivery.payload.id,
          "watchpost-event-type": delivery.eventType,
          "watchpost-signature": signWebhookBody(secret, timestamp, body),
        },
        body,
        timeoutMs: TIMEOUT_MS,
      });
      status = res.status;
      if (res.status < 200 || res.status >= 300)
        error = `The endpoint answered HTTP ${res.status}.`;
    } catch (err) {
      error =
        err instanceof OutboundError
          ? `No answer: ${err.message}`
          : `No answer: ${err instanceof Error ? err.message : String(err)}`;
      /* An address we refuse to call will be refused next time too. */
      if (err instanceof OutboundError && (err.code === "blocked" || err.code === "invalid_url")) {
        const { updated } = await fail(error, null, true);
        await repo.disable(endpoint.id, "Its address can't be called from here.", now);
        return updated;
      }
    }

    if (error === null) {
      const updated = await repo.finishDelivery(delivery.id, {
        status: "delivered",
        responseStatus: status,
        error: null,
        nextAttemptAt: null,
        deliveredAt: now,
      });
      await repo.recordSuccess(endpoint.id, now);
      return updated ?? delivery;
    }

    const gone = status === 410;
    /* A person is watching a test or replay: it is one attempt and never retried. */
    const { updated, over } = await fail(error, status, gone || delivery.manual);
    if (gone) {
      await repo.disable(endpoint.id, "The endpoint answered 410 Gone.", now);
    } else if (over && !delivery.manual) {
      const failures = await repo.recordFailure(endpoint.id);
      if (failures >= WEBHOOK_DISABLE_AFTER_FAILURES) {
        await repo.disable(
          endpoint.id,
          `${WEBHOOK_DISABLE_AFTER_FAILURES} deliveries in a row failed.`,
          now,
        );
      }
    }
    return updated;
  }

  async function attempt(deliveryId: string): Promise<WebhookDeliveryRow | undefined> {
    const claimed = await repo.claim(deliveryId, clock.now(), LEASE_MS);
    if (claimed === undefined) return undefined;
    try {
      return await send(claimed);
    } catch (err) {
      /* Our own fault (a database error): the lease runs out and the delivery is tried again. */
      deps.logger.error({ err, deliveryId }, "webhook delivery attempt failed");
      return claimed;
    }
  }

  async function sendNow(
    endpoint: WebhookEndpointRow,
    payload: WebhookEnvelope,
  ): Promise<WebhookDeliveryView> {
    const row = await repo.insertDelivery({
      id: deps.newId(),
      workspaceId: endpoint.workspaceId,
      endpointId: endpoint.id,
      eventKey: `manual:${deps.newId()}`,
      eventType: payload.type,
      payload,
      manual: true,
      now: clock.now(),
    });
    if (row === undefined) throw new Error("manual webhook delivery wasn't stored");
    return toDelivery((await attempt(row.id)) ?? row);
  }

  return {
    async list(scope) {
      return (await repo.list(scope)).map(toView);
    },

    async create(scope, input) {
      await requirePlan(scope);
      if ((await repo.count(scope)) >= WEBHOOKS_PER_WORKSPACE) {
        throw new QuotaExceededError(
          `A workspace can have ${WEBHOOKS_PER_WORKSPACE} webhooks. Delete one first.`,
        );
      }
      checkTemplate(input.bodyTemplate, input.events);
      const id = deps.newId();
      const secret = newSecret();
      /*
       * `created_at` is left to the database, like an event's time: the two are compared to decide
       * what an endpoint gets, so they have to come from the same clock.
       */
      const row = await repo.insert(scope, {
        id,
        name: input.name,
        url: input.url,
        secret: deps.cipher.encrypt(secret, aad(id, "secret")),
        events: input.events,
        bodyTemplate: input.bodyTemplate,
        headers:
          input.headers === undefined || Object.keys(input.headers).length === 0
            ? null
            : deps.cipher.encrypt(JSON.stringify(input.headers), aad(id, "headers")),
        enabled: input.enabled,
      });
      return { ...toView(row), secret };
    },

    async update(scope, id, input) {
      const current = await mustFind(scope, id);
      const events = input.events ?? current.events;
      const template = input.bodyTemplate === undefined ? current.bodyTemplate : input.bodyTemplate;
      checkTemplate(template, events);
      /* Switching one back on is where a workspace without the plan is stopped. */
      if (input.enabled === true && !current.enabled) await requirePlan(scope);
      const row = await repo.update(scope, id, {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.url === undefined ? {} : { url: input.url }),
        ...(input.events === undefined ? {} : { events: input.events }),
        ...(input.bodyTemplate === undefined ? {} : { bodyTemplate: input.bodyTemplate }),
        ...(input.headers === undefined
          ? {}
          : {
              headers:
                Object.keys(input.headers).length === 0
                  ? null
                  : deps.cipher.encrypt(JSON.stringify(input.headers), aad(id, "headers")),
            }),
        ...(input.enabled === undefined
          ? {}
          : {
              enabled: input.enabled,
              disabledReason: null,
              /* Switched back on by a person: it starts with a clean record. */
              ...(input.enabled ? { consecutiveFailures: 0 } : {}),
            }),
        updatedAt: clock.now(),
      });
      if (row === undefined) throw new NotFoundError("Webhook not found.");
      return toView(row);
    },

    async remove(scope, id) {
      if (!(await repo.remove(scope, id))) throw new NotFoundError("Webhook not found.");
    },

    async rotateSecret(scope, id) {
      await mustFind(scope, id);
      const secret = newSecret();
      const row = await repo.update(scope, id, {
        secret: deps.cipher.encrypt(secret, aad(id, "secret")),
        updatedAt: clock.now(),
      });
      if (row === undefined) throw new NotFoundError("Webhook not found.");
      return { ...toView(row), secret };
    },

    async deliveries(scope, id, limit) {
      await mustFind(scope, id);
      return (await repo.deliveriesOf(scope, id, limit)).map(toDelivery);
    },

    async test(scope, id, type) {
      const endpoint = await mustFind(scope, id);
      return sendNow(endpoint, {
        ...sampleWebhookEnvelope(type),
        id: deps.newId(),
        createdAt: clock.now().toISOString(),
        workspaceId: scope.workspaceId,
      });
    },

    async replay(scope, id, deliveryId) {
      const endpoint = await mustFind(scope, id);
      const original = await repo.findDelivery(scope, id, deliveryId);
      if (original === undefined) throw new NotFoundError("Delivery not found.");
      return sendNow(endpoint, original.payload);
    },

    async publish({ workspaceId, eventKey, type, occurredAt, data }) {
      /* An endpoint gets what happens from the moment it exists, not what a late job brings. */
      const endpoints = (await repo.enabledIn(workspaceId)).filter(
        (e) => webhookEventMatches(e.events, type) && e.createdAt.getTime() <= occurredAt.getTime(),
      );
      let created = 0;
      for (const endpoint of endpoints) {
        const id = deps.newId();
        const row = await repo.insertDelivery({
          id,
          workspaceId,
          endpointId: endpoint.id,
          eventKey,
          eventType: type,
          payload: { id, type, createdAt: occurredAt.toISOString(), workspaceId, data },
          manual: false,
          now: clock.now(),
        });
        /* Already there: this event was handled before (the job ran twice). */
        if (row === undefined) continue;
        created += 1;
        await attempt(row.id);
      }
      return created;
    },

    async deliverDue() {
      const ids = await repo.dueDeliveryIds(clock.now(), SWEEP_BATCH);
      let attempted = 0;
      for (const id of ids) {
        if ((await attempt(id)) !== undefined) attempted += 1;
      }
      return attempted;
    },

    purgeDeliveries: () =>
      repo.deleteDeliveriesBefore(
        new Date(clock.now().getTime() - WEBHOOK_DELIVERY_DAYS * 86_400_000),
      ),
  };
}
