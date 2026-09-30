/* Public API of the channels module. Other modules import only from this file (PRODUCT.md §7.1). */
import type { RequestHandler } from "express";
import type { AppModule, Infra } from "../../composition/types.js";
import { newId } from "../../infra/ids.js";
import { createDiscordAdapter } from "./adapters/discord.js";
import { createEmailAdapter } from "./adapters/email.js";
import { createSlackAdapter } from "./adapters/slack.js";
import { createTeamsAdapter } from "./adapters/teams.js";
import { createTelegramAdapter, createTelegramApi } from "./adapters/telegram.js";
import { createWebhookAdapter } from "./adapters/webhook.js";
import { createChannelsController } from "./channels.controller.js";
import { createChannelsRepository } from "./channels.repository.js";
import { createChannelsRouter } from "./channels.routes.js";
import { createChannelsService, type ChannelsService } from "./channels.service.js";
import { createIntegrationsPublicRouter, createIntegrationsRouter } from "./integrations.routes.js";
import { createIntegrationsService, type IntegrationsService } from "./integrations.service.js";
import type { AnyChannelAdapter } from "./types/adapter.js";

export type {
  ChannelDetail,
  ChannelSummary,
  ChannelView,
  ChannelsService,
} from "./channels.service.js";
export type { IntegrationsService, SlackInstallationView } from "./integrations.service.js";
export {
  ChannelDeliveryError,
  type AlertEvent,
  type AnyChannelAdapter,
  type ChannelAdapter,
  type PrepareContext,
  type RenderedMessage,
  type SendMeta,
  type SendResult,
} from "./types/adapter.js";
export { alertTitle, formatDuration, renderPlain } from "./adapters/render.js";
export { signWebhook } from "./adapters/webhook.js";

export interface ChannelsModuleDeps {
  infra: Pick<
    Infra,
    "db" | "clock" | "outbox" | "cipher" | "logger" | "requestEmail" | "http" | "config"
  >;
  guards: { session: RequestHandler; workspace: RequestHandler };
  /* Replaces the built-in adapters (tests use fakes). */
  adapters?: AnyChannelAdapter[];
}

export interface ChannelsModule extends AppModule {
  service: ChannelsService;
  integrations: IntegrationsService;
}

export function createChannelsModule(deps: ChannelsModuleDeps): ChannelsModule {
  const { infra } = deps;
  const { config } = infra;
  const repository = createChannelsRepository();
  const telegramApi = config.telegram
    ? createTelegramApi({ http: infra.http, botToken: config.telegram.botToken })
    : undefined;
  const integrations = createIntegrationsService({
    db: infra.db,
    repository,
    cipher: infra.cipher,
    http: infra.http,
    clock: infra.clock,
    logger: infra.logger.child({ module: "channels" }),
    newId,
    config: {
      slack: config.slack,
      telegram: config.telegram,
      webOrigin: config.webOrigin,
      apiBaseUrl: config.auth.baseURL,
    },
    telegram: telegramApi,
  });

  /* Slack and Telegram exist only when the server has their credentials. */
  const adapters: AnyChannelAdapter[] = deps.adapters ?? [
    createEmailAdapter({ requestEmail: infra.requestEmail }),
    createWebhookAdapter({ http: infra.http, clock: infra.clock }),
    createDiscordAdapter({ http: infra.http }),
    createTeamsAdapter({ http: infra.http }),
    ...(config.slack
      ? [
          createSlackAdapter({
            http: infra.http,
            tokenFor: (id) => integrations.tokenFor(id),
            ownsInstallation: (id, workspaceId) => integrations.ownsInstallation(id, workspaceId),
          }),
        ]
      : []),
    ...(telegramApi ? [createTelegramAdapter({ api: telegramApi })] : []),
  ];

  const service = createChannelsService({
    db: infra.db,
    repository,
    adapters,
    cipher: infra.cipher,
    outbox: infra.outbox,
    clock: infra.clock,
    logger: infra.logger.child({ module: "channels" }),
    newId,
  });
  return {
    name: "channels",
    service,
    integrations,
    routers: [
      {
        path: "/api/w/:workspaceId",
        router: createChannelsRouter(createChannelsController(service), deps.guards),
      },
      {
        path: "/api/w/:workspaceId",
        router: createIntegrationsRouter(integrations, deps.guards),
      },
      {
        path: "/",
        router: createIntegrationsPublicRouter(integrations, {
          session: deps.guards.session,
          webOrigin: config.webOrigin,
          telegramSecret: config.telegram?.webhookSecret,
        }),
      },
    ],
  };
}
