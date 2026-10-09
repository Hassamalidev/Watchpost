/* Public API of the workspaces module. Other modules import only from this file (PRODUCT.md §7.1). */
import type { RequestHandler } from "express";
import type { PlanFeature } from "@app/shared";
import type { AppModule, Infra } from "../../composition/types.js";
import { newId } from "../../infra/ids.js";
import { requireSession } from "../../middleware/session.js";
import type { WorkspaceScope } from "../../core/workspace-scope.js";
import { requireWorkspace } from "../../middleware/workspace.js";
import { createWorkspacesController } from "./workspaces.controller.js";
import { createWorkspacesRepository } from "./workspaces.repository.js";
import { createWorkspacesRouter } from "./workspaces.routes.js";
import { createWorkspacesService, type WorkspacesService } from "./workspaces.service.js";
import { workspacesProcessors } from "./jobs/index.js";

export type {
  WorkspaceMember,
  WorkspaceSettings,
  WorkspacesService,
} from "./workspaces.service.js";
export { TRIAL_DAYS, systemScope } from "./workspaces.service.js";

export interface WorkspacesModuleDeps {
  infra: Pick<Infra, "db" | "clock" | "auth" | "outbox">;
  /* The billing module's plan check, wired by the container once billing exists. */
  hasFeature?: (scope: WorkspaceScope, feature: PlanFeature) => Promise<boolean>;
  /* How many client workspaces the plan includes. */
  clientLimit?: (scope: WorkspaceScope) => Promise<number>;
}

/* Guards other modules put in front of their /api/w/:workspaceId routes. */
export interface WorkspaceGuards {
  session: RequestHandler;
  workspace: RequestHandler;
}

export interface WorkspacesModule extends AppModule {
  service: WorkspacesService;
  guards: WorkspaceGuards;
}

export const WORKSPACE_API_PREFIX = "/api/w/:workspaceId";

export function createWorkspacesModule(deps: WorkspacesModuleDeps): WorkspacesModule {
  const repository = createWorkspacesRepository(deps.infra.db);
  const service = createWorkspacesService({
    db: deps.infra.db,
    repository,
    outbox: deps.infra.outbox,
    clock: deps.infra.clock,
    hasFeature: deps.hasFeature,
    clientLimit: deps.clientLimit,
    /* Through the auth library, so the workspace gets its owner and every hook runs. */
    createWorkspace: async ({ name, ownerUserId }) => {
      const created = await deps.infra.auth.auth.api.createOrganization({
        body: { name, slug: `client-${newId()}`, userId: ownerUserId },
      });
      if (created === null) throw new Error("the auth library didn't create the workspace");
      return created.id;
    },
  });
  const guards: WorkspaceGuards = {
    session: requireSession(deps.infra.auth.getSession),
    workspace: requireWorkspace(service.resolveRole, {
      requiresTwoFactor: (workspaceId) => service.requiresTwoFactor(workspaceId),
    }),
  };
  const controller = createWorkspacesController(service);
  return {
    name: "workspaces",
    service,
    guards,
    routers: [{ path: WORKSPACE_API_PREFIX, router: createWorkspacesRouter(controller, guards) }],
    processors: workspacesProcessors,
    recoverySweeps: [
      /* Workspaces created by Better Auth whose settings hook never ran (crash in between). */
      { name: "workspace-settings", run: () => service.repairMissingSettings() },
    ],
    hooks: {
      onWorkspaceCreated: (workspaceId) => service.ensureSettings(workspaceId).then(() => {}),
    },
  };
}
