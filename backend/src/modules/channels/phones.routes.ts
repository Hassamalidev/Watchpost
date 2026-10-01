/*
 * /api/w/:workspaceId/phone-numbers: what a number costs to alert, and its verification by one-time
 * code. Admins only, like the channels they are for.
 */
import { Router, type RequestHandler } from "express";
import { phoneConfirmationSchema, phoneVerificationSchema } from "@app/shared";
import { requireRole } from "../../middleware/roles.js";
import { inputOf, validate } from "../../middleware/validate.js";
import { scopeOf } from "../../middleware/workspace.js";
import type { PhonesService } from "./phones.service.js";

export function createPhonesRouter(
  service: PhonesService,
  guards: { session: RequestHandler; workspace: RequestHandler },
): Router {
  const router = Router({ mergeParams: true });
  const admin = requireRole("admin");
  router.use("/phone-numbers", guards.session, guards.workspace);

  router.get(
    "/phone-numbers/cost",
    admin,
    validate({ query: phoneVerificationSchema }),
    (req, res) => {
      const { query } = inputOf<{ query: typeof phoneVerificationSchema }>(req, res);
      res.json({ ...service.cost(query.phone), ...service.availability() });
    },
  );

  router.post(
    "/phone-numbers/codes",
    admin,
    validate({ body: phoneVerificationSchema }),
    async (req, res) => {
      const { body } = inputOf<{ body: typeof phoneVerificationSchema }>(req, res);
      res.status(201).json(await service.requestCode(scopeOf(req, res), body.phone));
    },
  );

  router.post(
    "/phone-numbers/confirm",
    admin,
    validate({ body: phoneConfirmationSchema }),
    async (req, res) => {
      const { body } = inputOf<{ body: typeof phoneConfirmationSchema }>(req, res);
      res.json(await service.confirm(scopeOf(req, res), body.phone, body.code));
    },
  );
  return router;
}
