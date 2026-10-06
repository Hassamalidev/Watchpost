/*
 * SSRF-safe HTTP(S) client for checks (PRODUCT.md §9.1 steps 1–6):
 * every hop is resolved and vetted, the socket connects to the vetted IP through a pinned lookup
 * (Host and SNI keep the original name), redirects are followed manually with re-validation, and
 * the body read stops at a byte cap after decompression, so compression bombs can't inflate.
 */
import http from "node:http";
import https from "node:https";
import nodeTls, { type TLSSocket } from "node:tls";
import zlib from "node:zlib";
import type { Readable } from "node:stream";
import timer from "@szmarczak/http-timer";
import type { AddressPolicy } from "./address-policy.js";
import { CheckError, toCheckError } from "./errors.js";
import {
  pinnedLookup,
  preferredAddress,
  resolveVetted,
  systemResolver,
  type Resolver,
} from "./resolve.js";

export const MAX_TIMEOUT_MS = 30_000;
export const MAX_BODY_BYTES = 1_048_576;
export const MAX_HEADERS = 100;
export const MAX_REDIRECTS = 5;
export const USER_AGENT = "WatchpostBot/1.0 (uptime monitoring)";

export interface HttpRequestOptions {
  url: string;
  method?: string;
  headers?: ReadonlyArray<{ name: string; value: string }>;
  body?: string;
  timeoutMs: number;
  followRedirects?: boolean;
  maxRedirects?: number;
  /* Allow a redirect from https to http (off by default, §9.1 step 3). */
  allowDowngrade?: boolean;
  ignoreTlsErrors?: boolean;
  /* Extra trusted CAs (PEM), added to Node's default roots. */
  ca?: string[];
  maxBodyBytes?: number;
  policy: AddressPolicy;
  resolver?: Resolver;
  signal?: AbortSignal;
}

export interface TlsFacts {
  validFrom: string;
  validTo: string;
  issuer: string;
  subject: string;
  fingerprint256: string;
  daysRemaining: number;
  protocol?: string;
}

export interface HttpTimings {
  dns: number;
  connect: number;
  tls?: number;
  ttfb: number;
  download: number;
  total: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  /* True when the body was cut at maxBodyBytes (after decompression). */
  truncated: boolean;
  ip: string;
  timings: HttpTimings;
  tls?: TlsFacts;
  finalUrl: string;
  redirects: string[];
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function readName(entity: Record<string, unknown> | undefined): string {
  if (!entity) return "";
  const cn = entity.CN ?? entity.O;
  return Array.isArray(cn) ? cn.join(", ") : String(cn ?? "");
}

function tlsFactsOf(socket: TLSSocket, nowMs: number): TlsFacts | undefined {
  const cert = socket.getPeerCertificate();
  if (!cert || Object.keys(cert).length === 0) return undefined;
  const validTo = new Date(cert.valid_to);
  const protocol = socket.getProtocol();
  return {
    validFrom: new Date(cert.valid_from).toISOString(),
    validTo: validTo.toISOString(),
    issuer: readName(cert.issuer as unknown as Record<string, unknown>),
    subject: readName(cert.subject as unknown as Record<string, unknown>),
    fingerprint256: cert.fingerprint256,
    daysRemaining: Math.floor((validTo.getTime() - nowMs) / 86_400_000),
    ...(protocol ? { protocol } : {}),
  };
}

function decoderFor(
  encoding: string | undefined,
): zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | undefined {
  switch ((encoding ?? "").toLowerCase().trim()) {
    case "gzip":
    case "x-gzip":
      return zlib.createGunzip();
    case "deflate":
      return zlib.createInflate();
    case "br":
      return zlib.createBrotliDecompress();
    default:
      return undefined;
  }
}

/* Reads at most `max` bytes of the (decompressed) body, then stops reading. */
function readBody(
  res: http.IncomingMessage,
  max: number,
): Promise<{ body: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const decoder = decoderFor(res.headers["content-encoding"]);
    const source: Readable = decoder ? res.pipe(decoder) : res;
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (truncated: boolean) => {
      if (done) return;
      done = true;
      resolve({ body: Buffer.concat(chunks, Math.min(size, max)), truncated });
    };
    const stop = (truncated: boolean) => {
      finish(truncated);
      res.destroy();
      decoder?.destroy();
    };
    source.on("data", (chunk: Buffer) => {
      if (done) return;
      /* Exactly at the cap already: any further byte means the body was longer. */
      if (size >= max) {
        stop(true);
        return;
      }
      const room = max - size;
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room));
        size = max;
        stop(true);
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    source.on("end", () => finish(false));
    source.on("error", (err) => {
      if (done) return;
      done = true;
      reject(new CheckError("connect_reset", `body read failed: ${err.message}`));
    });
    res.on("aborted", () => finish(true));
  });
}

interface HopResult {
  res: http.IncomingMessage;
  ip: string;
  tls?: TlsFacts;
  dnsMs: number;
  timings: ReturnType<typeof timer>;
}

