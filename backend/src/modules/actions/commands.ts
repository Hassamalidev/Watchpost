/*
 * `/watchpost` in Slack (PRODUCT.md §6.5): who is on call, acknowledge or resolve an incident by its
 * number, start a maintenance window, link your account. Every answer is a short text only the
 * person who typed the command sees. Looking and acknowledging work for anyone in the Slack
 * workspace (they can already see the alerts there); maintenance changes what alerts fire, so it
 * needs a linked account whose role may plan maintenance.
 */
import { roleCan, type WorkspaceRole } from "@app/shared";
import type { Clock } from "../../core/clock.js";
import { AppError } from "../../core/errors.js";
import { createWorkspaceScope, type WorkspaceScope } from "../../core/workspace-scope.js";
import type { ContactsService } from "../contacts/index.js";
import type { IncidentsService } from "../incidents/index.js";
import type { MaintenanceService } from "../maintenance/index.js";
import type { MonitorsService } from "../monitors/index.js";
import type { OncallService } from "../oncall/index.js";

export const COMMAND_HELP = [
  "*Watchpost commands*",
  "`/watchpost oncall` — who is on call now",
  "`/watchpost ack 482` — acknowledge incident #482",
  "`/watchpost resolve 482` — resolve incident #482",
  "`/watchpost maintenance 1h api` — silence alerts for monitors named like “api” for an hour (leave the name out for all monitors)",
  "`/watchpost link` — connect your Slack user to your Watchpost account",
].join("\n");

const MAX_MAINTENANCE_MS = 24 * 3_600_000;

/* "90m", "1h", "2h30m" → milliseconds; undefined for anything else, zero or more than a day. */
export function parseDuration(text: string): number | undefined {
  const match = /^(?:(\d{1,2})h)?(?:(\d{1,4})m)?$/.exec(text.trim().toLowerCase());
  if (match === null || (match[1] === undefined && match[2] === undefined)) return undefined;
  const ms = (Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0)) * 60_000;
  return ms > 0 && ms <= MAX_MAINTENANCE_MS ? ms : undefined;
}

export interface ChatCommandDeps {
  incidents: Pick<IncidentsService, "get" | "acknowledge" | "resolve">;
  contacts: Pick<ContactsService, "chatUser" | "chatLinkUrl">;
  oncall?: Pick<OncallService, "list"> | undefined;
  maintenance?: Pick<MaintenanceService, "create"> | undefined;
  monitors?: Pick<MonitorsService, "list"> | undefined;
  /* The Watchpost workspaces a Slack team is installed in. */
  slackWorkspaces: (teamId: string) => Promise<string[]>;
  clock: Clock;
}

export interface SlackCommandInput {
  teamId: string;
  externalUserId: string;
  userName: string | null;
  text: string;
}

