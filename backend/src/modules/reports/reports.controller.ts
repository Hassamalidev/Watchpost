/* HTTP in and out only; no business logic. */
import type { RequestHandler } from "express";
import { NotFoundError } from "../../core/errors.js";
import { inputOf } from "../../middleware/validate.js";
import { scopeOf } from "../../middleware/workspace.js";
import type { ReportFile, ReportsService, SlaQuery } from "./reports.service.js";
import type {
  scheduleBody,
  scheduleIdParams,
  sharedReportParams,
  slaQuery,
  unsubscribeQuery,
} from "./validators/index.js";

export type ReportsController = Record<
  | "sla"
  | "slaCsv"
  | "slaPdf"
  | "listSchedules"
  | "createSchedule"
  | "updateSchedule"
  | "deleteSchedule"
  | "sharedPdf"
  | "unsubscribe"
  | "unsubscribeOneClick",
  RequestHandler
>;

/* A small page for people who opened a link from an email: they have no account to send them to. */
const notice = (title: string, text: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;line-height:1.5;color:#171717;background:#fff}@media(prefers-color-scheme:dark){body{color:#f2f2f2;background:#141414}}</style></head><body><h1>${title}</h1><p>${text}</p></body></html>`;

export function createReportsController(service: ReportsService): ReportsController {
  type Req = Parameters<RequestHandler>[0];
  type Res = Parameters<RequestHandler>[1];
  const queryOf = (req: Req, res: Res): { query: SlaQuery; brand: string | undefined } => {
    const { query } = inputOf<{ query: typeof slaQuery }>(req, res);
    return {
      query: {
        target: query.id === undefined ? { kind: query.kind } : { kind: query.kind, id: query.id },
        from: new Date(query.from),
        to: new Date(query.to),
        excludeMaintenance: query.excludeMaintenance,
      },
      brand: query.brand,
    };
  };
  const scheduleOf = (req: Req, res: Res) =>
    inputOf<{ params: typeof scheduleIdParams }>(req, res).params.scheduleId;
  const sendFile = (res: Res, file: ReportFile, type: string) =>
    res
      .set("content-disposition", `attachment; filename="${file.fileName}"`)
      .set("cache-control", "private, no-store")
      .type(type)
      .send(file.body);

  return {
    sla: async (req, res) => {
      res.json(await service.sla(scopeOf(req, res), queryOf(req, res).query));
    },
    slaCsv: async (req, res) => {
      const file = await service.slaCsv(scopeOf(req, res), queryOf(req, res).query);
      sendFile(res, file, "text/csv; charset=utf-8");
    },
    slaPdf: async (req, res) => {
      const { query, brand } = queryOf(req, res);
      sendFile(res, await service.slaPdf(scopeOf(req, res), query, brand), "application/pdf");
    },
    listSchedules: async (req, res) => {
      res.json({ data: await service.listSchedules(scopeOf(req, res)) });
    },
    createSchedule: async (req, res) => {
      const { body } = inputOf<{ body: typeof scheduleBody }>(req, res);
      res.status(201).json(await service.createSchedule(scopeOf(req, res), body));
    },
    updateSchedule: async (req, res) => {
      const { body } = inputOf<{ body: typeof scheduleBody }>(req, res);
      res.json(await service.updateSchedule(scopeOf(req, res), scheduleOf(req, res), body));
    },
    deleteSchedule: async (req, res) => {
      await service.deleteSchedule(scopeOf(req, res), scheduleOf(req, res));
      res.status(204).end();
    },
    sharedPdf: async (req, res) => {
      const { params } = inputOf<{ params: typeof sharedReportParams }>(req, res);
      const file = await service.sharedPdf(params.token);
      if (file === undefined) throw new NotFoundError("This report link has expired.");
      res.set("x-robots-tag", "noindex");
      sendFile(res, file, "application/pdf");
    },
    unsubscribe: async (req, res) => {
      const { query } = inputOf<{ query: typeof unsubscribeQuery }>(req, res);
      const ok = await service.unsubscribe(query.token);
      res
        .status(ok ? 200 : 404)
        .type("html")
        .send(
          ok
            ? notice("You are unsubscribed", "This address gets no more of these reports.")
            : notice("This link has expired", "Ask the sender to take you off the report."),
        );
    },
    /* RFC 8058: mail apps post here when the reader presses their own "Unsubscribe" button. */
    unsubscribeOneClick: async (req, res) => {
      const { query } = inputOf<{ query: typeof unsubscribeQuery }>(req, res);
      await service.unsubscribe(query.token);
      res.status(200).json({ status: "unsubscribed" });
    },
  };
}
