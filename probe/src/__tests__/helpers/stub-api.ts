/*
 * In-process stand-in for the API's probe endpoints (§7.6), verifying HMAC signatures like the real
 * API will (P1-T08). It can be stopped and restarted on the same port to simulate an API restart.
 */
import http from "node:http";
import { once } from "node:events";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  PROBE_HEADERS,
  probeSigningString,
  type AssignedMonitor,
  type CheckResult,
} from "@app/shared";
import { sha256Hex } from "../../transport/signer.js";

export interface StubApi {
  url: string;
  port: number;
  results: Map<string, CheckResult>;
  duplicates: number;
  heartbeats: number;
  rejected: number;
  monitors: AssignedMonitor[];
  start(port?: number): Promise<void>;
  stop(): Promise<void>;
}

export function createStubApi(options: { probeId: string; secret: string }): StubApi {
  let server: http.Server | undefined;
  const api: StubApi = {
    url: "",
    port: 0,
    results: new Map(),
    duplicates: 0,
    heartbeats: 0,
    rejected: 0,
    monitors: [],
    async start(port = 0) {
      server = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          const path = (req.url ?? "").split("?")[0] ?? "";
          const expected = createHmac("sha256", options.secret)
            .update(
              probeSigningString({
                timestamp: String(req.headers[PROBE_HEADERS.timestamp]),
                method: req.method ?? "",
                path,
                bodySha256Hex: sha256Hex(raw),
              }),
            )
            .digest();
          const given = Buffer.from(String(req.headers[PROBE_HEADERS.signature] ?? ""), "hex");
          if (
            req.headers[PROBE_HEADERS.id] !== options.probeId ||
            given.length !== expected.length ||
            !timingSafeEqual(given, expected)
          ) {
            api.rejected += 1;
            res.writeHead(401).end("{}");
            return;
          }
          const json = (status: number, body: unknown) => {
            res.writeHead(status, { "content-type": "application/json" });
            res.end(JSON.stringify(body));
          };
          if (path.endsWith("/hello")) {
            json(200, {
              probeId: options.probeId,
              serverTime: new Date().toISOString(),
              syncIntervalMs: 15_000,
              batch: { maxResults: 100, maxWaitMs: 1_000 },
            });
          } else if (path.endsWith("/assignments")) {
            json(200, {
              cursor: api.monitors.length,
              full: true,
              upserts: api.monitors,
              deletes: [],
            });
          } else if (path.endsWith("/results")) {
            const batch = JSON.parse(raw) as { results: CheckResult[] };
            for (const r of batch.results) {
              if (api.results.has(r.id)) api.duplicates += 1;
              else api.results.set(r.id, r);
            }
            json(202, { accepted: batch.results.length, duplicates: 0 });
          } else if (path.endsWith("/tasks")) {
            setTimeout(() => json(200, { tasks: [] }), 200);
          } else if (path.endsWith("/heartbeat")) {
            api.heartbeats += 1;
            json(204, {});
          } else {
            json(404, {});
          }
        });
      });
      server.listen(port, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no address");
      api.port = address.port;
      api.url = `http://127.0.0.1:${address.port}`;
    },
    async stop() {
      if (server === undefined) return;
      server.closeAllConnections();
      await new Promise((r) => server?.close(r));
      server = undefined;
    },
  };
  return api;
}
