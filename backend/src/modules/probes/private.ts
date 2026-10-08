/*
 * Private probes (PRODUCT.md §4 "Inside and outside your network", §5): a probe the customer runs
 * inside their own network, so internal services can be monitored. Each is a check location of its
 * own (`private:<probe ID>`); a monitor is put on one by choosing it instead of our regions.
 *
 * - Creating one answers with a token (`wpp_<id>.<secret>`) and the one-line Docker command, once.
 *   The secret is the probe's HMAC key, stored encrypted like any probe's.
 * - "Online" means it reported in the last five minutes. When one goes silent its workspace's
 *   owners and admins get one email; the next report clears that.
 * - How many a workspace may have comes from its plan (`privateProbes`).
 */
import { Router, type RequestHandler } from "express";
import { z } from "zod";
import {
  PRIVATE_PROBE_OFFLINE_AFTER_MS,
  PROBE_CURRENT_VERSION,
  PROBE_TOKEN_PREFIX,
  createPrivateProbeSchema,
  privateRegionOf,
  type CreatePrivateProbeInput,
  type CreatedPrivateProbe,
  type PrivateProbeView,
} from "@app/shared";
import type { Clock } from "../../core/clock.js";
import { ConflictError, NotFoundError, QuotaExceededError } from "../../core/errors.js";
import { createWorkspaceScope, type WorkspaceScope } from "../../core/workspace-scope.js";
import type { Db } from "../../infra/db/index.js";
import type { Outbox } from "../../infra/outbox/index.js";
import { requirePermission } from "../../middleware/roles.js";
import { inputOf, validate } from "../../middleware/validate.js";
import { scopeOf } from "../../middleware/workspace.js";
import type { MonitorsService } from "../monitors/index.js";
import type { WorkspacesService } from "../workspaces/index.js";
import type { ProbesRepository } from "./probes.repository.js";
import type { ProbeRow } from "./schema/probes.js";

/* "0.10.0" is newer than "0.9.1": compare the numbers, not the text. */
function older(version: string | null, than: string): boolean {
  if (version === null) return false;
  const parts = (v: string) => v.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [a, b] = [parts(version), parts(than)];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
}

export interface PrivateProbesService {
  list(scope: WorkspaceScope): Promise<PrivateProbeView[]>;
  create(scope: WorkspaceScope, input: CreatePrivateProbeInput): Promise<CreatedPrivateProbe>;
  /* Refused while monitors still run on it. */
  remove(scope: WorkspaceScope, id: string): Promise<void>;
  /* The workspace's private locations, for checking a monitor's regions. */
  regions(scope: WorkspaceScope): Promise<string[]>;
  /* System: tells workspaces whose probe went silent; returns how many probes that was. */
  notifyOffline(): Promise<number>;
}

