/* HTTP in and out only; no business logic. */
import type { RequestHandler } from "express";
import { NotFoundError } from "../../core/errors.js";
import { markdownToBlocks, renderPdf } from "../../infra/pdf.js";
import { inputOf } from "../../middleware/validate.js";
import { scopeOf } from "../../middleware/workspace.js";
import type { IncidentsService } from "./incidents.service.js";
import type {
  commentBody,
  createIncidentBody,
  falseAlarmBody,
  incidentRefParams,
  listIncidentsQuery,
  postmortemBody,
  summaryQuery,
  tuningParams,
} from "./validators/index.js";

type Handlers =
  | "list"
  | "get"
  | "evidence"
  | "create"
  | "acknowledge"
  | "resolve"
  | "comment"
  | "postmortem"
  | "savePostmortem"
  | "postmortemMarkdown"
  | "postmortemPdf"
  | "falseAlarm"
  | "summary"
  | "drill"
  | "noisiest"
  | "tuning";

export type IncidentsController = Record<Handlers, RequestHandler>;

export function createIncidentsController(service: IncidentsService): IncidentsController {
  const refOf = (req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1]) =>
    inputOf<{ params: typeof incidentRefParams }>(req, res).params.incidentRef;

  return {
    list: async (req, res) => {
      const { query } = inputOf<{ query: typeof listIncidentsQuery }>(req, res);
      res.json(await service.list(scopeOf(req, res), query));
    },
    get: async (req, res) => {
      res.json(await service.get(scopeOf(req, res), refOf(req, res)));
    },
    evidence: async (req, res) => {
      res.json({ data: await service.evidence(scopeOf(req, res), refOf(req, res)) });
    },
    create: async (req, res) => {
      const { body } = inputOf<{ body: typeof createIncidentBody }>(req, res);
      res.status(201).json(await service.create(scopeOf(req, res), body));
    },
    acknowledge: async (req, res) => {
      res.json(await service.acknowledge(scopeOf(req, res), refOf(req, res)));
    },
    resolve: async (req, res) => {
      res.json(await service.resolve(scopeOf(req, res), refOf(req, res)));
    },
    postmortem: async (req, res) => {
      res.json({ data: await service.postmortem(scopeOf(req, res), refOf(req, res)) });
    },
    savePostmortem: async (req, res) => {
      const { body } = inputOf<{ body: typeof postmortemBody }>(req, res);
      res.json(await service.savePostmortem(scopeOf(req, res), refOf(req, res), body));
    },
    /* The review as a file: Markdown as it is stored, or the same text laid out as a PDF. */
    postmortemMarkdown: async (req, res) => {
      const stored = await service.postmortem(scopeOf(req, res), refOf(req, res));
      if (stored === null) throw new NotFoundError("This incident has no postmortem yet.");
      res
        .set("content-disposition", `attachment; filename="postmortem-${refOf(req, res)}.md"`)
        .type("text/markdown; charset=utf-8")
        .send(stored.markdown);
    },
    postmortemPdf: async (req, res) => {
      const stored = await service.postmortem(scopeOf(req, res), refOf(req, res));
      if (stored === null) throw new NotFoundError("This incident has no postmortem yet.");
      const pdf = await renderPdf({
        title: `Postmortem ${refOf(req, res)}`,
        footer: "Postmortem",
        blocks: markdownToBlocks(stored.markdown),
      });
      res
        .set("content-disposition", `attachment; filename="postmortem-${refOf(req, res)}.pdf"`)
        .type("application/pdf")
        .send(pdf);
    },
    comment: async (req, res) => {
      const { body } = inputOf<{ body: typeof commentBody }>(req, res);
      res.status(201).json(await service.comment(scopeOf(req, res), refOf(req, res), body.body));
    },
    summary: async (req, res) => {
      const { query } = inputOf<{ query: typeof summaryQuery }>(req, res);
      res.json(await service.summary(scopeOf(req, res), query.days));
    },
    drill: async (req, res) => {
      res.status(201).json(await service.startDrill(scopeOf(req, res)));
    },
    noisiest: async (req, res) => {
      res.json({ data: await service.noisiest(scopeOf(req, res), 10) });
    },
    tuning: async (req, res) => {
      const { params } = inputOf<{ params: typeof tuningParams }>(req, res);
      res.json(await service.tuning(scopeOf(req, res), params.monitorId));
    },
    falseAlarm: async (req, res) => {
      const { body } = inputOf<{ body: typeof falseAlarmBody }>(req, res);
      res.json(await service.setFalseAlarm(scopeOf(req, res), refOf(req, res), body.falseAlarm));
    },
  };
}
