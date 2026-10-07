/* HTTP in and out only; no business logic. */
import type { RequestHandler } from "express";
import { inputOf } from "../../middleware/validate.js";
import { scopeOf } from "../../middleware/workspace.js";
import { BADGE_CACHE_SECONDS, type BadgesService } from "./badges.service.js";
import { renderBadge } from "./render.js";
import type { badgeParams, badgeQuery, monitorIdParams } from "./validators/index.js";

export type BadgesController = Record<"links" | "badge", RequestHandler>;

const CACHE = `public, max-age=${BADGE_CACHE_SECONDS}, s-maxage=${BADGE_CACHE_SECONDS}`;
/* A URL that isn't ours still answers with an image, so a broken badge says why. */
const UNKNOWN = renderBadge({ label: "badge", message: "not found", color: "gray" });

export function createBadgesController(service: BadgesService): BadgesController {
  return {
    links: async (req, res) => {
      const { params } = inputOf<{ params: typeof monitorIdParams }>(req, res);
      res.json(await service.links(scopeOf(req, res), params.monitorId));
    },
    badge: async (req, res) => {
      const { params, query } = inputOf<{ params: typeof badgeParams; query: typeof badgeQuery }>(
        req,
        res,
      );
      const svg = await service.render(params.token, params.file, query);
      res
        .status(svg === undefined ? 404 : 200)
        .set("cache-control", svg === undefined ? "no-store" : CACHE)
        /* An image only: nothing in it may run, wherever it is embedded. */
        .set("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'")
        .set("x-content-type-options", "nosniff")
        /* Badges are made to be embedded on other sites. */
        .set("cross-origin-resource-policy", "cross-origin")
        .type("image/svg+xml")
        .send(svg ?? UNKNOWN);
    },
  };
}
