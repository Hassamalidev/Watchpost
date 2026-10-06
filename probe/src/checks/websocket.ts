/*
 * WebSocket check (PRODUCT.md §6.1): handshake to a vetted address (pinned lookup, SNI kept), then
 * optionally send a message and wait for a reply containing the expected text.
 */
import { WebSocket } from "ws";
import type { MonitorConfig } from "@app/shared";
import { failure, type CheckContext, type CheckOutcome } from "../executor/executor.js";
import { CheckError, toCheckError } from "../net/errors.js";
import { USER_AGENT } from "../net/http-client.js";
import { pinnedLookup, preferredAddress, resolveVetted } from "../net/resolve.js";

export async function runWebSocket(
  config: MonitorConfig,
  ctx: CheckContext,
): Promise<CheckOutcome> {
  if (config.type !== "websocket") throw new Error("runWebSocket got a non-WebSocket config");
  const started = performance.now();
  const url = new URL(config.url);
  let vetted;
  let dnsMs = 0;
  try {
    const resolved = await resolveVetted(url.hostname, ctx.policy);
    vetted = preferredAddress(resolved.addresses);
    dnsMs = resolved.dnsMs;
  } catch (err) {
    if (err instanceof CheckError) return failure(err.code, err.message);
    throw err;
  }
  if (vetted === undefined) return failure("dns_no_records", `${url.hostname} has no addresses`);
  const address = vetted;
  const deadline = Date.now() + ctx.timeoutMs;
  const elapsed = () => Math.round(performance.now() - started);

  return new Promise<CheckOutcome>((resolve) => {
    let opened = false;
    let settled = false;
    const headers: Record<string, string> = { "user-agent": USER_AGENT };
    for (const h of config.headers) headers[h.name] = h.value;
    const ws = new WebSocket(url, config.subprotocols.length ? config.subprotocols : undefined, {
      headers,
      handshakeTimeout: ctx.timeoutMs,
      followRedirects: false,
      maxPayload: 1_048_576,
      lookup: pinnedLookup(address) as never,
      ...(url.protocol === "wss:" && !url.hostname.match(/^[\d.]+$|:/)
        ? { servername: url.hostname }
        : {}),
      ...(ctx.ca ? { ca: ctx.ca } : {}),
    });
    const finish = (outcome: CheckOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.removeAllListeners();
      ws.on("error", () => {});
      ws.terminate();
      resolve({ ...outcome, ip: address.address });
    };
    const timer = setTimeout(
      () => {
        finish(
          opened
            ? failure(
                "ws_expect_failed",
                `no reply containing "${config.expect ?? ""}" within ${ctx.timeoutMs} ms`,
                elapsed(),
              )
            : failure(
                "connect_timeout",
                `no WebSocket handshake within ${ctx.timeoutMs} ms`,
                elapsed(),
              ),
        );
      },
      Math.max(1, deadline - Date.now()),
    );

    ws.on("unexpected-response", (_req, res) => {
      finish(
        failure(
          "ws_handshake_failed",
          `server answered HTTP ${res.statusCode} instead of 101`,
          elapsed(),
        ),
      );
    });
    ws.on("error", (err) => {
      const mapped = toCheckError(err, opened ? "response" : "connect");
      const code = /Unexpected server response|Invalid Sec-WebSocket|handshake/i.test(err.message)
        ? "ws_handshake_failed"
        : mapped.code;
      finish(failure(code, err.message, elapsed()));
    });
    ws.on("open", () => {
      opened = true;
      const connectMs = elapsed();
      if (config.send === undefined && config.expect === undefined) {
        finish({
          ok: true,
          latencyMs: connectMs,
          timings: { dns: Math.round(dnsMs), total: connectMs },
        });
        return;
      }
      if (config.send !== undefined) ws.send(config.send);
      if (config.expect === undefined) {
        finish({
          ok: true,
          latencyMs: elapsed(),
          timings: { dns: Math.round(dnsMs), total: elapsed() },
        });
      }
    });
    ws.on("message", (data) => {
      const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      if (config.expect !== undefined && text.includes(config.expect)) {
        finish({
          ok: true,
          latencyMs: elapsed(),
          timings: { dns: Math.round(dnsMs), total: elapsed() },
        });
      }
    });
    ws.on("close", () => {
      if (opened)
        finish(
          failure("ws_expect_failed", "connection closed before the expected reply", elapsed()),
        );
    });
  });
}
