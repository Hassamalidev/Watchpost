/*
 * HTTP routes of the outage simulator (PRODUCT.md §15).
 * Everything is deterministic given the clock, so tests can drive it.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";

export const MAX_SLOW_MS = 60_000;
export const BIG_BODY_BYTES = 2 * 1024 * 1024;
export const GZIP_BOMB_BYTES = 10 * 1024 * 1024;
export const PRIVATE_REDIRECT_TARGET = "http://169.254.169.254/latest/meta-data/";

export type SwitchState = "ok" | "fail" | "slow";

export interface HandlerState {
  /* Global switch used by E2E tests to simulate an outage on /switch. */
  switchState: SwitchState;
}

export interface HandlerDeps {
  state: HandlerState;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps = (): HandlerDeps => ({
  state: { switchState: "ok" },
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

let gzipBombCache: Buffer | undefined;

function send(
  res: ServerResponse,
  status: number,
  body: string | Buffer,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...headers });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, JSON.stringify(body), { "content-type": "application/json" });
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const value = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function isSwitchState(value: string | null): value is SwitchState {
  return value === "ok" || value === "fail" || value === "slow";
}

export function createHttpHandler(overrides: Partial<HandlerDeps> = {}) {
  const deps = { ...defaultDeps(), ...overrides };

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://fake-target.local");
    const q = url.searchParams;

    switch (url.pathname) {
      case "/":
      case "/ok":
        return send(res, 200, "OK");

      case "/fail":
        return send(res, clampInt(q.get("status"), 500, 400, 599), "Simulated failure");

      case "/status":
        return send(res, clampInt(q.get("code"), 200, 100, 599), "Status");

      case "/slow": {
        const ms = clampInt(q.get("ms"), 5000, 0, MAX_SLOW_MS);
        await deps.sleep(ms);
        return send(res, 200, `Slow response after ${ms} ms`);
      }

      case "/flap": {
        /* Alternates between up and down every `period` seconds. */
        const periodS = clampInt(q.get("period"), 60, 1, 86_400);
        const up = Math.floor(deps.now() / 1000 / periodS) % 2 === 0;
        return up ? send(res, 200, "Flap: up") : send(res, 503, "Flap: down");
      }

      case "/keyword": {
        const word = q.get("word") ?? "watchpost";
        return send(res, 200, `<html><body><h1>Hello</h1><p>${word}</p></body></html>`, {
          "content-type": "text/html; charset=utf-8",
        });
      }

      case "/json":
        return sendJson(res, 200, {
          status: "ok",
          version: "1.2.3",
          checks: { db: "ok", cache: "ok" },
          queueDepth: 3,
        });

      case "/invalid-json":
        return send(res, 200, "{not json", { "content-type": "application/json" });

      case "/big":
        return send(res, 200, Buffer.alloc(BIG_BODY_BYTES, "a"));

      case "/gzip-bomb":
        gzipBombCache ??= gzipSync(Buffer.alloc(GZIP_BOMB_BYTES, 0));
        return send(res, 200, gzipBombCache, { "content-encoding": "gzip" });

      case "/redirect":
        return send(res, 302, "", { location: q.get("to") ?? "/ok" });

      case "/redirect-loop":
        return send(res, 302, "", { location: "/redirect-loop" });

      case "/redirect-private":
        return send(res, 302, "", { location: PRIVATE_REDIRECT_TARGET });

      case "/switch": {
        const s = deps.state.switchState;
        if (s === "fail") return send(res, 500, "Switch: fail");
        if (s === "slow") await deps.sleep(clampInt(q.get("ms"), 10_000, 0, MAX_SLOW_MS));
        return send(res, 200, `Switch: ${s}`);
      }

      case "/control/switch": {
        const next = q.get("state");
        if (req.method !== "POST") return send(res, 405, "Use POST", { allow: "POST" });
        if (!isSwitchState(next)) return send(res, 400, "state must be ok, fail or slow");
        deps.state.switchState = next;
        return sendJson(res, 200, { switchState: next });
      }

      case "/healthz":
        return sendJson(res, 200, { ok: true, switchState: deps.state.switchState });

      default:
        return send(res, 404, "Not found");
    }
  };
}
