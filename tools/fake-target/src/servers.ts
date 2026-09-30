/* Starts the HTTP (+WebSocket echo), expiring TLS and TCP echo listeners. */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { once } from "node:events";
import selfsigned from "selfsigned";
import { WebSocketServer } from "ws";
import type { FakeTargetConfig } from "./config.js";
import { createHttpHandler, type HandlerDeps } from "./http-handler.js";

export interface RunningServers {
  httpPort: number;
  tlsPort: number;
  tcpPort: number;
  certNotAfter: Date;
  close: () => Promise<void>;
}

const DAY_MS = 86_400_000;

export async function createSelfSignedCert(days: number, now = new Date()) {
  const notAfterDate = new Date(now.getTime() + days * DAY_MS);
  const pems = await selfsigned.generate([{ name: "commonName", value: "localhost" }], {
    keyType: "ec",
    algorithm: "sha256",
    notBeforeDate: new Date(now.getTime() - DAY_MS),
    notAfterDate,
  });
  return { key: pems.private, cert: pems.cert, notAfterDate };
}

function attachWebSocketEcho(server: http.Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (socket) => {
    socket.on("message", (data, isBinary) => socket.send(data, { binary: isBinary }));
  });
  return wss;
}

function handleWith(handler: ReturnType<typeof createHttpHandler>): http.RequestListener {
  return (req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end("Internal error");
    });
  };
}

async function listen(server: net.Server, port: number, host: string): Promise<number> {
  server.listen(port, host);
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Unexpected address");
  return address.port;
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

export async function startServers(
  config: FakeTargetConfig,
  deps: Partial<HandlerDeps> = {},
): Promise<RunningServers> {
  const handler = createHttpHandler(deps);

  const httpServer = http.createServer(handleWith(handler));
  const wss = attachWebSocketEcho(httpServer);

  const { key, cert, notAfterDate } = await createSelfSignedCert(config.tlsDays);
  const tlsServer = https.createServer({ key, cert }, handleWith(handler));

  const sockets = new Set<net.Socket>();
  const tcpServer = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.pipe(socket);
  });

  const [httpPort, tlsPort, tcpPort] = await Promise.all([
    listen(httpServer, config.httpPort, config.host),
    listen(tlsServer, config.tlsPort, config.host),
    listen(tcpServer, config.tcpPort, config.host),
  ]);

  return {
    httpPort,
    tlsPort,
    tcpPort,
    certNotAfter: notAfterDate,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      wss.close();
      for (const socket of sockets) socket.destroy();
      httpServer.closeAllConnections();
      tlsServer.closeAllConnections();
      await Promise.all([closeServer(httpServer), closeServer(tlsServer), closeServer(tcpServer)]);
    },
  };
}
