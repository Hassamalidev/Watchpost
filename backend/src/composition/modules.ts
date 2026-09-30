/*
 * The list of modules, in dependency order. `pnpm new:module <name>` appends here.
 * Pass each factory the modules it may call (composition/architecture.ts), never the whole list.
 */
import type { AppModule, Infra } from "./types.js";
import { createWorkspacesModule } from "../modules/workspaces/index.js";
import { createMonitorsModule } from "../modules/monitors/index.js";
/* new-module:imports */

export function createModules(infra: Infra): AppModule[] {
  const modules: AppModule[] = [];
  const workspaces = createWorkspacesModule({ infra });
  modules.push(workspaces);
  modules.push(createMonitorsModule({ infra, guards: workspaces.guards }));
  /* new-module:create */
  return modules;
}
