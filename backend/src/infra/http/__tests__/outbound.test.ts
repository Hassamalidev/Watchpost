/*
 * The outbound client refuses private and mixed DNS answers, pins the connection to the vetted
 * address, never follows redirects, and caps time and body size.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createAddressPolicy } from "@app/shared";
import { OutboundError, createOutboundHttp } from "../outbound.js";

let server: http.Server;
let port: number;
const seen: Array<{ host: string | undefined; body: string }> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      seen.push({ host: req.headers.host, body });
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" }).end();
      } else if (req.url === "/slow") {
        setTimeout(() => res.end("late"), 2_000);
      } else if (req.url === "/big") {
        res.end("x".repeat(200_000));
      } else {
        res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const strict = createOutboundHttp({ policy: createAddressPolicy() });
const local = (resolve?: (host: string) => Promise<string[]>) =>
  createOutboundHttp({
    policy: createAddressPolicy({ allowCidrs: ["127.0.0.1/32"] }),
    ...(resolve ? { resolve } : {}),
  });

const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return "ok";
  } catch (err) {
    return err instanceof OutboundError ? err.code : "other";
  }
};

describe("outbound HTTP", () => {
  it("refuses private, loopback and metadata addresses by default", async () => {
    expect(await code(strict.request({ method: "POST", url: `http://127.0.0.1:${port}/` }))).toBe(
      "blocked",
    );
    expect(
      await code(strict.request({ method: "GET", url: "http://169.254.169.254/latest/meta-data" })),
    ).toBe("blocked");
    expect(await code(strict.request({ method: "GET", url: "http://[::1]:80/" }))).toBe("blocked");
    expect(await code(strict.request({ method: "GET", url: "http://[::ffff:10.0.0.1]/" }))).toBe(
      "blocked",
    );
  });

  it("refuses a hostname if any of its addresses is private", async () => {
    const mixed = createOutboundHttp({
      policy: createAddressPolicy(),
      resolve: async () => ["93.184.216.34", "10.0.0.5"],
    });
    expect(await code(mixed.request({ method: "GET", url: "https://hooks.example.com/" }))).toBe(
      "blocked",
    );
  });

  it("refuses bad URLs and non-HTTP schemes", async () => {
    expect(await code(strict.request({ method: "GET", url: "not a url" }))).toBe("invalid_url");
    expect(await code(strict.request({ method: "GET", url: "ftp://example.com/x" }))).toBe(
      "invalid_url",
    );
    expect(await code(strict.request({ method: "GET", url: "file:///etc/passwd" }))).toBe(
      "invalid_url",
    );
  });

  it("connects to the vetted address while keeping the hostname", async () => {
    const client = local(async () => ["127.0.0.1"]);
    const res = await client.request({
      method: "POST",
      url: `http://hooks.example.com:${port}/hook`,
      headers: { "content-type": "application/json" },
      body: '{"hello":"world"}',
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(seen.at(-1)).toEqual({ host: `hooks.example.com:${port}`, body: '{"hello":"world"}' });
  });

  it("returns redirects instead of following them", async () => {
    const res = await local().request({ method: "GET", url: `http://127.0.0.1:${port}/redirect` });
    expect(res.status).toBe(302);
  });

  it("times out slow receivers and caps large bodies", async () => {
    expect(
      await code(
        local().request({ method: "GET", url: `http://127.0.0.1:${port}/slow`, timeoutMs: 300 }),
      ),
    ).toBe("timeout");
    const big = await local().request({ method: "GET", url: `http://127.0.0.1:${port}/big` });
    expect(big.body.length).toBe(64 * 1024);
  });

  it("returns a whole body up to the caller's limit, and fails rather than cut it", async () => {
    const url = `http://127.0.0.1:${port}/big`;
    const whole = await local().request({ method: "GET", url, maxBodyBytes: 1024 * 1024 });
    expect(whole.body.length).toBe(200_000);
    expect(await code(local().request({ method: "GET", url, maxBodyBytes: 100_000 }))).toBe(
      "too_large",
    );
  });
});
