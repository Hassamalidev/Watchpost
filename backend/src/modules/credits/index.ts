/* Public API of the credits module. Other modules import only from this file (PRODUCT.md §7.1). */
import type { RequestHandler } from "express";
import type { AppModule, Infra } from "../../composition/types.js";
import {
  anthropicBalanceReader,
  createTwilioBalanceReader,
  type ProviderBalanceReader,
} from "../../infra/funding/index.js";
import { newId } from "../../infra/ids.js";
import type { BillingService } from "../billing/index.js";
import { createCreditsRepository } from "./credits.repository.js";
import { createCreditsRouter } from "./credits.routes.js";
import { createCreditsService, type CreditsService } from "./credits.service.js";
import { createCreditsProcessors } from "./jobs/index.js";

export type {
  AiBudget,
  ChargeResult,
  CreditsService,
  ProviderFundingStatus,
  UsageInput,
} from "./credits.service.js";

export interface CreditsModuleDeps {
  infra: Pick<Infra, "db" | "clock" | "outbox" | "logger" | "config" | "locks">;
  billing: BillingService;
  guards: { session: RequestHandler; workspace: RequestHandler };
  /* Tests replace the provider balance lookups. */
  balanceReaders?: ProviderBalanceReader[];
}

export interface CreditsModule extends AppModule {
  service: CreditsService;
}

const HOUR_MS = 3_600_000;

export function createCreditsModule(deps: CreditsModuleDeps): CreditsModule {
  const { infra } = deps;
  const service = createCreditsService({
    db: infra.db,
    repository: createCreditsRepository(),
    billing: deps.billing,
    outbox: infra.outbox,
    clock: infra.clock,
    logger: infra.logger.child({ module: "credits" }),
    newId,
    locks: infra.locks,
    funding: infra.config.funding,
    balanceReaders: deps.balanceReaders ?? [
      anthropicBalanceReader,
      ...(infra.config.twilio === undefined
        ? []
        : [createTwilioBalanceReader(infra.config.twilio)]),
    ],
  });
  return {
    name: "credits",
    service,
    routers: [{ path: "/api/w/:workspaceId", router: createCreditsRouter(service, deps.guards) }],
    processors: createCreditsProcessors(service, infra.db),
    sweeps: [
      {
        /* Annual plans are paid once a year but get credits every month. */
        kind: "credits-grants",
        everyMs: HOUR_MS,
        async run(logger) {
          const granted = await service.grantSweep();
          if (granted > 0) logger.info({ granted }, "monthly credits granted");
        },
      },
      {
        kind: "provider-funding",
        everyMs: HOUR_MS,
        async run(logger) {
          const short = (await service.checkFunding()).filter((s) => (s.shortfallMicros ?? 0) > 0);
          if (short.length > 0) {
            logger.error({ providers: short.map((s) => s.provider) }, "provider balances short");
          }
        },
      },
    ],
  };
}
