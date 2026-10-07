/*
 * The sentinel's loop and its small HTTP server, built from parts that can be handed fakes: the
 * tests drive rounds by hand with a fake fetch and clock.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { SentinelConfig } from "./config.js";
import { createNotifier } from "./notify.js";
import { renderStatusPage, type PageEvent } from "./page.js";
import { decide, observe, owePage, type Message, type SentinelState } from "./watch.js";

const MAX_EVENTS = 20;

export interface Sentinel {
  /* One look at every target, and the messages that follow from it. */
  round(): Promise<Message[]>;
  /* Starts the loop and the page server; resolves with the port it listens on. */
  start(): Promise<number>;
  stop(): Promise<void>;
  state(): SentinelState;
  page(): string;
}

export function createSentinel(options: {
  config: SentinelConfig;
  fetch?: typeof fetch;
  now?: () => number;
  log: (level: "info" | "warn" | "error", event: Record<string, unknown>, text: string) => void;
}): Sentinel {
  const { config, log } = options;
  const send = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const notifier = createNotifier({
    config,
    fetch: send,
    log: (event, text) => log("warn", event, text),
  });
  let state: SentinelState = {};
  let checkedAt: number | null = null;
  const events: PageEvent[] = [];
  let timer: NodeJS.Timeout | undefined;
  let server: http.Server | undefined;
  let running = false;

  const page = () =>
    renderStatusPage({
      title: config.pageTitle,
      targets: config.targets.map((t) => t.name),
      state,
      events,
      checkedAt,
    });

  async function round(): Promise<Message[]> {
    const seen = await Promise.all(
      config.targets.map((target) => observe(target, { fetch: send, timeoutMs: config.timeoutMs })),
    );
    const at = now();
    const decided = decide(state, seen, at, { repeatMs: config.repeatMs });
    state = decided.state;
    checkedAt = at;
    for (const message of decided.messages) {
      log(message.level === "page" ? "error" : "warn", { target: message.target }, message.text);
      /* The public page says that something is down or back, not why. */
      if (message.level === "page" && !message.text.startsWith("STILL DOWN")) {
        events.unshift({
          at,
          text: message.text.startsWith("RECOVERED")
            ? `${message.target} recovered.`
            : `${message.target} went down.`,
        });
        events.length = Math.min(events.length, MAX_EVENTS);
      }
      const delivered = await notifier.send(message).catch(() => false);
      if (!delivered && message.level === "page") {
        log(
          "error",
          { target: message.target },
          "the page reached nobody; trying again next round",
        );
        state = owePage(state, message.target);
      }
    }
    return decided.messages;
  }

  return {
    round,
    state: () => state,
    page,
    async start() {
      server = http.createServer((req, res) => {
        const path = (req.url ?? "/").split("?")[0];
        if (req.method !== "GET" && req.method !== "HEAD") {
          res.writeHead(405).end();
        } else if (path === "/healthz") {
          res.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}');
        } else if (path === "/") {
          res
            .writeHead(200, {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "public, max-age=30",
              "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
              "x-content-type-options": "nosniff",
            })
            .end(page());
        } else {
          res.writeHead(404).end();
        }
      });
      await new Promise<void>((resolve) => server?.listen(config.port, resolve));
      const tick = async () => {
        if (running) return;
        running = true;
        try {
          await round();
        } catch (err) {
          log("error", { err: String(err) }, "a sentinel round failed");
        } finally {
          running = false;
        }
      };
      void tick();
      timer = setInterval(() => void tick(), config.intervalMs);
      return (server.address() as AddressInfo).port;
    },
    async stop() {
      if (timer !== undefined) clearInterval(timer);
      await new Promise<void>((resolve) =>
        server === undefined ? resolve() : server.close(() => resolve()),
      );
    },
  };
}
