/*
 * Connecting chat apps (PRODUCT.md §10). Slack: OAuth v2 install per workspace (the state is an
 * encrypted, 10-minute token bound to the workspace and the user who started it), then a picker of
 * the team's channels. Telegram: a one-day deep link `t.me/<bot>?start=<token>`; the bot webhook
 * (checked with the secret header) links the chat that opened it to the channel.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { AppConfig } from "../../config/index.js";
import type { Clock } from "../../core/clock.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../../core/errors.js";
import { createWorkspaceScope, type WorkspaceScope } from "../../core/workspace-scope.js";
import type { TokenCipher } from "../../infra/crypto.js";
import type { Db } from "../../infra/db/index.js";
import type { OutboundHttp } from "../../infra/http/outbound.js";
import type { Logger } from "../../infra/logger.js";
import { SLACK_API } from "./adapters/slack.js";
import type { TelegramApi } from "./adapters/telegram.js";
import type { ChannelsRepository } from "./channels.repository.js";
import { channelAad } from "./channels.service.js";

export const SLACK_SCOPES = [
  "chat:write",
  "chat:write.public",
  "channels:read",
  "groups:read",
  "users:read",
  "users:read.email",
  "im:write",
  "commands",
] as const;

const STATE_TTL_MS = 10 * 60_000;
const TELEGRAM_LINK_TTL_MS = 24 * 3_600_000;
const STATE_AAD = "slack-oauth-state";
const slackAad = (id: string) => `slack:${id}`;

export interface SlackInstallationView {
  id: string;
  teamId: string;
  teamName: string;
  createdAt: string;
}

export interface IntegrationsService {
  slackInstallUrl(scope: WorkspaceScope): string;
  /* Finishes the OAuth install; returns the workspace to send the browser back to. */
  slackCallback(input: { code: string; state: string; userId: string }): Promise<string>;
  slackInstallations(scope: WorkspaceScope): Promise<SlackInstallationView[]>;
  slackChannels(
    scope: WorkspaceScope,
    installationId: string,
  ): Promise<Array<{ id: string; name: string; isPrivate: boolean }>>;
  tokenFor(installationId: string): Promise<string | undefined>;
  ownsInstallation(installationId: string, workspaceId: string): Promise<boolean>;
  telegramLink(
    scope: WorkspaceScope,
    channelId: string,
  ): Promise<{ url: string; expiresAt: string }>;
  /* A Telegram bot update (already authenticated by the secret header). */
  telegramUpdate(update: unknown): Promise<void>;
}

const telegramUpdateSchema = z.object({
  message: z
    .object({
      text: z.string().optional(),
      chat: z.object({
        id: z.union([z.number(), z.string()]),
        title: z.string().optional(),
        username: z.string().optional(),
        first_name: z.string().optional(),
      }),
    })
    .optional(),
});

