/*
 * Chat app connections (§10). Workspace routes (admins): start a Slack install, list installations
 * and their channels, create a Telegram link. Public routes: the Slack OAuth callback (signed-in user
 * who started the install) and the Telegram bot webhook (secret header, compared in constant time).
 */
import { timingSafeEqual } from "node:crypto";
import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { UnauthorizedError } from "../../core/errors.js";
import { sessionOf } from "../../middleware/session.js";
import { requireRole } from "../../middleware/roles.js";
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
  const admin = requireRole("admin");
  router.use("/integrations", guards.session, guards.workspace, admin);

  router.get("/integrations/slack/install", (req, res) => {
    res.json({ url: service.slackInstallUrl(scopeOf(req, res)) });
  });
  router.get("/integrations/slack/installations", async (req, res) => {
    res.json({ data: await service.slackInstallations(scopeOf(req, res)) });
  });
  router.get(
    "/integrations/slack/installations/:installationId/channels",
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
    telegramSecret: string | undefined;
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

  router.post("/api/webhooks/telegram", async (req, res) => {
    const expected = options.telegramSecret;
    const given = req.get("x-telegram-bot-api-secret-token") ?? "";
    if (
      expected === undefined ||
      given.length !== expected.length ||
      !timingSafeEqual(Buffer.from(given), Buffer.from(expected))
    ) {
      throw new UnauthorizedError("Invalid Telegram secret token.");
    }
    await service.telegramUpdate(req.body);
    /* Always 200 once authenticated: Telegram retries anything else forever. */
    res.json({ ok: true });
  });
  return router;
}
