/*
 * P6-T08a: the Redis, MQTT and gRPC checks against small servers started in-process that speak
 * just enough of each protocol to answer well, refuse a login, or answer nonsense.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http2 from "node:http2";
import net from "node:net";
import { once } from "node:events";
import { monitorConfigSchema, type MonitorConfigInput } from "@app/shared";
import type { CheckContext, CheckOutcome, CheckRunner } from "../../executor/executor.js";
import { createAddressPolicy } from "../../net/address-policy.js";
import { grpcHealthRequest, mqttConnectPacket, runGrpc, runMqtt, runRedis } from "../protocols.js";

const policy = createAddressPolicy({ allowCidrs: ["127.0.0.1/32", "::1/128"] });
const ctx = (overrides: Partial<CheckContext> = {}): CheckContext => ({
  timeoutMs: 3_000,
  signal: new AbortController().signal,
  policy,
  ...overrides,
});
const run = (
  runner: CheckRunner,
  config: MonitorConfigInput,
  overrides: Partial<CheckContext> = {},
) => runner(monitorConfigSchema.parse(config), ctx(overrides));
function expectFailure(outcome: CheckOutcome, code: string) {
  expect(outcome.ok, JSON.stringify(outcome)).toBe(false);
  expect(outcome.errorCode, outcome.message).toBe(code);
}

const closers: Array<() => Promise<unknown>> = [];
async function tcpServer(onConnection: (socket: net.Socket) => void): Promise<number> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    onConnection(socket);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  /* Closing waits for open connections, so they are dropped first. */
  closers.push(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise((resolve) => server.close(resolve));
  });
  return (server.address() as net.AddressInfo).port;
}

/* A Redis that wants "s3cret" when `password` is set; commands arrive as RESP arrays. */
function fakeRedis(options: { password?: string } = {}) {
  return tcpServer((socket) => {
    let authed = options.password === undefined;
    socket.on("data", (chunk) => {
      const parts = chunk
        .toString("utf8")
        .split("\r\n")
        .filter((line) => line !== "" && !line.startsWith("*") && !line.startsWith("$"));
      const [command, ...args] = parts;
      if (command === "AUTH") {
        authed = args.at(-1) === options.password;
        socket.write(authed ? "+OK\r\n" : "-WRONGPASS invalid username-password pair\r\n");
      } else if (command === "PING") {
        socket.write(authed ? "+PONG\r\n" : "-NOAUTH Authentication required.\r\n");
      } else {
        socket.write("-ERR unknown command\r\n");
      }
    });
    socket.on("error", () => {});
  });
}

/* An MQTT broker that answers a CONNECT with the given return code, and remembers what it got. */
function fakeMqtt(returnCode: (packet: Buffer) => number, seen: Buffer[] = []) {
  return tcpServer((socket) => {
    socket.once("data", (packet) => {
      seen.push(packet);
      socket.write(Buffer.from([0x20, 0x02, 0x00, returnCode(packet)]));
    });
    socket.on("error", () => {});
  });
}