export function createIntegrationsService(deps: {
  db: Db;
  repository: ChannelsRepository;
  cipher: TokenCipher;
  http: OutboundHttp;
  clock: Clock;
  logger: Logger;
  newId: () => string;
  config: Pick<AppConfig, "slack" | "telegram" | "webOrigin"> & { apiBaseUrl: string };
  telegram: TelegramApi | undefined;
}): IntegrationsService {
  const { repository: repo, clock, config } = deps;
  const redirectUri = `${config.apiBaseUrl}/api/integrations/slack/callback`;

  const slackConfig = () => {
    if (config.slack === undefined)
      throw new ValidationError("Slack isn't configured on this server.");
    return config.slack;
  };

  async function slackApi(method: string, form: Record<string, string>, token?: string) {
    const res = await deps.http.request({
      method: "POST",
      url: `${SLACK_API}/${method}`,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: new URLSearchParams(form).toString(),
    });
    const body = JSON.parse(res.body || "{}") as Record<string, unknown>;
    if (body.ok !== true) {
      throw new ValidationError(`Slack refused the request: ${String(body.error ?? res.status)}`);
    }
    return body;
  }

  async function ownedInstallation(scope: WorkspaceScope, id: string) {
    const row = await repo.slackInstallation(deps.db, id);
    if (row === undefined || row.workspaceId !== scope.workspaceId) {
      throw new NotFoundError("Slack installation not found.");
    }
    return row;
  }

  const service: IntegrationsService = {
    slackInstallUrl(scope) {
      const { clientId } = slackConfig();
      if (scope.actorUserId === undefined)
        throw new ForbiddenError("Installing Slack needs a user.");
      const state = deps.cipher.encrypt(
        JSON.stringify({
          w: scope.workspaceId,
          u: scope.actorUserId,
          e: clock.now().getTime() + STATE_TTL_MS,
        }),
        STATE_AAD,
      );
      const url = new URL("https://slack.com/oauth/v2/authorize");
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("scope", SLACK_SCOPES.join(","));
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      return url.toString();
    },

    async slackCallback({ code, state, userId }) {
      const { clientId, clientSecret } = slackConfig();
      let parsed: { w: string; u: string; e: number };
      try {
        parsed = JSON.parse(deps.cipher.decrypt(state, STATE_AAD)) as typeof parsed;
      } catch {
        throw new ValidationError("The Slack install link is invalid. Start again from Watchpost.");
      }
      if (parsed.e < clock.now().getTime()) {
        throw new ValidationError("The Slack install link expired. Start again from Watchpost.");
      }
      if (parsed.u !== userId) {
        throw new ForbiddenError("Finish the Slack install with the account that started it.");
      }
      const body = await slackApi("oauth.v2.access", {
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      });
      const team = body.team as { id?: string; name?: string } | undefined;
      const token = body.access_token;
      if (typeof token !== "string" || typeof team?.id !== "string") {
        throw new ValidationError("Slack didn't return a bot token.");
      }
      const id = deps.newId();
      /* Upsert keeps the existing row's ID, so encrypt with the ID of whichever row we end up with. */
      const existing = (
        await repo.slackInstallations(deps.db, createWorkspaceScope({ workspaceId: parsed.w }))
      ).find((i) => i.teamId === team.id);
      const rowId = existing?.id ?? id;
      await repo.upsertSlackInstallation(deps.db, {
        id: rowId,
        workspaceId: parsed.w,
        teamId: team.id,
        teamName: team.name ?? team.id,
        botUserId: typeof body.bot_user_id === "string" ? body.bot_user_id : null,
        botTokenEnc: deps.cipher.encrypt(token, slackAad(rowId)),
        scopes: typeof body.scope === "string" ? body.scope : "",
        installedBy: userId,
      });
      return parsed.w;
    },

    async slackInstallations(scope) {
      return (await repo.slackInstallations(deps.db, scope)).map((r) => ({
        id: r.id,
        teamId: r.teamId,
        teamName: r.teamName,
        createdAt: r.createdAt.toISOString(),
      }));
    },

    async slackChannels(scope, installationId) {
      const installation = await ownedInstallation(scope, installationId);
      const token = deps.cipher.decrypt(installation.botTokenEnc, slackAad(installation.id));
      const channels: Array<{ id: string; name: string; isPrivate: boolean }> = [];
      let cursor = "";
      for (let page = 0; page < 5; page += 1) {
        const body = await slackApi(
          "conversations.list",
          {
            types: "public_channel,private_channel",
            exclude_archived: "true",
            limit: "200",
            ...(cursor ? { cursor } : {}),
          },
          token,
        );
        for (const c of (body.channels as Array<Record<string, unknown>> | undefined) ?? []) {
          if (typeof c.id === "string" && typeof c.name === "string") {
            channels.push({ id: c.id, name: c.name, isPrivate: c.is_private === true });
          }
        }
        cursor = String(
          (body.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? "",
        );
        if (!cursor) break;
      }
      return channels.sort((a, b) => a.name.localeCompare(b.name));
    },

    async tokenFor(installationId) {
      const row = await repo.slackInstallation(deps.db, installationId);
      return row === undefined ? undefined : deps.cipher.decrypt(row.botTokenEnc, slackAad(row.id));
    },

    async ownsInstallation(installationId, workspaceId) {
      const row = await repo.slackInstallation(deps.db, installationId);
      return row !== undefined && row.workspaceId === workspaceId;
    },

    async telegramLink(scope, channelId) {
      if (config.telegram === undefined) {
        throw new ValidationError("Telegram isn't configured on this server.");
      }
      const channel = await repo.findScoped(deps.db, scope, channelId);
      if (channel === undefined || channel.type !== "telegram") {
        throw new NotFoundError("Telegram channel not found.");
      }
      const token = randomBytes(18).toString("base64url");
      const expiresAt = new Date(clock.now().getTime() + TELEGRAM_LINK_TTL_MS);
      await repo.upsertTelegramLink(deps.db, {
        id: deps.newId(),
        workspaceId: scope.workspaceId,
        channelId,
        linkToken: token,
        tokenExpiresAt: expiresAt,
      });
      return {
        url: `https://t.me/${config.telegram.botUsername}?start=${token}`,
        expiresAt: expiresAt.toISOString(),
      };
    },

    async telegramUpdate(update) {
      const parsed = telegramUpdateSchema.safeParse(update);
      const message = parsed.success ? parsed.data.message : undefined;
      const token = message?.text?.match(/^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{8,64})\s*$/)?.[1];
      if (message === undefined || token === undefined || deps.telegram === undefined) return;

      const chatId = String(message.chat.id);
      const chatTitle =
        message.chat.title ?? message.chat.username ?? message.chat.first_name ?? null;
      const linked = await deps.db.transaction(async (tx) => {
        const link = await repo.consumeTelegramToken(tx, token, { chatId, chatTitle }, clock.now());
        if (link === undefined) return undefined;
        const channel = await repo.findById(tx, link.channelId, true);
        if (channel === undefined) return undefined;
        await repo.setConfig(
          tx,
          channel.id,
          deps.cipher.encrypt(JSON.stringify({ chatId, chatTitle }), channelAad(channel.id)),
        );
        return channel;
      });
      const text = linked
        ? `Linked to the "${linked.name}" channel in Watchpost. Alerts will arrive here.`
        : "This link has expired or was already used. Create a new one in Watchpost.";
      try {
        await deps.telegram.call("sendMessage", { chat_id: chatId, text });
      } catch (err) {
        deps.logger.warn({ err }, "telegram link reply failed");
      }
    },
  };
  return service;
}
