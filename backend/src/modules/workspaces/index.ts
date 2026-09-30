/* Public API of the workspaces module. Other modules import only from this file (PRODUCT.md §7.1). */
import type { RequestHandler } from "express";
import type { AppModule, Infra } from "../../composition/types.js";
import { requireSession } from "../../middleware/session.js";
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
  });
  const guards: WorkspaceGuards = {
    session: requireSession(deps.infra.auth.getSession),
    workspace: requireWorkspace(service.resolveRole),
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
