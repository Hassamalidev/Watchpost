/*
 * Protocol checks for services that usually live inside a network (PRODUCT.md §6.1, private
 * probes): Redis, MQTT and gRPC. Each speaks just enough of its protocol to tell "the port is open"
 * from "the service answers and lets us in": Redis answers PING, an MQTT broker accepts a
 * connection, a gRPC server reports SERVING on the standard health service.
 */
import http2 from "node:http2";
import type { Duplex } from "node:stream";
import type { MonitorConfig } from "@app/shared";
import { failure, type CheckContext, type CheckOutcome } from "../executor/executor.js";
import { connectVetted, type ConnectResult } from "../net/connect.js";
import { CheckError } from "../net/errors.js";

const elapsed = (started: number) => Math.round(performance.now() - started);

async function open(
  config: { host: string; port: number; tls: boolean },
  ctx: CheckContext,
  alpn?: string[],
): Promise<ConnectResult> {
  return connectVetted({
    host: config.host,
    port: config.port,
    policy: ctx.policy,
    timeoutMs: ctx.timeoutMs,
    ...(config.tls
      ? { tls: { rejectUnauthorized: true, ca: ctx.ca, ...(alpn ? { alpn } : {}) } }
      : {}),
  });
}

/* Collects what the service sends until `complete` says there is a whole answer, or time runs out. */
function readReply(
  socket: Duplex,
  complete: (received: Buffer) => boolean,
  deadline: number,
): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    let received = Buffer.alloc(0);
    const finish = (value: Buffer | undefined) => {
      clearTimeout(timer);
      socket.removeAllListeners("data");
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), Math.max(1, deadline - Date.now()));
    socket.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (complete(received)) finish(received);
      else if (received.length > 65_536) finish(undefined);
    });
    socket.once("end", () => finish(complete(received) ? received : undefined));
    socket.once("error", () => finish(undefined));
  });
}

/* Connection problems become their own error codes; anything else is a bug and is thrown. */
async function withConnection(
  config: { host: string; port: number; tls: boolean },
  ctx: CheckContext,
  check: (conn: ConnectResult, started: number, deadline: number) => Promise<CheckOutcome>,
  alpn?: string[],
): Promise<CheckOutcome> {
  const started = performance.now();
  const deadline = Date.now() + ctx.timeoutMs;
  let conn: ConnectResult;
  try {
    conn = await open(config, ctx, alpn);
  } catch (err) {
    if (err instanceof CheckError) return failure(err.code, err.message, elapsed(started));
    throw err;
  }
  try {
    const outcome = await check(conn, started, deadline);
    return { ...outcome, ip: conn.ip, ...(conn.tls ? { tls: conn.tls } : {}) };
  } finally {
    conn.socket.destroy();
  }
}

const success = (conn: ConnectResult, started: number): CheckOutcome => {
  const total = elapsed(started);
  return { ok: true, latencyMs: total, timings: { ...conn.timings, total } };
};

/* ---- Redis ---- */

/* A command as a RESP array of bulk strings, which is safe for any password. */
const resp = (...parts: string[]) =>
  `*${parts.length}\r\n${parts.map((p) => `$${Buffer.byteLength(p)}\r\n${p}\r\n`).join("")}`;
const firstLine = (received: Buffer) => received.toString("utf8").split("\r\n")[0] ?? "";
const hasLine = (received: Buffer) => received.includes("\r\n");

