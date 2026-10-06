/* Public API of the actions module. Other modules import only from this file (PRODUCT.md §7.1). */
import { Router } from "express";
import { z } from "zod";
import type { AppModule, Infra } from "../../composition/types.js";
import { validate, inputOf } from "../../middleware/validate.js";
import type { MessagingProvider } from "../../infra/messaging/index.js";
import type { ChannelsService, IntegrationsService, PhonesService } from "../channels/index.js";
import type { ContactsService } from "../contacts/index.js";
import type { MaintenanceService } from "../maintenance/index.js";
import type { MonitorsService } from "../monitors/index.js";
import type { OncallService } from "../oncall/index.js";
import {
  SLACK_ACTIONS_PATH,
  SLACK_COMMANDS_PATH,
  createSlackActionsRouter,
  createSlackCommandsRouter,
  createTelegramWebhookRouter,
} from "./chat.routes.js";
import { createSlackCommand } from "./commands.js";
import type { IncidentsService } from "../incidents/index.js";
import type { WorkspacesService } from "../workspaces/index.js";
import { createActionsRepository } from "./actions.repository.js";
import { createActionsService, type ActionsService } from "./actions.service.js";
import { createPhoneActionsRouter } from "./phone.routes.js";

export type {
  ActionOutcome,
  ActionPreview,
  ActionsService,
  ChatActionOutcome,
} from "./actions.service.js";
export { SLACK_ACTIONS_PATH, SLACK_COMMANDS_PATH, slackSignature } from "./chat.routes.js";
export { COMMAND_HELP, parseDuration } from "./commands.js";

export interface ActionsModuleDeps {
  infra: Pick<Infra, "db" | "clock" | "actionLinks" | "config" | "http" | "logger">;
  /* Chat buttons: which message a press came from, and the Telegram bot's other updates. */
  channels?: Pick<ChannelsService, "messageTarget"> | undefined;
  integrations?:
    | Pick<IntegrationsService, "telegramUpdate" | "telegramAnswer" | "slackTeamWorkspaces">
    | undefined;
  /* Linked chat users, and what `/watchpost` can look up and start. */
  contacts?: Pick<ContactsService, "chatUser" | "chatLinkUrl"> | undefined;
  oncall?: Pick<OncallService, "list"> | undefined;
  maintenance?: Pick<MaintenanceService, "create"> | undefined;
  monitors?: Pick<MonitorsService, "list"> | undefined;
  incidents: IncidentsService;
  workspaces: WorkspacesService;
  /* SMS replies and call keypresses; both absent when the server has no messaging provider. */
  phones?: Pick<PhonesService, "replyTarget"> | undefined;
  messaging?: MessagingProvider | undefined;
}

export interface ActionsModule extends AppModule {
  service: ActionsService;
}

const tokenParams = z.object({ token: z.string().min(20).max(2_000) });

/* /api/actions/:token — no session: the signed link is the credential (single use, 24 h). */
function createActionsRouter(service: ActionsService): Router {
  const router = Router();
  router.get("/api/actions/:token", validate({ params: tokenParams }), async (req, res) => {
    const { params } = inputOf<{ params: typeof tokenParams }>(req, res);
    res.json(await service.preview(params.token));
  });
  router.post("/api/actions/:token", validate({ params: tokenParams }), async (req, res) => {
    const { params } = inputOf<{ params: typeof tokenParams }>(req, res);
    res.json(await service.perform(params.token));
  });
  return router;
}

export function createActionsModule(deps: ActionsModuleDeps): ActionsModule {
  const service = createActionsService({
    db: deps.infra.db,
    repository: createActionsRepository(),
    links: deps.infra.actionLinks,
    incidents: deps.incidents,
    workspaces: deps.workspaces,
    phones: deps.phones,
    channels: deps.channels,
    contacts: deps.contacts,
    clock: deps.infra.clock,
  });
  const { config } = deps.infra;
  const signingSecret = config.slack?.signingSecret;
  const phoneRouters =
    deps.messaging === undefined || deps.phones === undefined
      ? []
      : [
          {
            path: "/",
            router: createPhoneActionsRouter(service, {
              messaging: deps.messaging,
              publicUrl: deps.infra.config.auth.baseURL,
            }),
          },
        ];
  return {
    name: "actions",
    service,
    routers: [
      { path: "/", router: createActionsRouter(service) },
      ...phoneRouters,
      ...(deps.integrations === undefined
        ? []
        : [
            {
              path: "/",
              router: createTelegramWebhookRouter(service, {
                secret: config.telegram?.webhookSecret,
                integrations: deps.integrations,
              }),
            },
          ]),
    ],
    /* Slack signs the raw body, so its clicks are read before the JSON parser. */
    rawBodyRouters:
      signingSecret === undefined
        ? []
        : [
            {
              path: SLACK_ACTIONS_PATH,
              router: createSlackActionsRouter(service, {
                signingSecret,
                http: deps.infra.http,
                clock: deps.infra.clock,
                logger: deps.infra.logger.child({ module: "actions" }),
              }),
            },
            ...(deps.contacts === undefined || deps.integrations === undefined
              ? []
              : [
                  {
                    path: SLACK_COMMANDS_PATH,
                    router: createSlackCommandsRouter(
                      createSlackCommand({
                        incidents: deps.incidents,
                        contacts: deps.contacts,
                        oncall: deps.oncall,
                        maintenance: deps.maintenance,
                        monitors: deps.monitors,
                        slackWorkspaces: deps.integrations.slackTeamWorkspaces,
                        clock: deps.infra.clock,
                      }),
                      { signingSecret, clock: deps.infra.clock },
                    ),
                  },
                ]),
          ],
  };
}
