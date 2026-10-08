/* Status pages in the public API (/api/v1): read-only for now. */
import { v1StatusPageListSchema } from "@app/shared";
import { publicRoute, type PublicRoute } from "../../core/public-api.js";
import type { StatuspagesService } from "./statuspages.service.js";

export function statuspagesPublicRoutes(service: Pick<StatuspagesService, "list">): PublicRoute[] {
  return [
    publicRoute({
      method: "get",
      path: "/status-pages",
      scope: "status_pages:read",
      tag: "Status pages",
      summary: "List status pages",
      status: 200,
      response: v1StatusPageListSchema,
      handle: async ({ scope }) => ({
        data: (await service.list(scope)).map((page) => ({
          id: page.id,
          name: page.name,
          slug: page.slug,
          url: page.url,
          published: page.published,
          components: page.components.map((c) => ({
            id: c.id,
            name: c.name,
            monitorId: c.monitorId,
          })),
        })),
      }),
    }),
  ];
}