export async function runRedis(config: MonitorConfig, ctx: CheckContext): Promise<CheckOutcome> {
  if (config.type !== "redis") throw new Error("runRedis got another config");
  return withConnection(config, ctx, async (conn, started, deadline) => {
    const ask = async (command: string) => {
      conn.socket.write(command);
      const reply = await readReply(conn.socket, hasLine, deadline);
      return reply === undefined ? undefined : firstLine(reply);
    };
    if (config.password !== undefined) {
      const auth = await ask(
        config.username === undefined
          ? resp("AUTH", config.password)
          : resp("AUTH", config.username, config.password),
      );
      if (auth === undefined)
        return failure("response_timeout", "no answer to AUTH", elapsed(started));
      if (auth !== "+OK")
        return failure("auth_failed", `Redis refused the login: ${auth}`, elapsed(started));
    }
    const pong = await ask(resp("PING"));
    if (pong === undefined)
      return failure("response_timeout", "no answer to PING", elapsed(started));
    if (pong === "+PONG") return success(conn, started);
    if (/^-(NOAUTH|WRONGPASS|NOPERM)/.test(pong)) {
      return failure("auth_failed", `Redis wants a login: ${pong}`, elapsed(started));
    }
    return failure(
      "protocol_error",
      `expected +PONG, got "${pong.slice(0, 200)}"`,
      elapsed(started),
    );
  });
}

/* ---- MQTT 3.1.1 ---- */

const mqttString = (text: string) => {
  const bytes = Buffer.from(text, "utf8");
  const length = Buffer.alloc(2);
  length.writeUInt16BE(bytes.length);
  return Buffer.concat([length, bytes]);
};

/* The "remaining length" of a packet: seven bits a byte, the top bit says another byte follows. */
function mqttLength(length: number): Buffer {
  const bytes: number[] = [];
  let rest = length;
  do {
    const byte = rest % 128;
    rest = Math.floor(rest / 128);
    bytes.push(rest > 0 ? byte | 0x80 : byte);
  } while (rest > 0);
  return Buffer.from(bytes);
}

export function mqttConnectPacket(options: {
  clientId: string;
  username?: string | undefined;
  password?: string | undefined;
}): Buffer {
  const flags =
    0x02 /* clean session */ |
    (options.username === undefined ? 0 : 0x80) |
    (options.password === undefined ? 0 : 0x40);
  const body = Buffer.concat([
    mqttString("MQTT"),
    Buffer.from([0x04, flags, 0x00, 0x1e]),
    mqttString(options.clientId),
    ...(options.username === undefined ? [] : [mqttString(options.username)]),
    ...(options.password === undefined ? [] : [mqttString(options.password)]),
  ]);
  return Buffer.concat([Buffer.from([0x10]), mqttLength(body.length), body]);
}

const MQTT_REFUSALS: Record<number, string> = {
  1: "the broker doesn't speak this protocol version",
  2: "the broker refused the client ID",
  3: "the broker is unavailable",
  4: "wrong username or password",
  5: "not authorised",
};

export async function runMqtt(config: MonitorConfig, ctx: CheckContext): Promise<CheckOutcome> {
  if (config.type !== "mqtt") throw new Error("runMqtt got another config");
  return withConnection(config, ctx, async (conn, started, deadline) => {
    conn.socket.write(
      mqttConnectPacket({
        clientId: config.clientId ?? `probe-${Math.random().toString(36).slice(2, 10)}`,
        username: config.username,
        /* A password without a username isn't allowed by the protocol. */
        password: config.username === undefined ? undefined : config.password,
      }),
    );
    const reply = await readReply(conn.socket, (received) => received.length >= 4, deadline);
    if (reply === undefined) {
      return failure("response_timeout", "no answer to the MQTT connection", elapsed(started));
    }
    if (reply[0] !== 0x20 || reply[1] !== 0x02) {
      return failure("protocol_error", "the answer isn't an MQTT CONNACK", elapsed(started));
    }
    const code = reply[3] ?? 255;
    if (code === 0) {
      /* A clean goodbye, so the broker doesn't log a dropped client. */
      conn.socket.write(Buffer.from([0xe0, 0x00]));
      return success(conn, started);
    }
    const reason = MQTT_REFUSALS[code] ?? `return code ${code}`;
    return failure(
      code === 4 || code === 5 ? "auth_failed" : "protocol_error",
      `The MQTT broker refused the connection: ${reason}`,
      elapsed(started),
    );
  });
}

/* ---- gRPC health ---- */

