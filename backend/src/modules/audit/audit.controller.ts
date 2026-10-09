/* HTTP in and out only; no business logic. */
import type { RequestHandler } from "express";
import { inputOf } from "../../middleware/validate.js";
import { scopeOf } from "../../middleware/workspace.js";
import type { AuditService } from "./audit.service.js";
import type { auditExportQuery, auditListQuery } from "./validators/index.js";

export type AuditController = Record<"list" | "csv", RequestHandler>;

export function createAuditController(service: AuditService): AuditController {
  return {
    list: async (req, res) => {
      const { query } = inputOf<{ query: typeof auditListQuery }>(req, res);
      res.json(await service.list(scopeOf(req, res), query));
    },
    csv: async (req, res) => {
      const { query } = inputOf<{ query: typeof auditExportQuery }>(req, res);
      res
        .set("content-disposition", 'attachment; filename="audit-log.csv"')
        .set("cache-control", "private, no-store")
        .type("text/csv; charset=utf-8")
        .send(await service.csv(scopeOf(req, res), query.days));
    },
  };
}
