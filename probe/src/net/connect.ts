/*
 * Raw TCP (and TLS) connections to a vetted address (PRODUCT.md §9.1), for TCP, SSL and ping-fallback
 * checks. Same rules as HTTP: resolve, vet every answer, connect to the vetted IP, SNI = original name.
 */
import net from "node:net";
import nodeTls from "node:tls";
import type { AddressPolicy } from "./address-policy.js";
import { CheckError, toCheckError } from "./errors.js";
import type { TlsFacts } from "./http-client.js";
import { preferredAddress, resolveVetted, systemResolver, type Resolver } from "./resolve.js";

export interface ConnectResult {
  socket: net.Socket;
  ip: string;
  timings: { dns: number; connect: number; tls?: number };
  tls?: TlsFacts;
}

export function tlsFacts(socket: nodeTls.TLSSocket, nowMs = Date.now()): TlsFacts | undefined {
  const cert = socket.getPeerCertificate();
  if (!cert || Object.keys(cert).length === 0) return undefined;
  const validTo = new Date(cert.valid_to);
  const name = (entity: unknown) => {
    const e = (entity ?? {}) as Record<string, unknown>;
    const v = e.CN ?? e.O;
    return Array.isArray(v) ? v.join(", ") : String(v ?? "");
  };
  const protocol = socket.getProtocol();
  return {
    validFrom: new Date(cert.valid_from).toISOString(),
    validTo: validTo.toISOString(),
    issuer: name(cert.issuer),
    subject: name(cert.subject),
    fingerprint256: cert.fingerprint256,
    daysRemaining: Math.floor((validTo.getTime() - nowMs) / 86_400_000),
    ...(protocol ? { protocol } : {}),
  };
}

export async function connectVetted(options: {
  host: string;
  port: number;
  policy: AddressPolicy;
  timeoutMs: number;
  /* `alpn` offers protocols during the handshake (gRPC needs "h2"). */
  tls?: { rejectUnauthorized: boolean; ca?: string[] | undefined; alpn?: string[] | undefined };
  resolver?: Resolver;
}): Promise<ConnectResult> {
  const deadline = Date.now() + options.timeoutMs;
  const { addresses, dnsMs } = await resolveVetted(
    options.host,
    options.policy,
    options.resolver ?? systemResolver,
  );
  const target = preferredAddress(addresses);
  if (target === undefined)
    throw new CheckError("dns_no_records", `${options.host} has no addresses`);

  const connectStarted = performance.now();
  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const s = net.connect({ host: target.address, port: options.port, family: target.family });
    const timer = setTimeout(
      () => {
        s.destroy();
        reject(new CheckError("connect_timeout", `no connection within ${options.timeoutMs} ms`));
      },
      Math.max(1, deadline - Date.now()),
    );
    s.once("connect", () => {
      clearTimeout(timer);
      resolve(s);
    });
    s.once("error", (err) => {
      clearTimeout(timer);
      reject(toCheckError(err, "connect"));
    });
  });
  const connectMs = performance.now() - connectStarted;

  if (options.tls === undefined) {
    return {
      socket,
      ip: target.address,
      timings: { dns: Math.round(dnsMs), connect: Math.round(connectMs) },
    };
  }

  const tlsStarted = performance.now();
  const servername = net.isIP(options.host) ? undefined : options.host;
  const secure = await new Promise<nodeTls.TLSSocket>((resolve, reject) => {
    const s = nodeTls.connect({
      socket,
      ...(servername ? { servername } : {}),
      rejectUnauthorized: options.tls?.rejectUnauthorized ?? true,
      ...(options.tls?.ca ? { ca: [...nodeTls.rootCertificates, ...options.tls.ca] } : {}),
      ...(options.tls?.alpn ? { ALPNProtocols: options.tls.alpn } : {}),
    });
    const timer = setTimeout(
      () => {
        s.destroy();
        reject(
          new CheckError(
            "tls_handshake_failed",
            `TLS handshake didn't finish within ${options.timeoutMs} ms`,
          ),
        );
      },
      Math.max(1, deadline - Date.now()),
    );
    s.once("secureConnect", () => {
      clearTimeout(timer);
      resolve(s);
    });
    s.once("error", (err) => {
      clearTimeout(timer);
      socket.destroy();
      reject(toCheckError(err, "tls"));
    });
  });
  const facts = tlsFacts(secure);
  return {
    socket: secure,
    ip: target.address,
    timings: {
      dns: Math.round(dnsMs),
      connect: Math.round(connectMs),
      tls: Math.round(performance.now() - tlsStarted),
    },
    ...(facts ? { tls: facts } : {}),
  };
}
