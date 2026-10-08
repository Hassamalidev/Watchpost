/* The apikeys module's own route in the public API: what the key in use is and may do. */
import { v1KeyInfoSchema } from "@app/shared";
import { publicRoute, type PublicRoute } from "../../core/public-api.js";
import type { ApikeysService } from "./apikeys.service.js";

export function apikeysPublicRoutes(service: ApikeysService): PublicRoute[] {
  return [
    publicRoute({
      method: "get",
      path: "/me",
      scope: null,
      tag: "Key",
      summary: "The key in use",
      description:
        "A quick way to check that a key works, which workspace it opens and what it may do.",
      status: 200,
      response: v1KeyInfoSchema,
      handle: async ({ scope, key }) => ({
        workspaceId: scope.workspaceId,
        workspaceName: await service.workspaceName(scope),
        keyName: key.name,
        scopes: key.scopes,
        expiresAt: key.expiresAt?.toISOString() ?? null,
      }),
    }),
  ];
}