export function createPrivateProbesService(deps: {
  db: Db;
  repository: ProbesRepository;
  /* Creates the probe row and its secret (the probes service). */
  register(input: {
    name: string;
    region: string;
    kind: "private";
    workspaceId: string;
  }): Promise<{ id: string; secret: string }>;
  /* Drops a deleted probe from the authentication cache. */
  forget(probeId: string): void;
  monitors: Pick<MonitorsService, "planLimits" | "countByRegion">;
  workspaces: Pick<WorkspacesService, "listMembers" | "workspaceName">;
  outbox: Outbox;
  clock: Clock;
  webOrigin: string;
  image: string;
}): PrivateProbesService {
  const { repository: repo, clock } = deps;

  async function views(scope: WorkspaceScope, rows: ProbeRow[]): Promise<PrivateProbeView[]> {
    const counts = await deps.monitors.countByRegion(
      scope,
      rows.map((row) => row.region),
    );
    const now = clock.now().getTime();
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      region: row.region,
      online:
        row.lastSeenAt !== null && now - row.lastSeenAt.getTime() < PRIVATE_PROBE_OFFLINE_AFTER_MS,
      lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
      version: row.version,
      upgradeAvailable: older(row.version, PROBE_CURRENT_VERSION),
      monitors: counts.get(row.region) ?? 0,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /* One line to paste on any machine with Docker. The volume keeps unsent results across restarts. */
  const commandOf = (token: string) =>
    [
      "docker run -d --name monitoring-probe --restart unless-stopped",
      "--cap-drop ALL --cap-add NET_RAW",
      "-v monitoring-probe:/var/lib/watchpost-probe",
      `-e API_URL=${deps.webOrigin}`,
      `-e PROBE_TOKEN=${token}`,
      deps.image,
    ].join(" ");

  return {
    async list(scope) {
      return views(scope, await repo.privateProbes(scope));
    },

    async regions(scope) {
      return (await repo.privateProbes(scope)).map((row) => row.region);
    },

    async create(scope, input) {
      const [limits, existing] = await Promise.all([
        deps.monitors.planLimits(scope),
        repo.privateProbes(scope),
      ]);
      if (existing.length >= limits.privateProbes) {
        throw new QuotaExceededError(
          limits.privateProbes === 0
            ? "Private probes are part of the Pro and Business plans. Upgrade to monitor services inside your network."
            : `Your plan includes ${limits.privateProbes} private probe${limits.privateProbes === 1 ? "" : "s"}. Remove one, or add another to your plan.`,
        );
      }
      /* The location is named after the probe's ID, which exists only once it is registered. */
      const { id, secret } = await deps.register({
        name: input.name,
        region: "private:pending",
        kind: "private",
        workspaceId: scope.workspaceId,
      });
      await repo.setRegion(id, privateRegionOf(id));
      deps.forget(id);
      const row = (await repo.privateProbes(scope)).find((probe) => probe.id === id);
      if (row === undefined) throw new Error("private probe wasn't stored");
      const token = `${PROBE_TOKEN_PREFIX}${id}.${secret}`;
      const [view] = await views(scope, [row]);
      if (view === undefined) throw new Error("private probe has no view");
      return { ...view, token, command: commandOf(token) };
    },

    async remove(scope, id) {
      const row = (await repo.privateProbes(scope)).find((probe) => probe.id === id);
      if (row === undefined) throw new NotFoundError("Private probe not found.");
      const inUse = (await deps.monitors.countByRegion(scope, [row.region])).get(row.region) ?? 0;
      if (inUse > 0) {
        throw new ConflictError(
          `${inUse} monitor${inUse === 1 ? " runs" : "s run"} on this probe. Move or delete ${inUse === 1 ? "it" : "them"} first.`,
        );
      }
      await repo.deletePrivateProbe(scope, id);
      deps.forget(id);
    },

    async notifyOffline() {
      const now = clock.now();
      const silent = await repo.claimSilentPrivateProbes(
        new Date(now.getTime() - PRIVATE_PROBE_OFFLINE_AFTER_MS),
        now,
      );
      for (const probe of silent) {
        if (probe.workspaceId === null) continue;
        const scope = createWorkspaceScope({ workspaceId: probe.workspaceId });
        const [members, workspaceName, counts] = await Promise.all([
          deps.workspaces.listMembers(scope),
          deps.workspaces.workspaceName(scope),
          deps.monitors.countByRegion(scope, [probe.region]),
        ]);
        const data = {
          workspaceName,
          probeName: probe.name,
          lastSeenAt: probe.lastSeenAt?.toISOString() ?? now.toISOString(),
          monitors: counts.get(probe.region) ?? 0,
          url: `${deps.webOrigin}/w/${probe.workspaceId}/settings`,
        };
        await deps.db.transaction(async (tx) => {
          for (const member of members) {
            if (member.role !== "owner" && member.role !== "admin") continue;
            await deps.outbox.emit(
              tx,
              "email.requested",
              {
                template: "probe-offline",
                to: member.email,
                data,
                idempotencyKey: `probe-offline.${probe.id}.${now.getTime()}.${member.userId}`,
              },
              { workspaceId: probe.workspaceId ?? undefined },
            );
          }
        });
      }
      return silent.length;
    },
  };
}

const probeIdParams = z.object({ probeId: z.uuid() });

/*
 * /api/w/:workspaceId/private-probes: whoever sees monitors sees the probes; a probe is a foothold
 * in the customer's network, so only admins add and remove them (`settings:update`).
 */
export function createPrivateProbesRouter(
  service: PrivateProbesService,
  guards: { session: RequestHandler; workspace: RequestHandler },
): Router {
  const router = Router({ mergeParams: true });
  router.use("/private-probes", guards.session, guards.workspace);
  const manage = requirePermission("settings:update");
  router.get("/private-probes", requirePermission("monitor:read"), async (req, res) => {
    res.json({ data: await service.list(scopeOf(req, res)) });
  });
  router.post(
    "/private-probes",
    manage,
    validate({ body: createPrivateProbeSchema }),
    async (req, res) => {
      const { body } = inputOf<{ body: typeof createPrivateProbeSchema }>(req, res);
      /* The answer holds the probe's token, so nothing on the way may keep a copy. */
      res
        .status(201)
        .set("cache-control", "no-store")
        .json(await service.create(scopeOf(req, res), body));
    },
  );
  router.delete(
    "/private-probes/:probeId",
    manage,
    validate({ params: probeIdParams }),
    async (req, res) => {
      const { params } = inputOf<{ params: typeof probeIdParams }>(req, res);
      await service.remove(scopeOf(req, res), params.probeId);
      res.status(204).end();
    },
  );
  return router;
}