/* A gRPC server (HTTP/2 without TLS) whose health service answers as told. */
async function fakeGrpc(
  answer: (service: string) => { grpcStatus: number; serving?: number },
): Promise<number> {
  const server = http2.createServer();
  const sessions = new Set<http2.ServerHttp2Session>();
  server.on("session", (session) => {
    sessions.add(session);
    session.once("close", () => sessions.delete(session));
  });
  server.on("stream", (stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => {
      const body = Buffer.concat(chunks).subarray(5);
      const service = body.length === 0 ? "" : body.subarray(2).toString("utf8");
      const known = headers[":path"] === "/grpc.health.v1.Health/Check";
      const { grpcStatus, serving } = known ? answer(service) : { grpcStatus: 12 };
      if (grpcStatus !== 0) {
        /* An error is sent as headers only. */
        stream.respond(
          { ":status": 200, "content-type": "application/grpc", "grpc-status": String(grpcStatus) },
          { endStream: true },
        );
        return;
      }
      stream.respond(
        { ":status": 200, "content-type": "application/grpc" },
        { waitForTrailers: true },
      );
      stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
      const message =
        serving === undefined || serving === 0 ? Buffer.alloc(0) : Buffer.from([0x08, serving]);
      const prefix = Buffer.alloc(5);
      prefix.writeUInt32BE(message.length, 1);
      stream.end(Buffer.concat([prefix, message]));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  closers.push(() => {
    for (const session of sessions) session.destroy();
    return new Promise((resolve) => server.close(resolve));
  });
  return (server.address() as net.AddressInfo).port;
}

let deadPort = 0;
beforeAll(async () => {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  deadPort = (probe.address() as net.AddressInfo).port;
  await new Promise((resolve) => probe.close(resolve));
});
afterAll(async () => {
  await Promise.all(closers.map((close) => close()));
});

describe("Redis", () => {
  it("is up when it answers PING, with or without a login", async () => {
    const open = await run(runRedis, { type: "redis", host: "127.0.0.1", port: await fakeRedis() });
    expect(open).toMatchObject({ ok: true, ip: "127.0.0.1" });
    expect(open.timings?.total).toBeGreaterThanOrEqual(0);

    const port = await fakeRedis({ password: 's3cret "quoted" and spaced' });
    /* The password travels as one bulk string, spaces and quotes included. */
    expect(
      await run(runRedis, {
        type: "redis",
        host: "127.0.0.1",
        port,
        password: 's3cret "quoted" and spaced',
      }),
    ).toMatchObject({ ok: true });
    expect(
      await run(runRedis, {
        type: "redis",
        host: "127.0.0.1",
        port,
        username: "monitor",
        password: 's3cret "quoted" and spaced',
      }),
    ).toMatchObject({ ok: true });
  });

  it("tells a refused login from a dead port from something that isn't Redis", async () => {
    const port = await fakeRedis({ password: "s3cret" });
    expectFailure(
      await run(runRedis, { type: "redis", host: "127.0.0.1", port, password: "wrong" }),
      "auth_failed",
    );
    /* No password given, but the server wants one. */
    expectFailure(await run(runRedis, { type: "redis", host: "127.0.0.1", port }), "auth_failed");
    expectFailure(
      await run(runRedis, { type: "redis", host: "127.0.0.1", port: deadPort }),
      "connect_refused",
    );
    const http = await tcpServer((socket) => {
      socket.once("data", () => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
    });
    expectFailure(
      await run(runRedis, { type: "redis", host: "127.0.0.1", port: http }),
      "protocol_error",
    );
    const silent = await tcpServer((socket) => socket.on("error", () => {}));
    expectFailure(
      await run(runRedis, { type: "redis", host: "127.0.0.1", port: silent }, { timeoutMs: 300 }),
      "response_timeout",
    );
  });

  it("obeys the probe's address rules", async () => {
    const strict = createAddressPolicy({ allowCidrs: [] });
    expectFailure(
      await run(runRedis, { type: "redis", host: "127.0.0.1", port: 6379 }, { policy: strict }),
      "ssrf_blocked",
    );
  });
});

describe("MQTT", () => {
  it("is up when the broker accepts the connection, and sends the login it was given", async () => {
    const seen: Buffer[] = [];
    const port = await fakeMqtt(() => 0, seen);
    expect(
      await run(runMqtt, {
        type: "mqtt",
        host: "127.0.0.1",
        port,
        username: "sensor",
        password: "s3cret",
        clientId: "probe-1",
      }),
    ).toMatchObject({ ok: true });
    expect(seen[0]).toEqual(
      mqttConnectPacket({ clientId: "probe-1", username: "sensor", password: "s3cret" }),
    );
    /* CONNECT, protocol "MQTT" level 4, clean session with username and password. */
    expect(seen[0]?.subarray(0, 12).toString("hex")).toBe("102300044d51545404c2001e");
    expect(await run(runMqtt, { type: "mqtt", host: "127.0.0.1", port })).toMatchObject({
      ok: true,
    });
  });

  it("reports a refused login, a broker that says no, and something that isn't a broker", async () => {
    const check = async (code: number) =>
      run(runMqtt, { type: "mqtt", host: "127.0.0.1", port: await fakeMqtt(() => code) });
    expectFailure(await check(4), "auth_failed");
    expectFailure(await check(5), "auth_failed");
    const unavailable = await check(3);
    expectFailure(unavailable, "protocol_error");
    expect(unavailable.message).toContain("the broker is unavailable");
    const http = await tcpServer((socket) => {
      socket.once("data", () => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
    });
    expectFailure(
      await run(runMqtt, { type: "mqtt", host: "127.0.0.1", port: http }),
      "protocol_error",
    );
    expectFailure(
      await run(runMqtt, { type: "mqtt", host: "127.0.0.1", port: deadPort }),
      "connect_refused",
    );
  });

  it("encodes long packets' length in more than one byte", () => {
    const packet = mqttConnectPacket({ clientId: "c", username: "u".repeat(200), password: "p" });
    /* 10 header bytes + 3 + 202 + 3 = 218 = 0xDA 0x01 in MQTT's variable length. */
    expect(packet.subarray(0, 3).toString("hex")).toBe("10da01");
    expect(packet.length).toBe(3 + 218);
  });
});

describe("gRPC health", () => {
  it("is up when the server, or the named service, reports SERVING", async () => {
    const port = await fakeGrpc((service) =>
      service === "" || service === "shop.Checkout"
        ? { grpcStatus: 0, serving: 1 }
        : service === "shop.Search"
          ? { grpcStatus: 0, serving: 2 }
          : { grpcStatus: 5 },
    );
    const base = { type: "grpc", host: "127.0.0.1", port, tls: false } as const;
    expect(await run(runGrpc, base)).toMatchObject({ ok: true, ip: "127.0.0.1" });
    expect(await run(runGrpc, { ...base, service: "shop.Checkout" })).toMatchObject({ ok: true });

    const notServing = await run(runGrpc, { ...base, service: "shop.Search" });
    expectFailure(notServing, "service_unhealthy");
    expect(notServing.message).toContain("NOT_SERVING");
    const unknown = await run(runGrpc, { ...base, service: "shop.Nothing" });
    expectFailure(unknown, "service_unhealthy");
    expect(unknown.message).toContain('doesn\'t know the service "shop.Nothing"');
  });

  it("reports a server without the health service, a refusal, and something that isn't gRPC", async () => {
    const check = async (grpcStatus: number) =>
      run(runGrpc, {
        type: "grpc",
        host: "127.0.0.1",
        port: await fakeGrpc(() => ({ grpcStatus })),
        tls: false,
      });
    const none = await check(12);
    expectFailure(none, "protocol_error");
    expect(none.message).toContain("no gRPC health service");
    expectFailure(await check(16), "auth_failed");
    expectFailure(await check(14), "protocol_error");
    /* An answer with no status at all counts as unknown, not as serving. */
    const silentStatus = await run(runGrpc, {
      type: "grpc",
      host: "127.0.0.1",
      port: await fakeGrpc(() => ({ grpcStatus: 0, serving: 0 })),
      tls: false,
    });
    expectFailure(silentStatus, "service_unhealthy");

    const http1 = await tcpServer((socket) => {
      socket.once("data", () => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
      socket.on("error", () => {});
    });
    expectFailure(
      await run(runGrpc, { type: "grpc", host: "127.0.0.1", port: http1, tls: false }),
      "protocol_error",
    );
    expectFailure(
      await run(runGrpc, { type: "grpc", host: "127.0.0.1", port: deadPort, tls: false }),
      "connect_refused",
    );
  });

  it("builds the health request for a service name", () => {
    expect(grpcHealthRequest("").toString("hex")).toBe("0000000000");
    expect(grpcHealthRequest("ab").toString("hex")).toBe("00000000040a026162");
  });
});
