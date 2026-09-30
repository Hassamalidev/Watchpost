import { afterAll, beforeAll, describe, expect, it } from "vitest";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { once } from "node:events";
import { WebSocket } from "ws";
import { startServers, type RunningServers } from "../servers.js";
import { BIG_BODY_BYTES, PRIVATE_REDIRECT_TARGET, type HandlerState } from "../http-handler.js";

let running: RunningServers;
let clock = 0;
const state: HandlerState = { switchState: "ok" };
const base = () => `http://127.0.0.1:${running.httpPort}`;
const get = (path: string, init?: RequestInit) =>
  fetch(`${base()}${path}`, { redirect: "manual", ...init });

beforeAll(async () => {
  running = await startServers(
    { host: "127.0.0.1", httpPort: 0, tlsPort: 0, tcpPort: 0, tlsDays: 5 },
    { state, now: () => clock, sleep: async () => {} },
  );
});

afterAll(async () => {
  await running.close();
});

describe("HTTP endpoints", () => {
  it("/ok returns 200", async () => {
    const res = await get("/ok");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK");
  });

  it("/fail returns 500, or the requested 4xx/5xx", async () => {
    expect((await get("/fail")).status).toBe(500);
    expect((await get("/fail?status=502")).status).toBe(502);
  });

  it("/slow waits and then succeeds", async () => {
    const res = await get("/slow?ms=10");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("10 ms");
  });

  it("/flap alternates by period", async () => {
    clock = 0;
    expect((await get("/flap?period=10")).status).toBe(200);
    clock = 10_000;
    expect((await get("/flap?period=10")).status).toBe(503);
    clock = 20_000;
    expect((await get("/flap?period=10")).status).toBe(200);
  });

  it("/keyword echoes the word into the body", async () => {
    expect(await (await get("/keyword?word=banana")).text()).toContain("banana");
  });

  it("/json returns a JSON document", async () => {
    const body = (await (await get("/json")).json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  it("/big returns a body over 1 MB", async () => {
    const buf = await (await get("/big")).arrayBuffer();
    expect(buf.byteLength).toBe(BIG_BODY_BYTES);
  });

  it("/redirect-private points at cloud metadata", async () => {
    const res = await get("/redirect-private");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(PRIVATE_REDIRECT_TARGET);
  });

  it("/switch follows the control switch", async () => {
    expect((await get("/switch")).status).toBe(200);
    const set = await get("/control/switch?state=fail", { method: "POST" });
    expect(set.status).toBe(200);
    expect((await get("/switch")).status).toBe(500);
    await get("/control/switch?state=ok", { method: "POST" });
    expect((await get("/switch")).status).toBe(200);
  });

  it("/control/switch rejects GET and bad states", async () => {
    expect((await get("/control/switch?state=fail")).status).toBe(405);
    expect((await get("/control/switch?state=boom", { method: "POST" })).status).toBe(400);
  });

  it("unknown paths return 404", async () => {
    expect((await get("/nope")).status).toBe(404);
  });
});

describe("TLS port", () => {
  it("serves a self-signed certificate that expires in the configured days", async () => {
    const socket = tls.connect({
      host: "127.0.0.1",
      port: running.tlsPort,
      servername: "localhost",
      rejectUnauthorized: false,
    });
    await once(socket, "secureConnect");
    const cert = socket.getPeerCertificate();
    socket.destroy();
    const daysLeft = (new Date(cert.valid_to).getTime() - Date.now()) / 86_400_000;
    expect(daysLeft).toBeGreaterThan(4);
    expect(daysLeft).toBeLessThanOrEqual(5);
  });

  it("serves the same HTTP routes", async () => {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      https
        .get(
          { host: "127.0.0.1", port: running.tlsPort, path: "/ok", rejectUnauthorized: false },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          },
        )
        .on("error", reject);
    });
    expect(status).toBe(200);
  });
});

describe("echo servers", () => {
  it("TCP echoes bytes back", async () => {
    const socket = net.connect(running.tcpPort, "127.0.0.1");
    await once(socket, "connect");
    socket.write("ping");
    const [data] = (await once(socket, "data")) as [Buffer];
    socket.destroy();
    expect(data.toString()).toBe("ping");
  });

  it("WebSocket echoes messages back", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${running.httpPort}/ws`);
    await once(ws, "open");
    ws.send("hello");
    const [data] = (await once(ws, "message")) as [Buffer];
    ws.close();
    expect(data.toString()).toBe("hello");
  });
});
