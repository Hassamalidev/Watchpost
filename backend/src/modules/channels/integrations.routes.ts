/*
 * Chat app connections (§10). Workspace routes (admins): start a Slack install, list installations
 * and their channels, create a Telegram link. Public routes: the Slack OAuth callback (signed-in user
 * who started the install). The Telegram bot webhook is in the `actions` module, because it also
 * carries button taps.
 */
import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { sessionOf } from "../../middleware/session.js";
import { requirePermission } from "../../middleware/roles.js";
import { inputOf, validate } from "../../middleware/validate.js";
import { scopeOf } from "../../middleware/workspace.js";
import type { IntegrationsService } from "./integrations.service.js";

const installationParams = z.object({ installationId: z.uuid() });
const channelParams = z.object({ channelId: z.uuid() });
const callbackQuery = z.object({
  code: z.string().min(1).max(500).optional(),
  state: z.string().min(1).max(2_000).optional(),
  error: z.string().max(200).optional(),
});

export function createIntegrationsRouter(
  service: IntegrationsService,
  guards: { session: RequestHandler; workspace: RequestHandler },
): Router {
  const router = Router({ mergeParams: true });
  const admin = requirePermission("channel:manage");
  router.use("/integrations", guards.session, guards.workspace);

  router.get("/integrations/slack/install", admin, (req, res) => {
    res.json({ url: service.slackInstallUrl(scopeOf(req, res)) });
  });
  router.get("/integrations/slack/installations", admin, async (req, res) => {
    res.json({ data: await service.slackInstallations(scopeOf(req, res)) });
  });
  router.get(
    "/integrations/slack/installations/:installationId/channels",
    admin,
    validate({ params: installationParams }),
    async (req, res) => {
      const { params } = inputOf<{ params: typeof installationParams }>(req, res);
      res.json({ data: await service.slackChannels(scopeOf(req, res), params.installationId) });
    },
  );
  router.post(
    "/channels/:channelId/telegram-link",
    guards.session,
    guards.workspace,
    admin,
    validate({ params: channelParams }),
    async (req, res) => {
      const { params } = inputOf<{ params: typeof channelParams }>(req, res);
      res.status(201).json(await service.telegramLink(scopeOf(req, res), params.channelId));
    },
  );
  return router;
}

export function createIntegrationsPublicRouter(
  service: IntegrationsService,
  options: {
    session: RequestHandler;
    webOrigin: string;
  },
): Router {
  const router = Router();

  router.get(
    "/api/integrations/slack/callback",
    options.session,
    validate({ query: callbackQuery }),
    async (req, res) => {
      const { query } = inputOf<{ query: typeof callbackQuery }>(req, res);
      const back = (workspaceId: string | undefined, outcome: string) =>
        res.redirect(
          303,
          workspaceId
            ? `${options.webOrigin}/w/${workspaceId}/integrations?slack=${outcome}`
            : `${options.webOrigin}/?slack=${outcome}`,
        );
      if (query.error !== undefined || query.code === undefined || query.state === undefined) {
        back(undefined, "cancelled");
        return;
      }
      const workspaceId = await service.slackCallback({
        code: query.code,
        state: query.state,
        userId: sessionOf(req, res).userId,
      });
      back(workspaceId, "installed");
    },
  );

  return router;
}