async function requestHop(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  options: HttpRequestOptions,
  deadline: number,
): Promise<HopResult> {
  const { addresses, dnsMs } = await resolveVetted(
    url.hostname,
    options.policy,
    options.resolver ?? systemResolver,
  );
  const vetted = preferredAddress(addresses);
  if (vetted === undefined)
    throw new CheckError("dns_no_records", `${url.hostname} has no addresses`);
  const isHttps = url.protocol === "https:";
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new CheckError("response_timeout", "timed out before connecting");

  return new Promise<HopResult>((resolve, reject) => {
    let connected = false;
    let tls: TlsFacts | undefined;
    const requestOptions: https.RequestOptions = {
      method,
      headers,
      agent: false,
      lookup: pinnedLookup(vetted) as unknown as https.RequestOptions["lookup"],
      ...(isHttps
        ? {
            servername: url.hostname.replace(/^\[|\]$/g, ""),
            rejectUnauthorized: !options.ignoreTlsErrors,
            ...(options.ca ? { ca: [...nodeTls.rootCertificates, ...options.ca] } : {}),
          }
        : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    };
    const req = (isHttps ? https : http).request(url, requestOptions);
    const timings = timer(req);
    const deadlineTimer = setTimeout(() => {
      req.destroy(
        new CheckError(
          connected ? "response_timeout" : "connect_timeout",
          `no ${connected ? "complete response" : "connection"} within ${options.timeoutMs} ms`,
        ),
      );
    }, remaining);

    req.on("socket", (socket) => {
      socket.once("connect", () => {
        connected = true;
      });
      if (isHttps) {
        socket.once("secureConnect", () => {
          tls = tlsFactsOf(socket as TLSSocket, Date.now());
        });
      }
    });
    req.on("response", (res) => {
      clearTimeout(deadlineTimer);
      const bodyTimer = setTimeout(
        () => {
          res.destroy(
            new CheckError("response_timeout", `body not received within ${options.timeoutMs} ms`),
          );
        },
        Math.max(1, deadline - Date.now()),
      );
      res.once("close", () => clearTimeout(bodyTimer));
      resolve({ res, ip: vetted.address, dnsMs, timings, ...(tls ? { tls } : {}) });
    });
    req.on("error", (err) => {
      clearTimeout(deadlineTimer);
      reject(toCheckError(err, connected ? (isHttps ? "tls" : "response") : "connect"));
    });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

export async function httpRequest(options: HttpRequestOptions): Promise<HttpResponse> {
  const timeoutMs = Math.min(options.timeoutMs, MAX_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;
  const maxRedirects = Math.min(options.maxRedirects ?? MAX_REDIRECTS, MAX_REDIRECTS);
  const maxBody = Math.min(options.maxBodyBytes ?? MAX_BODY_BYTES, MAX_BODY_BYTES);
  const started = performance.now();
  const redirects: string[] = [];

  let url = new URL(options.url);
  let method = (options.method ?? "GET").toUpperCase();
  let body = options.body;
  const defaultHeaders: Record<string, string> = {
    "user-agent": USER_AGENT,
    accept: "*/*",
    "accept-encoding": "gzip, deflate, br",
  };
  const baseHeaders = { ...defaultHeaders };
  for (const h of options.headers ?? []) baseHeaders[h.name.toLowerCase()] = h.value;
  /*
   * The user's headers (auth, cookies, API keys under any name) go only to the origin they configured:
   * a redirect elsewhere must not receive them.
   */
  const trustedOrigin = url.origin;

  for (let hop = 0; ; hop += 1) {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new CheckError("http_redirect_blocked", `unsupported protocol ${url.protocol}`);
    }
    const headers = { ...(url.origin === trustedOrigin ? baseHeaders : defaultHeaders) };
    if (body !== undefined) headers["content-length"] = String(Buffer.byteLength(body));
    const { res, ip, tls, dnsMs, timings } = await requestHop(
      url,
      method,
      headers,
      body,
      options,
      deadline,
    );
    const status = res.statusCode ?? 0;
    const location = res.headers.location;

    if (REDIRECT_STATUSES.has(status) && location && options.followRedirects !== false) {
      res.destroy();
      if (hop >= maxRedirects) {
        throw new CheckError("http_too_many_redirects", `more than ${maxRedirects} redirects`, {
          redirects,
        });
      }
      const next = new URL(location, url);
      if (url.protocol === "https:" && next.protocol === "http:" && !options.allowDowngrade) {
        throw new CheckError(
          "http_redirect_blocked",
          `redirect from https to http (${next.origin}) blocked`,
        );
      }
      redirects.push(next.toString());
      if (status === 303 || ((status === 301 || status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
      }
      /* 307/308 resend the body; like the headers, it may carry secrets meant for this origin only. */
      if (body !== undefined && next.origin !== trustedOrigin) {
        throw new CheckError(
          "http_redirect_blocked",
          `redirect to ${next.origin} would resend the request body to another origin`,
          { redirects },
        );
      }
      url = next;
      continue;
    }

    const read =
      method === "HEAD" || status === 204 || status === 304
        ? { body: Buffer.alloc(0), truncated: false }
        : await readBody(res, maxBody);

    const headersOut: Record<string, string> = {};
    for (let i = 0; i < res.rawHeaders.length && i < MAX_HEADERS * 2; i += 2) {
      const name = res.rawHeaders[i]?.toLowerCase();
      const value = res.rawHeaders[i + 1];
      if (name !== undefined && value !== undefined && headersOut[name] === undefined)
        headersOut[name] = value;
    }
    const phases = timings.phases;
    const total = performance.now() - started;
    return {
      status,
      headers: headersOut,
      body: read.body,
      truncated: read.truncated,
      ip,
      timings: {
        dns: Math.round(dnsMs),
        connect: Math.round(phases.tcp ?? 0),
        ...(url.protocol === "https:" ? { tls: Math.round(phases.tls ?? 0) } : {}),
        ttfb: Math.round(phases.firstByte ?? 0),
        download: Math.round(phases.download ?? 0),
        total: Math.round(total),
      },
      ...(tls ? { tls } : {}),
      finalUrl: url.toString(),
      redirects,
    };
  }
}
