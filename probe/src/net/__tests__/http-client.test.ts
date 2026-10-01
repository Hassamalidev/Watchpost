/*
 * P1-T06 AC with real sockets: pinned connections (no re-resolution → no rebinding), re-validated
 * redirects (private targets blocked), downgrade blocking, TLS errors, and body/decompression caps.
 * Local servers are allowed only through an explicit allowCidrs entry for 127.0.0.1.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import https from "node:https";
import { once } from "node:events";
import zlib from "node:zlib";
import selfsigned from "selfsigned";
import { createAddressPolicy } from "../address-policy.js";
import { CheckError } from "../errors.js";
import { httpRequest, MAX_BODY_BYTES, type HttpRequestOptions } from "../http-client.js";
import type { Resolver } from "../resolve.js";

const policy = createAddressPolicy({ allowCidrs: ["127.0.0.1/32"] });
let server: http.Server;
let tlsServer: https.Server;
let port = 0;
let tlsPort = 0;
const seenHosts: string[] = [];

const GZIP_BOMB = zlib.gzipSync(Buffer.alloc(10 * 1024 * 1024, 0));

function handler(req: http.IncomingMessage, res: http.ServerResponse) {
  seenHosts.push(String(req.headers.host));
  const url = new URL(req.url ?? "/", "http://x");
  switch (url.pathname) {
    case "/ok":
      res.end("hello");
      return;
    case "/big":
      res.end(Buffer.alloc(2 * 1024 * 1024, "a"));
      return;
    case "/gzip-bomb":
      res.writeHead(200, { "content-encoding": "gzip" });
      res.end(GZIP_BOMB);
      return;
    case "/slow":
      setTimeout(() => res.end("late"), 2_000);
      return;
    case "/redirect":
      res.writeHead(302, { location: url.searchParams.get("to") ?? "/ok" });
      res.end();
      return;
    case "/loop":
      res.writeHead(302, { location: "/loop" });
      res.end();
      return;
    case "/see-other":
      res.writeHead(303, { location: "/method" });
      res.end();
      return;
    case "/method":
      res.end(req.method);
      return;
    case "/secrets":
      res.end(`${req.headers.authorization ?? "-"} ${req.headers["x-api-key"] ?? "-"}`);
      return;
    case "/many-headers": {
      for (let i = 0; i < 150; i += 1) res.setHeader(`x-h-${i}`, String(i));
      res.end("ok");
      return;
    }
    default:
      res.writeHead(404);
      res.end();
  }
}

beforeAll(async () => {
  server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = (server.address() as { port: number }).port;

  const pems = await selfsigned.generate([{ name: "commonName", value: "target.test" }], {
    keyType: "ec",
    algorithm: "sha256",
    notAfterDate: new Date(Date.now() + 10 * 86_400_000),
  });
  tlsServer = https.createServer({ key: pems.private, cert: pems.cert }, handler);
  tlsServer.listen(0, "127.0.0.1");
  await once(tlsServer, "listening");
  tlsPort = (tlsServer.address() as { port: number }).port;
});

afterAll(async () => {
  server.closeAllConnections();
  tlsServer.closeAllConnections();
  await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => tlsServer.close(r))]);
});

/* target.test → 127.0.0.1; counts lookups so we can prove pinning. */
function countingResolver(answers: string[][]): { resolver: Resolver; calls: () => number } {
  let calls = 0;
  return {
    resolver: async () => {
      const answer = answers[Math.min(calls, answers.length - 1)] ?? [];
      calls += 1;
      return answer.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }) as const);
    },
    calls: () => calls,
  };
}

const request = (overrides: Partial<HttpRequestOptions> & { url: string }) =>
  httpRequest({
    timeoutMs: 5_000,
    policy,
    resolver: countingResolver([["127.0.0.1"]]).resolver,
    ...overrides,
  });

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "no error";
  } catch (err) {
    return err instanceof CheckError ? err.code : `unexpected: ${(err as Error).message}`;
  }
}