export function createSlackCommand(deps: ChatCommandDeps) {
  async function resolveWorkspace(input: SlackCommandInput) {
    const workspaceIds = await deps.slackWorkspaces(input.teamId);
    const linked: { workspaceId: string; userId: string; role: WorkspaceRole }[] = [];
    for (const workspaceId of workspaceIds) {
      const user = await deps.contacts.chatUser(workspaceId, "slack", input.externalUserId);
      if (user !== undefined) linked.push({ workspaceId, ...user });
    }
    return { workspaceIds, linked };
  }

  return async function slackCommand(input: SlackCommandInput): Promise<string> {
    const [verb = "help", ...rest] = input.text.trim().split(/\s+/).filter(Boolean);
    const command = verb.toLowerCase();
    if (command === "help") return COMMAND_HELP;

    const { workspaceIds, linked } = await resolveWorkspace(input);
    if (workspaceIds.length === 0) {
      return "This Slack workspace isn't connected to Watchpost. An admin can connect it under Integrations.";
    }
    /* Your linked workspace if you have one, else the only one this Slack team is connected to. */
    const mine = linked[0];
    const workspaceId =
      mine?.workspaceId ?? (workspaceIds.length === 1 ? workspaceIds[0] : undefined);
    const linkUrl = (id: string) =>
      deps.contacts.chatLinkUrl({
        workspaceId: id,
        provider: "slack",
        externalId: input.externalUserId,
        externalName: input.userName,
      });
    if (workspaceId === undefined) {
      return "This Slack workspace is connected to several Watchpost workspaces. Use the buttons on an alert, or link your account from the one you mean (My notifications).";
    }
    if (command === "link") {
      return mine !== undefined
        ? "Your Slack user is already linked to your Watchpost account."
        : `Open this link while signed in to Watchpost to connect your Slack user (valid for 30 minutes):\n${linkUrl(workspaceId)}`;
    }

    const scope: WorkspaceScope = createWorkspaceScope({
      workspaceId,
      ...(mine === undefined
        ? { role: "responder" as const }
        : { actorUserId: mine.userId, role: mine.role }),
    });

    try {
      if (command === "oncall") {
        const schedules = (await deps.oncall?.list(scope)) ?? [];
        if (schedules.length === 0) return "No on-call schedules yet.";
        return schedules
          .map(
            (s) =>
              `*${s.name}*: ${s.onCall === null ? "nobody" : (s.onCall.name ?? "a former member")}`,
          )
          .join("\n");
      }

      if (command === "ack" || command === "acknowledge" || command === "resolve") {
        const number = Number((rest[0] ?? "").replace(/^#/, ""));
        if (!Number.isInteger(number) || number <= 0) {
          return `Which incident? For example \`/watchpost ${command === "resolve" ? "resolve" : "ack"} 482\`.`;
        }
        const before = await deps.incidents.get(scope, number);
        const label = `#${before.number} ${before.title}`;
        if (before.status === "resolved") return `${label} is already resolved.`;
        if (command === "resolve") {
          await deps.incidents.resolve(scope, before.id, { via: "slack" });
          return `Resolved ${label}.`;
        }
        if (before.status === "acknowledged") return `${label} is already acknowledged.`;
        await deps.incidents.acknowledge(scope, before.id, { via: "slack" });
        return `Acknowledged ${label}.`;
      }

      if (command === "maintenance") {
        if (deps.maintenance === undefined || deps.monitors === undefined) return COMMAND_HELP;
        if (mine === undefined) {
          return `Starting maintenance needs your Watchpost account. Link it first (valid for 30 minutes):\n${linkUrl(workspaceId)}`;
        }
        if (!roleCan(mine.role, "maintenance:write")) {
          return "Your role in Watchpost can't start maintenance. Ask a member or an admin.";
        }
        const ms = parseDuration(rest[0] ?? "");
        if (ms === undefined) {
          return "How long? For example `/watchpost maintenance 30m` or `/watchpost maintenance 2h api` (up to 24h).";
        }
        const fragment = rest.slice(1).join(" ").trim();
        let target: { all: true } | { monitorIds: string[] } = { all: true };
        let what = "all monitors";
        if (fragment !== "") {
          const found = (await deps.monitors.list(scope, { limit: 100, q: fragment })).data;
          if (found.length === 0) return `No monitor is named like “${fragment}”.`;
          target = { monitorIds: found.map((m) => m.id) };
          what =
            found.length === 1
              ? (found[0]?.name ?? fragment)
              : `${found.length} monitors named like “${fragment}”`;
        }
        const now = deps.clock.now();
        const window = await deps.maintenance.create(scope, {
          name: `Started from Slack${input.userName === null ? "" : ` by ${input.userName}`}`,
          startsAt: now.toISOString(),
          endsAt: new Date(now.getTime() + ms).toISOString(),
          timezone: "UTC",
          rrule: null,
          scope: target,
          suppressAlerts: true,
          showOnPages: true,
        });
        return `Maintenance started for ${what} until <!date^${Math.floor(Date.parse(window.endsAt) / 1_000)}^{time}|${window.endsAt}>. Alerts for them are silenced until then.`;
      }
    } catch (err) {
      /* A missing incident, a refused action: say it the way the API would. */
      if (err instanceof AppError) return err.message;
      throw err;
    }
    return COMMAND_HELP;
  };
}
