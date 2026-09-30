/*
 * The list of modules, in dependency order. `pnpm new:module <name>` appends here.
 * Pass each factory the modules it may call (composition/architecture.ts), never the whole list.
 */
import type { AppModule, Infra } from "./types.js";
import { createWorkspacesModule } from "../modules/workspaces/index.js";
import { createMonitorsModule } from "../modules/monitors/index.js";
import { createResultsModule } from "../modules/results/index.js";
import { createProbesModule } from "../modules/probes/index.js";
import { createDetectionModule } from "../modules/detection/index.js";
import { createIncidentsModule } from "../modules/incidents/index.js";
import { createChannelsModule } from "../modules/channels/index.js";
import { createAlertingModule } from "../modules/alerting/index.js";
/* new-module:imports */

export function createModules(infra: Infra): AppModule[] {
  const modules: AppModule[] = [];
  const workspaces = createWorkspacesModule({ infra });
  modules.push(workspaces);
  const monitors = createMonitorsModule({ infra, guards: workspaces.guards });
  modules.push(monitors);
  const results = createResultsModule({ infra });
  modules.push(results);
  const probes = createProbesModule({
    infra,
    monitors: monitors.service,
    guards: workspaces.guards,
  });
  modules.push(probes);
  const incidents = createIncidentsModule({
    infra,
    workspaces: workspaces.service,
    monitors: monitors.service,
    guards: workspaces.guards,
  });
  modules.push(incidents);
  modules.push(
    createDetectionModule({
      infra,
      monitors: monitors.service,
      results: results.service,
      probes: probes.service,
      incidents: incidents.service,
    }),
  );
  const channels = createChannelsModule({ infra, guards: workspaces.guards });
  modules.push(channels);
  modules.push(
    createAlertingModule({
      infra,
      incidents: incidents.service,
      channels: channels.service,
      workspaces: workspaces.service,
      guards: workspaces.guards,
    }),
  );
  /* new-module:create */
  return modules;
}
