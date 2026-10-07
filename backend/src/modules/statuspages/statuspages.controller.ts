/* HTTP in and out only; no business logic. */
import type { RequestHandler } from "express";
import { NotFoundError } from "../../core/errors.js";
import { inputOf } from "../../middleware/validate.js";
import { scopeOf } from "../../middleware/workspace.js";
import type { PublicRef, StatuspagesService } from "./statuspages.service.js";
import type {
  createIncidentBody,
  createPageBody,
  incidentIdParams,
  pageIdParams,
  postUpdateBody,
  publicRefParams,
  replaceComponentsBody,
  updateIncidentBody,
  updatePageBody,
} from "./validators/index.js";

export type StatuspagesController = Record<
  | "list"
  | "get"
  | "create"
  | "update"
  | "remove"
  | "replaceComponents"
  | "preview"
  | "listIncidents"
  | "createIncident"
  | "updateIncident"
  | "postUpdate"
  | "removeIncident"
  | "publicPage"
  | "publicRss"
  | "publicAtom",
  RequestHandler
>;

/* Shared caches may keep a public answer for a few seconds; a change is visible well within 10 s. */
const PUBLIC_CACHE = "public, max-age=5";

export function createStatuspagesController(service: StatuspagesService): StatuspagesController {
  type Req = Parameters<RequestHandler>[0];
  type Res = Parameters<RequestHandler>[1];
  const pageOf = (req: Req, res: Res) =>
    inputOf<{ params: typeof pageIdParams }>(req, res).params.pageId;
  const incidentOf = (req: Req, res: Res) =>
    inputOf<{ params: typeof incidentIdParams }>(req, res).params;
  /* A dot means the host name of a custom domain; a subdomain never has one. */
  const refOf = (req: Req, res: Res): PublicRef => {
    const { ref } = inputOf<{ params: typeof publicRefParams }>(req, res).params;
    return ref.includes(".") ? { host: ref } : { slug: ref };
  };

  const feed =
    (format: "rss" | "atom"): RequestHandler =>
    async (req, res) => {
      const xml = await service.publicFeed(refOf(req, res), format);
      if (xml === undefined) throw new NotFoundError("Status page not found.");
      res
        .set("cache-control", PUBLIC_CACHE)
        .type(format === "rss" ? "application/rss+xml" : "application/atom+xml")
        .send(xml);
    };

  return {
    list: async (req, res) => {
      res.json({ data: await service.list(scopeOf(req, res)) });
    },
    get: async (req, res) => {
      res.json(await service.get(scopeOf(req, res), pageOf(req, res)));
    },
    create: async (req, res) => {
      const { body } = inputOf<{ body: typeof createPageBody }>(req, res);
      res.status(201).json(await service.create(scopeOf(req, res), body));
    },
    update: async (req, res) => {
      const { body } = inputOf<{ body: typeof updatePageBody }>(req, res);
      res.json(await service.update(scopeOf(req, res), pageOf(req, res), body));
    },
    remove: async (req, res) => {
      await service.delete(scopeOf(req, res), pageOf(req, res));
      res.status(204).end();
    },
    replaceComponents: async (req, res) => {
      const { body } = inputOf<{ body: typeof replaceComponentsBody }>(req, res);
      res.json(
        await service.replaceComponents(scopeOf(req, res), pageOf(req, res), body.components),
      );
    },
    preview: async (req, res) => {
      res.json(await service.preview(scopeOf(req, res), pageOf(req, res)));
    },
    listIncidents: async (req, res) => {
      res.json({ data: await service.listIncidents(scopeOf(req, res), pageOf(req, res)) });
    },
    createIncident: async (req, res) => {
      const { body } = inputOf<{ body: typeof createIncidentBody }>(req, res);
      res.status(201).json(await service.createIncident(scopeOf(req, res), pageOf(req, res), body));
    },
    updateIncident: async (req, res) => {
      const { body } = inputOf<{ body: typeof updateIncidentBody }>(req, res);
      const { pageId, incidentId } = incidentOf(req, res);
      res.json(await service.updateIncident(scopeOf(req, res), pageId, incidentId, body));
    },
    postUpdate: async (req, res) => {
      const { body } = inputOf<{ body: typeof postUpdateBody }>(req, res);
      const { pageId, incidentId } = incidentOf(req, res);
      res.status(201).json(await service.postUpdate(scopeOf(req, res), pageId, incidentId, body));
    },
    removeIncident: async (req, res) => {
      const { pageId, incidentId } = incidentOf(req, res);
      await service.deleteIncident(scopeOf(req, res), pageId, incidentId);
      res.status(204).end();
    },
    publicPage: async (req, res) => {
      const page = await service.publicPage(refOf(req, res));
      if (page === undefined) throw new NotFoundError("Status page not found.");
      res.set("cache-control", PUBLIC_CACHE).json(page);
    },
    publicRss: feed("rss"),
    publicAtom: feed("atom"),
  };
}
