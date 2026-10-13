/*
 * The page behind a link in an email that changes something (unsubscribe, confirm a subscription).
 * Opening the link only shows this page; its one button posts. Mail scanners (Defender Safe Links,
 * Proofpoint) fetch every link in a message, and a link that acted on GET let them unsubscribe
 * people, or confirm addresses nobody confirmed, without anyone knowing.
 */
import type { Request, Response } from "express";

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* What the page's own form sends, so a POST from it can be told from a mail app's one-click POST. */
export const FROM_LINK_PAGE = "page";

export function isFromLinkPage(req: Request): boolean {
  const body: unknown = req.body;
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { from?: unknown }).from === FROM_LINK_PAGE
  );
}

/* Posts back to the address the link has (path and token), which is always our own. */
export function linkPage(
  req: Request,
  copy: { title: string; text: string; button: string },
): string {
  const action = escapeHtml(req.originalUrl);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(copy.title)}</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;line-height:1.5;color:#171717;background:#fff}button{font:inherit;padding:.6rem 1.1rem;border-radius:.4rem;border:1px solid #171717;background:#171717;color:#fff;cursor:pointer}@media(prefers-color-scheme:dark){body{color:#f2f2f2;background:#141414}button{border-color:#f2f2f2;background:#f2f2f2;color:#141414}}</style></head><body><h1>${escapeHtml(copy.title)}</h1><p>${escapeHtml(copy.text)}</p><form method="post" action="${action}"><input type="hidden" name="from" value="${FROM_LINK_PAGE}"><button type="submit">${escapeHtml(copy.button)}</button></form></body></html>`;
}

/*
 * Sends the page. The API's usual policy allows forms to post to this host only, and browsers apply
 * that to the redirect that answers the post as well: the button would be refused the moment we
 * sent the reader on to a status page on its own domain. This page holds nothing but that one form.
 */
export function sendLinkPage(
  req: Request,
  res: Response,
  copy: { title: string; text: string; button: string },
): void {
  res
    .status(200)
    .set("cache-control", "no-store")
    .set(
      "content-security-policy",
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http:; base-uri 'none'; frame-ancestors 'none'",
    )
    .type("html")
    .send(linkPage(req, copy));
}
