/*
 * Outbound HTTP to URLs our users give us (webhooks, chat APIs), with the probe's SSRF rules
 * (PRODUCT.md §9.1, §12): only http(s), every resolved address must be public, the connection is
 * pinned to the vetted address (no second DNS lookup to rebind), redirects are not followed, and
 * responses are capped in time and size.
 */
import { promises as dns, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { AddressPolicy } from "@app/shared";

export interface OutboundRequest {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /*
   * Set when the caller needs the whole body (JSON APIs): a larger response fails with `too_large`
   * instead of being cut. Without it the body is quietly capped, which is fine when only the status
   * matters (alert deliveries).
   */
  maxBodyBytes?: number;
}

export interface OutboundResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export type OutboundErrorCode =
  "invalid_url" | "blocked" | "dns" | "timeout" | "network" | "too_large";

export class OutboundError extends Error {
  constructor(
    readonly code: OutboundErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OutboundError";
  }
}

export interface OutboundHttp {
  request(req: OutboundRequest): Promise<OutboundResponse>;
}

export type Resolver = (hostname: string) => Promise<string[]>;

const systemResolver: Resolver = async (hostname) =>
  (await dns.lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BODY = 64 * 1024;

export function createOutboundHttp(options: {
  policy: AddressPolicy;
  resolve?: Resolver;
  maxBodyBytes?: number;
  userAgent?: string;
}): OutboundHttp {
  const resolve = options.resolve ?? systemResolver;
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const userAgent = options.userAgent ?? "Watchpost-Alerts/1.0";

  async function vet(url: URL): Promise<string> {
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (options.policy.isDeniedHost(hostname)) {
      throw new OutboundError("blocked", `${hostname} is not allowed`);
    }
    let addresses: string[];
    if (net.isIP(hostname)) {
      addresses = [hostname];
    } else {
      try {
        addresses = await resolve(hostname);
      } catch (err) {
        throw new OutboundError(
          "dns",
          `DNS lookup for ${hostname} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (addresses.length === 0) throw new OutboundError("dns", `${hostname} has no addresses`);
    /* Every answer must pass: a mixed answer is how rebinding attacks start. */
    for (const address of addresses) {
      const reason = options.policy.check(address);
      if (reason !== null) throw new OutboundError("blocked", reason);
    }
    return addresses.find((a) => net.isIPv4(a)) ?? (addresses[0] as string);
  }

  return {
    async request(req) {
      let url: URL;
      try {
        url = new URL(req.url);
      } catch {
        throw new OutboundError("invalid_url", "The URL is not valid.");
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new OutboundError("invalid_url", "Only http and https URLs are allowed.");
      }
      const address = await vet(url);
      const family = net.isIPv6(address) ? 6 : 4;
      const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const client = url.protocol === "https:" ? https : http;

      return new Promise<OutboundResponse>((resolvePromise, reject) => {
        const request = client.request(
          url,
          {
            method: req.method,
            headers: {
              "user-agent": userAgent,
              ...(req.body === undefined
                ? {}
                : { "content-length": String(Buffer.byteLength(req.body)) }),
              ...req.headers,
            },
            /* Pin the connection to the vetted address; TLS still verifies the hostname. */
            lookup: (_host, opts, callback) => {
              const all = (opts as { all?: boolean }).all === true;
              if (all) {
                (callback as (e: null, a: LookupAddress[]) => void)(null, [{ address, family }]);
              } else {
                (callback as (e: null, a: string, f: number) => void)(null, address, family);
              }
            },
            timeout: timeoutMs,
          },
          (response) => {
            const chunks: Buffer[] = [];
            let size = 0;
            const limit = req.maxBodyBytes ?? maxBody;
            response.on("data", (chunk: Buffer) => {
              if (req.maxBodyBytes !== undefined && size + chunk.length > limit) {
                reject(
                  new OutboundError("too_large", `The response is larger than ${limit} bytes.`),
                );
                response.destroy();
                return;
              }
              if (size >= limit) return;
              chunks.push(chunk.subarray(0, limit - size));
              size += chunk.length;
            });
            response.on("end", () => {
              resolvePromise({
                status: response.statusCode ?? 0,
                headers: response.headers,
                body: Buffer.concat(chunks).toString("utf8"),
              });
            });
            response.on("error", (err) =>
              reject(new OutboundError("network", `Reading the response failed: ${err.message}`)),
            );
          },
        );
        const deadline = setTimeout(() => {
          request.destroy(new OutboundError("timeout", `No response within ${timeoutMs} ms.`));
        }, timeoutMs);
        request.on("timeout", () => {
          request.destroy(new OutboundError("timeout", `No response within ${timeoutMs} ms.`));
        });
        request.on("error", (err) => {
          clearTimeout(deadline);
          reject(err instanceof OutboundError ? err : new OutboundError("network", err.message));
        });
        request.on("close", () => clearTimeout(deadline));
        if (req.body !== undefined) request.write(req.body);
        request.end();
      });
    },
  };
}
