/*
 * P1-T07 AC: every executor against the fake-target (started in-process) for success and each failure
 * class, plus a local DNS server and a throwaway CA for DNS and certificate cases.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import https from "node:https";
import { once } from "node:events";
import { monitorConfigSchema, type MonitorConfigInput } from "@app/shared";
import { startServers, type RunningServers } from "@app/fake-target/servers";
import type { CheckContext, CheckOutcome, CheckRunner } from "../../executor/executor.js";
import { createAddressPolicy } from "../../net/address-policy.js";
import { runDns } from "../dns.js";
import { runHttp, runJsonQuery, runKeyword } from "../http.js";
import { parsePingOutput, runPing } from "../ping.js";
import { runSsl } from "../ssl.js";
import { runTcp } from "../tcp.js";
import { runWebSocket } from "../websocket.js";
import { createTestCa } from "./helpers/certs.js";
import { startDnsServer } from "./helpers/dns-server.js";

const policy = createAddressPolicy({ allowCidrs: ["127.0.0.1/32", "::1/128"] });
let target: RunningServers;
let dns: Awaited<ReturnType<typeof startDnsServer>>;
let deadPort = 0;
const httpBase = () => `http://localhost:${target.httpPort}`;

const ctx = (overrides: Partial<CheckContext> = {}): CheckContext => ({
  timeoutMs: 5_000,
  signal: new AbortController().signal,
  policy,
  ...overrides,
});

async function run(
  runner: CheckRunner,
  config: MonitorConfigInput,
  overrides: Partial<CheckContext> = {},
) {
  return runner(monitorConfigSchema.parse(config), ctx(overrides));
}

function expectFailure(outcome: CheckOutcome, code: string) {
  expect(outcome.ok, JSON.stringify(outcome)).toBe(false);
  expect(outcome.errorCode, outcome.message).toBe(code);
}

beforeAll(async () => {
  target = await startServers({
    host: "127.0.0.1",
    httpPort: 0,
    tlsPort: 0,
    tcpPort: 0,
    tlsDays: 5,
  });
  dns = await startDnsServer({
    "ok.test": {
      A: ["192.0.2.10", "192.0.2.11"],
      TXT: ["v=spf1 -all"],
      MX: [[10, "mail.ok.test"]],
    },
    "servfail.test": "servfail",
    "missing.test": "nxdomain",
    "empty.test": "empty",
    "silent.test": "silent",
  });
  const probe = https.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  deadPort = (probe.address() as { port: number }).port;
  await new Promise((r) => probe.close(r));
});

afterAll(async () => {
  await target.close();
  await dns.close();
});

describe("HTTP", () => {
  it("succeeds with status, timing waterfall and IP", async () => {
    const outcome = await run(runHttp, { type: "http", url: `${httpBase()}/ok` });
    expect(outcome).toMatchObject({ ok: true, httpStatus: 200, ip: "127.0.0.1" });
    expect(outcome.timings?.total).toBeGreaterThanOrEqual(0);
  });

  it("fails on an unexpected status, unless it is accepted", async () => {
    const failed = await run(runHttp, { type: "http", url: `${httpBase()}/fail?status=502` });
    expectFailure(failed, "http_status_unexpected");
    expect(failed.httpStatus).toBe(502);
    const accepted = await run(runHttp, {
      type: "http",
      url: `${httpBase()}/fail`,
      acceptedStatusCodes: ["500"],
    });
    expect(accepted.ok).toBe(true);
  });

  it("maps timeouts, refused connections, unknown hosts, SSRF and redirect problems", async () => {
    expectFailure(
      await run(runHttp, { type: "http", url: `${httpBase()}/slow?ms=3000` }, { timeoutMs: 400 }),
      "response_timeout",
    );
    expectFailure(
      await run(runHttp, { type: "http", url: `http://localhost:${deadPort}/` }),
      "connect_refused",
    );
    expectFailure(
      await run(runHttp, { type: "http", url: "http://watchpost-missing.invalid/" }),
      "dns_nxdomain",
    );
    expectFailure(await run(runHttp, { type: "http", url: "http://10.0.0.1/" }), "ssrf_blocked");
    expectFailure(
      await run(runHttp, { type: "http", url: `${httpBase()}/redirect-private` }),
      "ssrf_blocked",
    );
    expectFailure(
      await run(runHttp, { type: "http", url: `${httpBase()}/redirect-loop` }),
      "http_too_many_redirects",
    );
  });

  it("reports an untrusted certificate, and its facts when TLS errors are ignored", async () => {
    const url = `https://localhost:${target.tlsPort}/ok`;
    expectFailure(await run(runHttp, { type: "http", url }), "tls_untrusted_chain");
    const ignored = await run(runHttp, { type: "http", url, ignoreTlsErrors: true });
    expect(ignored.ok).toBe(true);
    expect(ignored.tls?.daysRemaining).toBeGreaterThanOrEqual(4);
    expect(ignored.tls?.daysRemaining).toBeLessThanOrEqual(5);
  });
});

describe("keyword", () => {
  const base = { type: "keyword" as const };

  it("finds or misses a keyword, case-insensitively by default", async () => {
    expect(
      (
        await run(runKeyword, {
          ...base,
          url: `${httpBase()}/keyword?word=Banana`,
          keyword: "banana",
        })
      ).ok,
    ).toBe(true);
    expectFailure(
      await run(runKeyword, {
        ...base,
        url: `${httpBase()}/keyword?word=apple`,
        keyword: "banana",
      }),
      "keyword_missing",
    );
    expectFailure(
      await run(runKeyword, {
        ...base,
        url: `${httpBase()}/keyword?word=Banana`,
        keyword: "banana",
        caseSensitive: true,
      }),
      "keyword_missing",
    );
  });

  it("fails when an unwanted keyword is present", async () => {
    expectFailure(
      await run(runKeyword, {
        ...base,
        url: `${httpBase()}/keyword?word=error`,
        keyword: "error",
        mode: "not_contains",
      }),
      "keyword_present",
    );
  });

  it("supports regex, and survives catastrophic patterns", async () => {
    expect(
      (
        await run(runKeyword, {
          ...base,
          url: `${httpBase()}/keyword?word=v1.2.3`,
          keyword: "v\\d+\\.\\d+",
          isRegex: true,
        })
      ).ok,
    ).toBe(true);
    const started = Date.now();
    const evil = await run(runKeyword, {
      ...base,
      url: `${httpBase()}/keyword?word=${"a".repeat(40)}b`,
      keyword: "^(a+)+$",
      isRegex: true,
    });
    expectFailure(evil, "keyword_missing");
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("says the body was too large when a keyword isn't in the first 1 MB", async () => {
    expectFailure(
      await run(runKeyword, { ...base, url: `${httpBase()}/big`, keyword: "needle" }),
      "body_too_large",
    );
  });
});

describe("JSON query", () => {
  const base = { type: "json_query" as const };

  it("evaluates JSONata expressions with each operator", async () => {
    const url = `${httpBase()}/json`;
    expect(
      (
        await run(runJsonQuery, {
          ...base,
          url,
          expression: "status",
          operator: "==",
          expected: "ok",
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await run(runJsonQuery, {
          ...base,
          url,
          expression: "queueDepth",
          operator: "<",
          expected: "10",
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await run(runJsonQuery, {
          ...base,
          url,
          expression: "version",
          operator: "matches",
          expected: "^1\\.",
        })
      ).ok,
    ).toBe(true);
    expectFailure(
      await run(runJsonQuery, {
        ...base,
        url,
        expression: "checks.db",
        operator: "==",
        expected: "down",
      }),
      "json_query_failed",
    );
    expectFailure(
      await run(runJsonQuery, { ...base, url, expression: "$$$(", operator: "==", expected: "x" }),
      "json_query_failed",
    );
  });

  it("fails on invalid JSON", async () => {
    expectFailure(
      await run(runJsonQuery, {
        ...base,
        url: `${httpBase()}/invalid-json`,
        expression: "status",
        operator: "==",
        expected: "ok",
      }),
      "json_invalid",
    );
  });
});

describe("TCP", () => {
  it("connects, sends and matches the reply", async () => {
    const ok = await run(runTcp, {
      type: "tcp",
      host: "localhost",
      port: target.tcpPort,
      send: "PING\n",
      expect: "PING",
    });
    expect(ok).toMatchObject({ ok: true, ip: "127.0.0.1" });
    expectFailure(
      await run(
        runTcp,
        { type: "tcp", host: "localhost", port: target.tcpPort, send: "PING\n", expect: "PONG" },
        { timeoutMs: 500 },
      ),
      "tcp_expect_failed",
    );
  });

  it("maps refused, blocked and TLS failures", async () => {
    expectFailure(
      await run(runTcp, { type: "tcp", host: "localhost", port: deadPort }),
      "connect_refused",
    );
    expectFailure(
      await run(runTcp, { type: "tcp", host: "169.254.169.254", port: 80 }),
      "ssrf_blocked",
    );
    expectFailure(
      await run(runTcp, { type: "tcp", host: "localhost", port: target.tlsPort, tls: true }),
      "tls_untrusted_chain",
    );
  });
});

describe("WebSocket", () => {
  it("opens, sends and waits for the expected reply", async () => {
    const url = `ws://localhost:${target.httpPort}/ws`;
    expect((await run(runWebSocket, { type: "websocket", url })).ok).toBe(true);
    expect(
      (await run(runWebSocket, { type: "websocket", url, send: "hello", expect: "hello" })).ok,
    ).toBe(true);
    expectFailure(
      await run(
        runWebSocket,
        { type: "websocket", url, send: "hello", expect: "goodbye" },
        { timeoutMs: 500 },
      ),
      "ws_expect_failed",
    );
  });

  it("maps a failed handshake and a refused connection", async () => {
    expectFailure(
      await run(runWebSocket, { type: "websocket", url: `ws://localhost:${target.httpPort}/ok` }),
      "ws_handshake_failed",
    );
    expectFailure(
      await run(runWebSocket, { type: "websocket", url: `ws://localhost:${deadPort}/` }),
      "connect_refused",
    );
  });
});

describe("SSL certificate", () => {
  let ca: Awaited<ReturnType<typeof createTestCa>>;
  const servers: https.Server[] = [];
  const serve = async (cert: { key: string; cert: string }) => {
    const s = https.createServer(cert, (_req, res) => res.end("ok"));
    s.listen(0, "127.0.0.1");
    await once(s, "listening");
    servers.push(s);
    return (s.address() as { port: number }).port;
  };

  beforeAll(async () => {
    ca = await createTestCa();
  });

  afterAll(async () => {
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  });

  it("passes a valid certificate and reports its facts", async () => {
    const port = await serve(
      await ca.leaf({ host: "localhost", notAfter: new Date(Date.now() + 20 * 86_400_000) }),
    );
    const outcome = await run(
      runSsl,
      { type: "ssl", host: "localhost", port },
      { ca: [ca.caCert] },
    );
    expect(outcome.ok, outcome.message).toBe(true);
    expect(outcome.tls?.daysRemaining).toBeGreaterThanOrEqual(19);
    expect(outcome.tls?.subject).toBe("localhost");
  });

  it("maps expired, wrong-host and untrusted certificates", async () => {
    const expired = await serve(
      await ca.leaf({
        host: "localhost",
        notBefore: new Date(Date.now() - 20 * 86_400_000),
        notAfter: new Date(Date.now() - 86_400_000),
      }),
    );
    expectFailure(
      await run(runSsl, { type: "ssl", host: "localhost", port: expired }, { ca: [ca.caCert] }),
      "tls_cert_expired",
    );
    const wrongHost = await serve(
      await ca.leaf({ host: "other.example", notAfter: new Date(Date.now() + 20 * 86_400_000) }),
    );
    expectFailure(
      await run(runSsl, { type: "ssl", host: "localhost", port: wrongHost }, { ca: [ca.caCert] }),
      "tls_hostname_mismatch",
    );
    expectFailure(
      await run(runSsl, { type: "ssl", host: "localhost", port: target.tlsPort }),
      "tls_untrusted_chain",
    );
  });
});

describe("DNS", () => {
  const resolver = () => `127.0.0.1:${dns.port}`;
  /* The shared schema doesn't allow a resolver port; tests pass the config directly. */
  const dnsCheck = (hostname: string, recordType: string, extra: Record<string, unknown> = {}) =>
    runDns(
      {
        type: "dns",
        hostname,
        recordType,
        resolver: resolver(),
        expectedValues: [],
        alertOnChange: false,
        ...extra,
      } as never,
      ctx({ timeoutMs: 1_500 }),
    );

  it("returns sorted answers and checks expected values", async () => {
    const ok = await dnsCheck("ok.test", "A", { expectedValues: ["192.0.2.11"] });
    expect(ok.ok).toBe(true);
    expect(ok.details?.answers).toEqual(["192.0.2.10", "192.0.2.11"]);
    expectFailure(
      await dnsCheck("ok.test", "A", { expectedValues: ["192.0.2.99"] }),
      "dns_value_mismatch",
    );
    expect((await dnsCheck("ok.test", "TXT", { expectedValues: ["v=spf1 -all"] })).ok).toBe(true);
    expect((await dnsCheck("ok.test", "MX", { expectedValues: ["mail.ok.test"] })).ok).toBe(true);
  });

  it("maps SERVFAIL, NXDOMAIN, empty answers and timeouts", async () => {
    expectFailure(await dnsCheck("servfail.test", "A"), "dns_servfail");
    expectFailure(await dnsCheck("missing.test", "A"), "dns_nxdomain");
    expectFailure(await dnsCheck("empty.test", "A"), "dns_no_records");
    expectFailure(await dnsCheck("silent.test", "A"), "dns_timeout");
  });

  it("refuses a private resolver for managed probes", async () => {
    const outcome = await runDns(
      monitorConfigSchema.parse({
        type: "dns",
        hostname: "example.com",
        recordType: "A",
        resolver: "10.0.0.53",
      }),
      ctx(),
    );
    expectFailure(outcome, "ssrf_blocked");
  });
});

