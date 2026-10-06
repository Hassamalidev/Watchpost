/*
 * Shared HTTP plumbing for adapters: every request goes through the SSRF-safe outbound client, and
 * failures become ChannelDeliveryError, permanent when retrying can't help (blocked URL, a webhook
 * that was deleted, a revoked token).
 */
import {
  OutboundError,
  type OutboundHttp,
  type OutboundRequest,
  type OutboundResponse,
} from "../../../infra/http/outbound.js";
import { ChannelDeliveryError } from "../types/adapter.js";

export async function call(
  http: OutboundHttp,
  req: OutboundRequest,
  label: string,
): Promise<OutboundResponse> {
  try {
    return await http.request(req);
  } catch (err) {
    if (err instanceof OutboundError) {
      const permanent = err.code === "blocked" || err.code === "invalid_url";
      throw new ChannelDeliveryError(`${label}: ${err.message}`, permanent);
    }
    throw new ChannelDeliveryError(`${label}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/* Throws unless the status is 2xx; `permanentStatuses` won't be retried. */
export function expectOk(
  res: OutboundResponse,
  label: string,
  permanentStatuses: readonly number[],
): void {
  if (res.status >= 200 && res.status < 300) return;
  const detail = res.body.trim().slice(0, 200);
  throw new ChannelDeliveryError(
    `${label} answered HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
    permanentStatuses.includes(res.status),
  );
}

export function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

export const STATE_COLORS = {
  triggered: 0xe5484d,
  reminder: 0xe5484d,
  flapping: 0xf5a524,
  acknowledged: 0xf5a524,
  resolved: 0x30a46c,
  test: 0x3e63dd,
} as const;

/* POSTs JSON and returns the response; statuses in `permanentStatuses` stop retries. */
export async function postJson(
  http: OutboundHttp,
  options: {
    url: string;
    body: unknown;
    label: string;
    headers?: Record<string, string>;
    permanentStatuses: readonly number[];
    method?: "POST" | "PUT";
  },
): Promise<OutboundResponse> {
  const res = await call(
    http,
    {
      method: options.method ?? "POST",
      url: options.url,
      headers: { "content-type": "application/json", ...options.headers },
      body: JSON.stringify(options.body),
    },
    options.label,
  );
  expectOk(res, options.label, options.permanentStatuses);
  return res;
}

/* `https://host/base/` + `/path` → `https://host/base/path`, whatever slashes the base ends with. */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
