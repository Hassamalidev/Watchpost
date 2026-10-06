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
import { createHeartbeatsModule } from "../modules/heartbeats/index.js";
import { createExpiryModule } from "../modules/expiry/index.js";
import { createActionsModule } from "../modules/actions/index.js";
import { createReportsModule } from "../modules/reports/index.js";
import { createDeploysModule } from "../modules/deploys/index.js";
import { createBillingModule } from "../modules/billing/index.js";
import { createCreditsModule } from "../modules/credits/index.js";
import { createMaintenanceModule } from "../modules/maintenance/index.js";
import { createContactsModule } from "../modules/contacts/index.js";
import { createOncallModule } from "../modules/oncall/index.js";
import { createInboundModule } from "../modules/inbound/index.js";
/* new-module:imports */

export function createModules(infra: Infra): AppModule[] {
  const modules: AppModule[] = [];
  const workspaces = createWorkspacesModule({ infra });
  modules.push(workspaces);
  const billing = createBillingModule({
    infra,
    workspaces: workspaces.service,
    guards: workspaces.guards,
  });
  modules.push(billing);
  const credits = createCreditsModule({
    infra,
    billing: billing.service,
    guards: workspaces.guards,
  });
  modules.push(credits);
  const monitors = createMonitorsModule({
    infra,
    guards: workspaces.guards,
    limits: billing.service.limits,
  });
  modules.push(monitors);
  const results = createResultsModule({
    infra,
    monitors: monitors.service,
    guards: workspaces.guards,
  });
  modules.push(results);
  const probes = createProbesModule({
    infra,
    monitors: monitors.service,
    results: results.service,
    guards: workspaces.guards,
  });
  modules.push(probes);
  const deploys = createDeploysModule({ infra, guards: workspaces.guards });
  modules.push(deploys);
  const incidents = createIncidentsModule({
    infra,
    workspaces: workspaces.service,
    monitors: monitors.service,
    deploys: deploys.service,
    guards: workspaces.guards,
  });
  modules.push(incidents);
  const maintenance = createMaintenanceModule({
    infra,
    monitors: monitors.service,
    guards: workspaces.guards,
  });
  modules.push(maintenance);
  const detection = createDetectionModule({
    infra,
    maintenance: maintenance.service,
    monitors: monitors.service,
    results: results.service,
    probes: probes.service,
    incidents: incidents.service,
    deploys: deploys.service,
    guards: workspaces.guards,
  });
  modules.push(detection);
  modules.push(
    createHeartbeatsModule({
      infra,
      maintenance: maintenance.service,
      monitors: monitors.service,
      incidents: incidents.service,
      guards: workspaces.guards,
    }),
  );
  modules.push(
    createExpiryModule({
      infra,
      monitors: monitors.service,
      results: results.service,
      incidents: incidents.service,
      guards: workspaces.guards,
    }),
  );
  const channels = createChannelsModule({
    infra,
    guards: workspaces.guards,
    credits: credits.service,
  });
  modules.push(channels);
  const contacts = createContactsModule({
    infra,
    workspaces: workspaces.service,
    phones: channels.phones,
    guards: workspaces.guards,
  });
  modules.push(contacts);
  const oncall = createOncallModule({
    infra,
    workspaces: workspaces.service,
    contacts: contacts.service,
    guards: workspaces.guards,
  });
  modules.push(oncall);
  modules.push(
    createAlertingModule({
      infra,
      incidents: incidents.service,
      channels: channels.service,
      workspaces: workspaces.service,
      contacts: contacts.service,
      oncall: oncall.service,
      credits: credits.service,
      guards: workspaces.guards,
    }),
  );
  modules.push(
    createActionsModule({
      infra,
      incidents: incidents.service,
      workspaces: workspaces.service,
      phones: channels.phones,
      messaging: channels.messaging,
      channels: channels.service,
      integrations: channels.integrations,
      contacts: contacts.service,
      oncall: oncall.service,
      maintenance: maintenance.service,
      monitors: monitors.service,
    }),
  );
  modules.push(
    createReportsModule({
      infra,
      workspaces: workspaces.service,
      incidents: incidents.service,
      detection: detection.service,
      monitors: monitors.service,
    }),
  );
  modules.push(
    createInboundModule({ infra, incidents: incidents.service, guards: workspaces.guards }),
  );
  /* new-module:create */
  return modules;
}