describe("pinned connections", () => {
  it("connects to the vetted IP with the original Host header and resolves once per hop", async () => {
    const dns = countingResolver([["127.0.0.1"], ["10.0.0.1"]]);
    const res = await request({ url: `http://target.test:${port}/ok`, resolver: dns.resolver });
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe("hello");
    expect(res.ip).toBe("127.0.0.1");
    expect(seenHosts.at(-1)).toBe(`target.test:${port}`);
    expect(dns.calls()).toBe(1);
    expect(res.timings.total).toBeGreaterThanOrEqual(0);
  });

  it("refuses a name whose answers include any blocked address", async () => {
    const dns = countingResolver([["127.0.0.1", "10.0.0.5"]]);
    expect(
      await codeOf(request({ url: `http://target.test:${port}/ok`, resolver: dns.resolver })),
    ).toBe("ssrf_blocked");
  });

  it("sends the user's headers only to the configured origin, never to a redirect elsewhere", async () => {
    const headers = [
      { name: "Authorization", value: "Bearer s3cret" },
      { name: "X-Api-Key", value: "k3y" },
    ];
    const same = await request({
      url: `http://target.test:${port}/redirect?to=/secrets`,
      headers,
    });
    expect(same.body.toString()).toBe("Bearer s3cret k3y");
    const elsewhere = await request({
      url: `http://target.test:${port}/redirect?to=http://other.test:${port}/secrets`,
      headers,
    });
    expect(elsewhere.body.toString()).toBe("- -");
  });

  it("re-validates every redirect hop, so a rebinding second answer is blocked", async () => {
    const dns = countingResolver([["127.0.0.1"], ["10.0.0.1"]]);
    const code = await codeOf(
      request({
        url: `http://target.test:${port}/redirect?to=http://target.test:${port}/ok`,
        resolver: dns.resolver,
      }),
    );
    expect(code).toBe("ssrf_blocked");
    expect(dns.calls()).toBe(2);
  });
});

describe("redirects", () => {
  it("blocks a redirect to a private or metadata IP", async () => {
    for (const to of [
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.1/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.2]/",
    ]) {
      const code = await codeOf(
        request({ url: `http://target.test:${port}/redirect?to=${encodeURIComponent(to)}` }),
      );
      expect(code, to).toBe("ssrf_blocked");
    }
  });

  it("stops after 5 redirects", async () => {
    expect(await codeOf(request({ url: `http://target.test:${port}/loop` }))).toBe(
      "http_too_many_redirects",
    );
  });

  it("switches 303 to GET and can be told not to follow", async () => {
    const res = await request({
      url: `http://target.test:${port}/see-other`,
      method: "POST",
      body: "x",
    });
    expect(res.body.toString()).toBe("GET");
    expect(res.redirects).toHaveLength(1);
    const noFollow = await request({
      url: `http://target.test:${port}/see-other`,
      followRedirects: false,
    });
    expect(noFollow.status).toBe(303);
  });

  it("blocks https → http downgrades unless allowed", async () => {
    const to = encodeURIComponent(`http://target.test:${port}/ok`);
    const url = `https://target.test:${tlsPort}/redirect?to=${to}`;
    expect(await codeOf(request({ url, ignoreTlsErrors: true }))).toBe("http_redirect_blocked");
    const allowed = await request({ url, ignoreTlsErrors: true, allowDowngrade: true });
    expect(allowed.status).toBe(200);
  });

  it("refuses non-http redirect targets", async () => {
    const code = await codeOf(
      request({
        url: `http://target.test:${port}/redirect?to=${encodeURIComponent("file:///etc/passwd")}`,
      }),
    );
    expect(code).toBe("http_redirect_blocked");
  });
});

describe("TLS", () => {
  it("reports an untrusted chain, and captures certificate facts when errors are ignored", async () => {
    expect(await codeOf(request({ url: `https://target.test:${tlsPort}/ok` }))).toBe(
      "tls_untrusted_chain",
    );
    const res = await request({ url: `https://target.test:${tlsPort}/ok`, ignoreTlsErrors: true });
    expect(res.tls?.subject).toBe("target.test");
    expect(res.tls?.daysRemaining).toBeGreaterThanOrEqual(9);
    expect(res.tls?.daysRemaining).toBeLessThanOrEqual(10);
    expect(res.timings.tls).toBeGreaterThanOrEqual(0);
  });
});

describe("limits", () => {
  it("reads at most 1 MB of body", async () => {
    const res = await request({ url: `http://target.test:${port}/big` });
    expect(res.body.length).toBe(MAX_BODY_BYTES);
    expect(res.truncated).toBe(true);
  });

  it("stops decompressing a gzip bomb at the cap", async () => {
    const started = Date.now();
    const res = await request({ url: `http://target.test:${port}/gzip-bomb` });
    expect(res.body.length).toBe(MAX_BODY_BYTES);
    expect(res.truncated).toBe(true);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("times out slow responses and caps headers", async () => {
    expect(await codeOf(request({ url: `http://target.test:${port}/slow`, timeoutMs: 300 }))).toBe(
      "response_timeout",
    );
    const res = await request({ url: `http://target.test:${port}/many-headers` });
    expect(Object.keys(res.headers).length).toBeLessThanOrEqual(100);
  });

  it("maps a refused connection", async () => {
    const closed = http.createServer();
    closed.listen(0, "127.0.0.1");
    await once(closed, "listening");
    const deadPort = (closed.address() as { port: number }).port;
    await new Promise((r) => closed.close(r));
    expect(await codeOf(request({ url: `http://target.test:${deadPort}/ok` }))).toBe(
      "connect_refused",
    );
  });
});
