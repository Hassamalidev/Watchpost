/*
 * Incident actions from email links (PRODUCT.md §10). A link is verified (signature, expiry), shown on
 * a confirmation page (GET never changes anything, so mail scanners that prefetch links are
 * harmless), and performed once: the nonce is recorded before acting, and a second use is refused.
 * The action runs as the recipient's user when they are a member, and is marked "via email".
 */
import type { Clock } from "../../core/clock.js";
import { ConflictError, GoneError, NotFoundError } from "../../core/errors.js";
import { createWorkspaceScope } from "../../core/workspace-scope.js";
import {
  ActionLinkError,
  type ActionClaims,
  type ActionLinks,
  type LinkAction,
} from "../../infra/action-links.js";
import type { Db } from "../../infra/db/index.js";
import type { PhonesService } from "../channels/index.js";
import type { IncidentsService, IncidentStatus } from "../incidents/index.js";
import type { WorkspacesService } from "../workspaces/index.js";
import type { ActionsRepository } from "./actions.repository.js";

export interface ActionPreview {
  action: LinkAction;
  recipient: string;
  expiresAt: string;
  used: boolean;
  incident: { number: number; title: string; status: IncidentStatus };
}

export interface ActionOutcome {
  action: LinkAction;
  /* "done", or "already" when the incident was already in that state. */
  result: "done" | "already";
  incident: { number: number; title: string; status: IncidentStatus };
}

export interface ActionsService {
  preview(token: string): Promise<ActionPreview>;
  perform(token: string): Promise<ActionOutcome>;
  /*
   * A reply to an SMS alert ("1" acknowledges, "2" resolves) or the key pressed during a voice alert
   * ("1" acknowledges). The caller has verified that the provider sent it, so the number is the
   * credential: it acts on the last incident that number was alerted about. Returns what to answer,
   * or null to stay silent.
   */
  phoneReply(input: {
    phone: string;
    text: string;
    via: "sms" | "voice";
    incidentId?: string | undefined;
  }): Promise<string | null>;
}

export function createActionsService(deps: {
  db: Db;
  repository: ActionsRepository;
  links: ActionLinks;
  incidents: Pick<IncidentsService, "get" | "acknowledge" | "resolve">;
  workspaces: Pick<WorkspacesService, "listMembers">;
  phones?: Pick<PhonesService, "replyTarget"> | undefined;
  clock: Clock;
}): ActionsService {
  function claimsOf(token: string): ActionClaims {
    try {
      return deps.links.verify(token);
    } catch (err) {
      if (err instanceof ActionLinkError) {
        if (err.reason === "expired") throw new GoneError(err.message);
        throw new NotFoundError(err.message);
      }
      throw err;
    }
  }

  async function actorOf(claims: ActionClaims) {
    const members = await deps.workspaces.listMembers(
      createWorkspaceScope({ workspaceId: claims.workspaceId }),
    );
    const member = members.find((m) => m.email.toLowerCase() === claims.recipient);
    return createWorkspaceScope({
      workspaceId: claims.workspaceId,
      ...(member ? { actorUserId: member.userId, role: member.role } : { role: "responder" }),
    });
  }

  const summary = (i: { number: number; title: string; status: IncidentStatus }) => ({
    number: i.number,
    title: i.title,
    status: i.status,
  });

  return {
    async preview(token) {
      const claims = claimsOf(token);
      const used = await deps.repository.isUsed(deps.db, claims.nonce);
      const incident = await deps.incidents.get(
        createWorkspaceScope({ workspaceId: claims.workspaceId }),
        claims.incidentId,
      );
      return {
        action: claims.action,
        recipient: claims.recipient,
        expiresAt: claims.expiresAt.toISOString(),
        used,
        incident: summary(incident),
      };
    },

    async perform(token) {
      const claims = claimsOf(token);
      const scope = await actorOf(claims);
      const first = await deps.repository.markUsed(deps.db, {
        nonce: claims.nonce,
        workspaceId: claims.workspaceId,
        incidentId: claims.incidentId,
        action: claims.action,
        recipient: claims.recipient,
        usedAt: deps.clock.now(),
        usedBy: scope.actorUserId ?? null,
      });
      if (!first) throw new ConflictError("This link was already used.");

      const before = await deps.incidents.get(scope, claims.incidentId);
      const target: IncidentStatus = claims.action === "acknowledge" ? "acknowledged" : "resolved";
      if (before.status === target || before.status === "resolved") {
        return { action: claims.action, result: "already", incident: summary(before) };
      }
      const after =
        claims.action === "acknowledge"
          ? await deps.incidents.acknowledge(scope, claims.incidentId, { via: "email" })
          : await deps.incidents.resolve(scope, claims.incidentId, { via: "email" });
      return { action: claims.action, result: "done", incident: summary(after) };
    },

    async phoneReply({ phone, text, via, incidentId }) {
      const digit = text.trim().charAt(0);
      const wanted =
        digit === "1" ? "acknowledge" : digit === "2" && via === "sms" ? "resolve" : null;
      if (wanted === null) {
        /* Anything else (STOP and HELP are handled by the provider) gets one line of help. */
        return via === "sms" && text.trim() !== ""
          ? "Watchpost: reply 1 to acknowledge or 2 to resolve the latest alert."
          : null;
      }
      const target = await deps.phones?.replyTarget(phone, incidentId);
      if (target === undefined) return "Watchpost: there is no alert for this number to act on.";

      const scope = createWorkspaceScope({ workspaceId: target.workspaceId, role: "responder" });
      const before = await deps.incidents.get(scope, target.incidentId);
      const label = `#${before.number}`;
      if (before.status === "resolved") return `Watchpost: ${label} is already resolved.`;
      if (wanted === "acknowledge") {
        if (before.status === "acknowledged") return `Watchpost: ${label} is already acknowledged.`;
        await deps.incidents.acknowledge(scope, target.incidentId, { via });
        return `Watchpost: ${label} acknowledged.`;
      }
      await deps.incidents.resolve(scope, target.incidentId, { via });
      return `Watchpost: ${label} resolved.`;
    },
  };
}
