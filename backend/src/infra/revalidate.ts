/*
 * Tells the web app that cached pages changed (PRODUCT.md §7.10): POST <web>/api/revalidate with the
 * shared secret and the cache tags to drop. The web app is ours and sits on the private network, so
 * this is a plain fetch, not the SSRF-guarded client used for customers' URLs. It never throws: a
 * page that misses one refresh still refreshes on its own timer.
 */
import type { Logger } from "./logger.js";

export type Revalidate = (tags: string[]) => Promise<void>;

const TIMEOUT_MS = 3_000;

export function createRevalidator(options: {
  target: { url: string; secret: string } | undefined;
  logger: Logger;
  fetch?: typeof fetch;
}): Revalidate {
  const send = options.fetch ?? fetch;
  return async (tags) => {
    if (options.target === undefined || tags.length === 0) return;
    try {
      const res = await send(options.target.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-revalidate-secret": options.target.secret,
        },
        body: JSON.stringify({ tags }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        options.logger.warn({ status: res.status, tags }, "the web app refused a cache refresh");
      }
    } catch (err) {
      options.logger.warn({ err, tags }, "telling the web app about a change failed");
    }
  };
}