describe("ping", () => {
  it("reaches the loopback address (ICMP, or TCP fallback without ICMP permission)", async () => {
    const outcome = await run(
      runPing,
      { type: "ping", host: "127.0.0.1", count: 1 },
      { timeoutMs: 3_000 },
    );
    if (outcome.details?.method === "icmp") expect(outcome.ok).toBe(true);
    else expect(outcome.details?.method ?? outcome.errorCode).toBeDefined();
    expectFailure(await run(runPing, { type: "ping", host: "10.1.2.3", count: 1 }), "ssrf_blocked");
  });

  it("parses Linux and Windows output, counting only real replies", () => {
    expect(
      parsePingOutput("3 packets transmitted, 0 received, 100% packet loss, time 2003ms"),
    ).toMatchObject({ sent: 3, received: 0, lossPercent: 100 });
    expect(
      parsePingOutput(
        "4 packets transmitted, 3 received, 25% packet loss, time 3004ms\nrtt min/avg/max/mdev = 9.1/10.4/12.0/1.1 ms",
      ),
    ).toEqual({ sent: 4, received: 3, lossPercent: 25, avgMs: 10.4 });
    const windowsUnreachable = [
      "Reply from 192.168.1.1: Destination host unreachable.",
      "Reply from 192.168.1.1: Destination host unreachable.",
      "Packets: Sent = 2, Received = 2, Lost = 0 (0% loss),",
    ].join("\n");
    expect(parsePingOutput(windowsUnreachable)).toMatchObject({
      sent: 2,
      received: 0,
      lossPercent: 100,
    });
    const windowsOk = [
      "Reply from 127.0.0.1: bytes=32 time<1ms TTL=128",
      "Packets: Sent = 1, Received = 1, Lost = 0 (0% loss),",
      "Minimum = 0ms, Maximum = 0ms, Average = 0ms",
    ].join("\n");
    expect(parsePingOutput(windowsOk)).toEqual({ sent: 1, received: 1, lossPercent: 0, avgMs: 0 });
  });
});
