/*
 * /api/w/:workspaceId/channels: session → workspace → role → validate → controller (§6.11).
 * Everyone but billing sees which channels exist and their health; admins manage them (integrations),
 * and only admins see a channel's configuration.
 */
import { Router, type RequestHandler } from "express";
import { requireRole } from "../../middleware/roles.js";
import { validate } from "../../middleware/validate.js";
import type { ChannelsController } from "./channels.controller.js";
import { channelIdParams, createChannelBody, updateChannelBody } from "./validators/index.js";

export function createChannelsRouter(
  controller: ChannelsController,
  guards: { session: RequestHandler; workspace: RequestHandler },
): Router {
  const router = Router({ mergeParams: true });
  const read = requireRole("viewer");
  const admin = requireRole("admin");
  const id = validate({ params: channelIdParams });
  router.use("/channels", guards.session, guards.workspace);

  router.get("/channels", read, controller.list);
  /* Before `/:channelId`, which would read "types" as an ID. */
  router.get("/channels/types", read, controller.types);
  router.post("/channels", admin, validate({ body: createChannelBody }), controller.create);
  router.get("/channels/:channelId", admin, id, controller.get);
  router.patch(
    "/channels/:channelId",
    admin,
    validate({ params: channelIdParams, body: updateChannelBody }),
    controller.update,
  );
  router.delete("/channels/:channelId", admin, id, controller.remove);
  return router;
}