/* HealthCheckRequest { string service = 1; } with gRPC's five-byte message prefix. */
export function grpcHealthRequest(service: string): Buffer {
  const name = Buffer.from(service, "utf8");
  const message =
    name.length === 0 ? Buffer.alloc(0) : Buffer.concat([Buffer.from([0x0a, name.length]), name]);
  const prefix = Buffer.alloc(5);
  prefix.writeUInt32BE(message.length, 1);
  return Buffer.concat([prefix, message]);
}

/* HealthCheckResponse { ServingStatus status = 1; }: 0 unknown, 1 serving, 2 not serving. */
function grpcServingStatus(body: Buffer): number {
  const message = body.subarray(5);
  return message[0] === 0x08 ? (message[1] ?? 0) : 0;
}

const GRPC_STATUS_TEXT = ["UNKNOWN", "SERVING", "NOT_SERVING", "SERVICE_UNKNOWN"];

export async function runGrpc(config: MonitorConfig, ctx: CheckContext): Promise<CheckOutcome> {
  if (config.type !== "grpc") throw new Error("runGrpc got another config");
  return withConnection(
    config,
    ctx,
    (conn, started, deadline) =>
      new Promise<CheckOutcome>((resolve) => {
        const scheme = config.tls ? "https" : "http";
        const session = http2.connect(`${scheme}://${config.host}:${config.port}`, {
          createConnection: () => conn.socket,
        });
        const finish = (outcome: CheckOutcome) => {
          clearTimeout(timer);
          session.destroy();
          resolve(outcome);
        };
        const timer = setTimeout(
          () => finish(failure("response_timeout", "no gRPC answer in time", elapsed(started))),
          Math.max(1, deadline - Date.now()),
        );
        session.once("error", (err) =>
          finish(
            failure(
              "protocol_error",
              `not a gRPC (HTTP/2) server: ${err.message}`,
              elapsed(started),
            ),
          ),
        );
        const call = session.request({
          ":method": "POST",
          ":path": "/grpc.health.v1.Health/Check",
          "content-type": "application/grpc",
          te: "trailers",
        });
        const chunks: Buffer[] = [];
        let grpcStatus: string | undefined;
        let grpcMessage = "";
        const readStatus = (headers: http2.IncomingHttpHeaders) => {
          if (typeof headers["grpc-status"] === "string") grpcStatus = headers["grpc-status"];
          if (typeof headers["grpc-message"] === "string") grpcMessage = headers["grpc-message"];
        };
        /* An error with no message comes as headers only; a normal answer ends with trailers. */
        call.on("response", readStatus);
        call.on("trailers", readStatus);
        call.on("data", (chunk: Buffer) => chunks.push(chunk));
        call.once("error", (err) =>
          finish(failure("protocol_error", `gRPC call failed: ${err.message}`, elapsed(started))),
        );
        call.once("end", () => {
          if (grpcStatus === "16" || grpcStatus === "7") {
            return finish(
              failure("auth_failed", "the gRPC server refused the call", elapsed(started)),
            );
          }
          if (grpcStatus === "5") {
            return finish(
              failure(
                "service_unhealthy",
                `the server doesn't know the service "${config.service}"`,
                elapsed(started),
              ),
            );
          }
          if (grpcStatus === "12") {
            return finish(
              failure(
                "protocol_error",
                "the server has no gRPC health service (grpc.health.v1.Health)",
                elapsed(started),
              ),
            );
          }
          if (grpcStatus !== "0") {
            return finish(
              failure(
                "protocol_error",
                `gRPC status ${grpcStatus ?? "missing"} ${grpcMessage}`.trim(),
                elapsed(started),
              ),
            );
          }
          const status = grpcServingStatus(Buffer.concat(chunks));
          if (status === 1) return finish(success(conn, started));
          finish(
            failure(
              "service_unhealthy",
              `the service reports ${GRPC_STATUS_TEXT[status] ?? status}`,
              elapsed(started),
            ),
          );
        });
        call.end(grpcHealthRequest(config.service));
      }),
    ["h2"],
  );
}
