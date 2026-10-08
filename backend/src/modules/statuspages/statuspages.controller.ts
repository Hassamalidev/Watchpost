/* HTTP in and out only; no business logic. */
import type { RequestHandler } from "express";
import { NotFoundError } from "../../core/errors.js";
import { inputOf } from "../../middleware/validate.js";
import { scopeOf } from "../../middleware/workspace.js";
import type { PublicRef, StatuspagesService } from "./statuspages.service.js";
import type {
  createIncidentBody,
  createPageBody,
  draftUpdateBody,
  incidentIdParams,
  pageIdParams,
  postUpdateBody,
  publicRefParams,
  replaceComponentsBody,
  setDomainBody,
  subscribeBody,
  subscriberIdParams,
  subscriptionTokenQuery,
  tlsAskQuery,
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
  | "draftUpdate"
  | "subscribers"
  | "removeSubscriber"
  | "subscribe"
  | "confirmSubscription"
  | "unsubscribe"
  | "unsubscribeOneClick"
  | "setDomain"
  | "verifyDomain"
  | "tlsAsk"
  | "publicPage"
  | "publicRss"
  | "publicAtom",
  RequestHandler
>;

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* A small page for people who opened a link from an email and there is no page to send them to. */
const notice = (title: string, text: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;line-height:1.5;color:#171717;background:#fff}@media(prefers-color-scheme:dark){body{color:#f2f2f2;background:#141414}}</style></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p></body></html>`;

/* A Referer header without its query and trailing slash, to compare with a page's addresses. */
function pageAddress(referer: string | undefined): string | undefined {
  if (referer === undefined) return undefined;
  try {
    const url = new URL(referer);
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

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
    draftUpdate: async (req, res) => {
      const { body } = inputOf<{ body: typeof draftUpdateBody }>(req, res);
      res.json(await service.draftUpdate(scopeOf(req, res), pageOf(req, res), body));
    },
    subscribers: async (req, res) => {
      res.json(await service.subscribers(scopeOf(req, res), pageOf(req, res)));
    },
    removeSubscriber: async (req, res) => {
      const { pageId, subscriberId } = inputOf<{ params: typeof subscriberIdParams }>(
        req,
        res,
      ).params;
      await service.removeSubscriber(scopeOf(req, res), pageId, subscriberId);
      res.status(204).end();
    },
    /*
     * The page's own form posts here without JavaScript and is sent back to the page; a JSON caller
     * gets 202. Either way the answer is the same whether or not the address was already known.
     */
    subscribe: async (req, res) => {
      const { body } = inputOf<{ body: typeof subscribeBody }>(req, res);
      const result = await service.subscribe(refOf(req, res), body.email);
      if (result === undefined) throw new NotFoundError("This page doesn't take subscribers.");
      if (req.is("application/x-www-form-urlencoded")) {
        /* Back to the address the form was on, when that is one of the page's own. */
        const from = pageAddress(req.get("referer"));
        const back = result.addresses.find((address) => address === from) ?? result.pageUrl;
        res.redirect(303, `${back}?subscribe=sent`);
        return;
      }
      res.status(202).json({ status: "confirmation_sent" });
    },
    confirmSubscription: async (req, res) => {
      const { query } = inputOf<{ query: typeof subscriptionTokenQuery }>(req, res);
      const outcome = await service.confirmSubscription(query.token);
      if (outcome.ok) {
        res.redirect(303, `${outcome.pageUrl}?subscribe=confirmed`);
        return;
      }
      res
        .status(outcome.reason === "full" ? 409 : 404)
        .type("html")
        .send(
          outcome.reason === "full"
            ? notice(
                "This page can't take more subscribers",
                "The page has reached its subscriber limit. Please try again later.",
              )
            : notice(
                "This link is no longer valid",
                "It was already used or has been replaced by a newer one. Subscribe again on the status page to get a new link.",
              ),
        );
    },
    unsubscribe: async (req, res) => {
      const { query } = inputOf<{ query: typeof subscriptionTokenQuery }>(req, res);
      const outcome = await service.unsubscribe(query.token);
      if (outcome.ok) {
        res.redirect(303, `${outcome.pageUrl}?subscribe=removed`);
        return;
      }
      /* Unsubscribing twice is not an error for the person doing it. */
      res
        .status(200)
        .type("html")
        .send(notice("You are unsubscribed", "This address gets no more status updates."));
    },
    /* RFC 8058: mail apps post here when the reader presses their own "Unsubscribe" button. */
    unsubscribeOneClick: async (req, res) => {
      const { query } = inputOf<{ query: typeof subscriptionTokenQuery }>(req, res);
      await service.unsubscribe(query.token);
      res.status(200).json({ status: "unsubscribed" });
    },
    setDomain: async (req, res) => {
      const { body } = inputOf<{ body: typeof setDomainBody }>(req, res);
      res.json(await service.setDomain(scopeOf(req, res), pageOf(req, res), body.domain));
    },
    verifyDomain: async (req, res) => {
      res.json(await service.verifyDomain(scopeOf(req, res), pageOf(req, res)));
    },
    /* 200 lets Caddy get a certificate for the host; anything else refuses it (§16). */
    tlsAsk: async (req, res) => {
      const { query } = inputOf<{ query: typeof tlsAskQuery }>(req, res);
      if (!(await service.servesHost(query.domain))) {
        throw new NotFoundError("Not a verified status page domain.");
      }
      res.status(200).json({ ok: true });
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
