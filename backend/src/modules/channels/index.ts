/* Public API of the channels module. Other modules import only from this file (PRODUCT.md §7.1). */
import type { RequestHandler } from "express";
import type { AppModule, Infra } from "../../composition/types.js";
import { newId } from "../../infra/ids.js";
import { createEmailAdapter } from "./adapters/email.js";
import { createChannelsController } from "./channels.controller.js";
import { createChannelsRepository } from "./channels.repository.js";
import { createChannelsRouter } from "./channels.routes.js";
import { createChannelsService, type ChannelsService } from "./channels.service.js";
import type { AnyChannelAdapter } from "./types/adapter.js";

export type {
  ChannelDetail,
  ChannelSummary,
  ChannelView,
  ChannelsService,
} from "./channels.service.js";
export {
  ChannelDeliveryError,
  type AlertEvent,
  type AnyChannelAdapter,
  type ChannelAdapter,
  type RenderedMessage,
  type SendMeta,
  type SendResult,
} from "./types/adapter.js";
export { alertTitle, formatDuration, renderPlain } from "./adapters/render.js";

export interface ChannelsModuleDeps {
  infra: Pick<Infra, "db" | "clock" | "outbox" | "cipher" | "logger" | "requestEmail">;
  guards: { session: RequestHandler; workspace: RequestHandler };
  /* Replaces the built-in adapters (tests use fakes). */
  adapters?: AnyChannelAdapter[];
}

export interface ChannelsModule extends AppModule {
  service: ChannelsService;
}

export function createChannelsModule(deps: ChannelsModuleDeps): ChannelsModule {
  const service = createChannelsService({
    db: deps.infra.db,
    repository: createChannelsRepository(),
    adapters: deps.adapters ?? [createEmailAdapter({ requestEmail: deps.infra.requestEmail })],
    cipher: deps.infra.cipher,
    outbox: deps.infra.outbox,
    clock: deps.infra.clock,
    logger: deps.infra.logger.child({ module: "channels" }),
    newId,
  });
  return {
    name: "channels",
    service,
    routers: [
      {
        path: "/api/w/:workspaceId",
        router: createChannelsRouter(createChannelsController(service), deps.guards),
      },
    ],
  };
}
