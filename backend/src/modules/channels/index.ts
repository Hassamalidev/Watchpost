/* Public API of the channels module. Other modules import only from this file (PRODUCT.md §7.1). */
import type { RequestHandler } from "express";
import type { AppModule, Infra } from "../../composition/types.js";
import { newId } from "../../infra/ids.js";
import { createTwilioProvider, type MessagingProvider } from "../../infra/messaging/index.js";
import { createSmsAdapter, createVoiceAdapter } from "./adapters/phone.js";
import { createPhonesRouter } from "./phones.routes.js";
import { createPhonesService, type PaidSends, type PhonesService } from "./phones.service.js";
import { createDiscordAdapter } from "./adapters/discord.js";
import { createEmailAdapter } from "./adapters/email.js";
import { createGoogleChatAdapter } from "./adapters/google-chat.js";
import { createGotifyAdapter } from "./adapters/gotify.js";
import { createMatrixAdapter } from "./adapters/matrix.js";
import { createMattermostAdapter } from "./adapters/mattermost.js";
import { createNtfyAdapter } from "./adapters/ntfy.js";
import { createOpsgenieAdapter } from "./adapters/opsgenie.js";
import { createPagerDutyAdapter } from "./adapters/pagerduty.js";
import { createPushbulletAdapter } from "./adapters/pushbullet.js";
import { createPushoverAdapter } from "./adapters/pushover.js";
import { createRocketChatAdapter } from "./adapters/rocketchat.js";
import { createSlackAdapter } from "./adapters/slack.js";
import { createSlackWebhookAdapter } from "./adapters/slack-webhook.js";
import { createSplunkOnCallAdapter } from "./adapters/splunk-oncall.js";
import { createTeamsAdapter } from "./adapters/teams.js";
import { createTelegramAdapter, createTelegramApi } from "./adapters/telegram.js";
import { createWebhookAdapter } from "./adapters/webhook.js";
import { createZulipAdapter } from "./adapters/zulip.js";
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
export type { PaidSends, PhonesService, ReplyTarget } from "./phones.service.js";
export { smsText, voiceText } from "./adapters/phone.js";
export { SLACK_ACK_ACTION, SLACK_RESOLVE_ACTION } from "./adapters/slack.js";
export { TELEGRAM_ACK, TELEGRAM_RESOLVE } from "./adapters/telegram.js";
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
    | "db"
    | "clock"
    | "outbox"
    | "cipher"
    | "logger"
    | "requestEmail"
    | "http"
    | "config"
    | "actionLinks"
    | "webPush"
  >;
  guards: { session: RequestHandler; workspace: RequestHandler };
  /* Replaces the built-in adapters (tests use fakes). */
  adapters?: AnyChannelAdapter[];
  /* Charges and meters SMS and voice; without it those channels are unavailable. */
  credits?: PaidSends | undefined;
  /* Replaces the provider built from the server's Twilio settings (tests use a fake). */
  messaging?: MessagingProvider | undefined;
}

export interface ChannelsModule extends AppModule {
  service: ChannelsService;
  integrations: IntegrationsService;
  phones: PhonesService;
  /* The SMS and voice provider, when this server has one; inbound requests are verified with it. */
  messaging: MessagingProvider | undefined;
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

  const { twilio } = config;
  const messaging =
    deps.messaging ??
    (twilio !== undefined &&
    (twilio.messagingServiceSid !== undefined || twilio.smsFrom !== undefined)
      ? createTwilioProvider({ ...twilio, http: infra.http })
      : undefined);
  const phones = createPhonesService({
    db: infra.db,
    repository,
    cipher: infra.cipher,
    messaging,
    credits: deps.credits,
    clock: infra.clock,
    logger: infra.logger.child({ module: "channels" }),
    newId,
  });
  const phoneAdapter =
    messaging === undefined || deps.credits === undefined
      ? undefined
      : {
          messaging,
          isVerified: (workspaceId: string, phone: string) => phones.isVerified(workspaceId, phone),
          gatherUrl: (incidentId: string | null) =>
            `${config.auth.baseURL.replace(/\/+$/, "")}/api/webhooks/twilio/voice?${incidentId === null ? "test=1" : `incident=${incidentId}`}`,
        };

  /*
   * The Slack app and Telegram exist only when the server has their credentials; every other channel
   * needs nothing but what the workspace admin enters.
   */
  const http = { http: infra.http };
  const adapters: AnyChannelAdapter[] = deps.adapters ?? [
    createEmailAdapter({ requestEmail: infra.requestEmail, actionLinks: infra.actionLinks }),
    createWebhookAdapter({ http: infra.http, clock: infra.clock }),
    createDiscordAdapter(http),
    createTeamsAdapter(http),
    createSlackWebhookAdapter(http),
    createGoogleChatAdapter(http),
    createMattermostAdapter(http),
    createRocketChatAdapter(http),
    createZulipAdapter(http),
    createMatrixAdapter(http),
    createPagerDutyAdapter(http),
    createOpsgenieAdapter(http),
    createSplunkOnCallAdapter(http),
    createPushoverAdapter(http),
    createPushbulletAdapter(http),
    createNtfyAdapter(http),
    createGotifyAdapter(http),
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
    ...(phoneAdapter ? [createSmsAdapter(phoneAdapter)] : []),
    ...(phoneAdapter?.messaging.canCall ? [createVoiceAdapter(phoneAdapter)] : []),
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
    credits: deps.credits,
    webPush: infra.webPush,
    actionLinks: infra.actionLinks,
  });
  return {
    name: "channels",
    service,
    integrations,
    phones,
    messaging,
    routers: [
      {
        path: "/api/w/:workspaceId",
        router: createChannelsRouter(createChannelsController(service), deps.guards),
      },
      {
        path: "/api/w/:workspaceId",
        router: createIntegrationsRouter(integrations, deps.guards),
      },
      { path: "/api/w/:workspaceId", router: createPhonesRouter(phones, deps.guards) },
      {
        path: "/",
        router: createIntegrationsPublicRouter(integrations, {
          session: deps.guards.session,
          webOrigin: config.webOrigin,
        }),
      },
    ],
  };
}
