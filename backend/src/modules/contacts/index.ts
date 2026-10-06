/* Public API of the contacts module. Other modules import only from this file (PRODUCT.md §7.1). */
import type { RequestHandler } from "express";
import type { AppModule, Infra } from "../../composition/types.js";
import { newId } from "../../infra/ids.js";
import type { WorkspacesService } from "../workspaces/index.js";
import { createContactsController } from "./contacts.controller.js";
import { createContactsRepository } from "./contacts.repository.js";
import { createContactsRouter } from "./contacts.routes.js";
import { createContactsService, type ContactsService } from "./contacts.service.js";

export type { ContactsService, TimedFanOutStep } from "./contacts.service.js";
export { CODE_TTL_MS, MAX_CODES_PER_HOUR, MAX_CODE_ATTEMPTS } from "./contacts.service.js";

export interface ContactsModuleDeps {
  infra: Pick<Infra, "db" | "outbox" | "clock">;
  workspaces: WorkspacesService;
  guards: { session: RequestHandler; workspace: RequestHandler };
  /* Tests fix the verification code. */
  newCode?: () => string;
}

export interface ContactsModule extends AppModule {
  service: ContactsService;
}

export function createContactsModule(deps: ContactsModuleDeps): ContactsModule {
  const service = createContactsService({
    db: deps.infra.db,
    repository: createContactsRepository(),
    workspaces: deps.workspaces,
    outbox: deps.infra.outbox,
    clock: deps.infra.clock,
    newId,
    ...(deps.newCode === undefined ? {} : { newCode: deps.newCode }),
  });
  return {
    name: "contacts",
    service,
    routers: [
      {
        path: "/api/w/:workspaceId",
        router: createContactsRouter(createContactsController(service), deps.guards),
      },
    ],
  };
}
