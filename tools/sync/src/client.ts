/*
 * The few calls of the public API (/api/v1, docs/api.md) the sync needs. `fetch` is passed in, so
 * tests run against a stand-in. A 429 waits as long as the API says and tries again.
 */
import type { MonitorBody, RemoteMonitor } from "./plan.js";

export type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const MAX_WAITS = 5;

export function createClient(options: {
  baseUrl: string;
  apiKey: string;
  fetch: Fetch;
  sleep?: (ms: number) => Promise<void>;
}) {
  const base = `${options.baseUrl.replace(/\/+$/, "")}/api/v1`;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function call<T>(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    for (let waits = 0; ; waits += 1) {
      const res = await options.fetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (res.status === 429 && waits < MAX_WAITS) {
        const seconds = Number(res.headers.get("retry-after") ?? "5");
        await sleep(Math.min(Math.max(Number.isFinite(seconds) ? seconds : 5, 1), 60) * 1_000);
        continue;
      }
      const text = await res.text();
      const data: unknown = text === "" ? undefined : JSON.parse(text);
      if (res.status < 200 || res.status >= 300) {
        const problem = (data ?? {}) as {
          detail?: string;
          title?: string;
          errors?: Array<{ path: string; message: string }>;
        };
        const fields = (problem.errors ?? []).map((e) => `${e.path}: ${e.message}`).join("; ");
        throw new ApiError(
          res.status,
          `${method} ${path} answered ${res.status}: ${problem.detail ?? problem.title ?? "no detail"}${fields ? ` (${fields})` : ""}`,
        );
      }
      return data as T;
    }
  }

  return {
    async me(): Promise<{ workspaceName: string; scopes: string[] }> {
      return call("GET", "/me");
    },
    /* Every monitor of the workspace, page by page. */
    async monitors(): Promise<RemoteMonitor[]> {
      const all: RemoteMonitor[] = [];
      let cursor: string | null = null;
      do {
        const page: { data: RemoteMonitor[]; nextCursor: string | null } = await call(
          "GET",
          `/monitors?limit=200${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
        );
        all.push(...page.data);
        cursor = page.nextCursor;
      } while (cursor !== null);
      return all;
    },
    /* The key makes a create safe to repeat when a run is interrupted and started again. */
    create: (body: MonitorBody, idempotencyKey: string) =>
      call<RemoteMonitor>("POST", "/monitors", body, idempotencyKey),
    update: (id: string, body: MonitorBody) =>
      call<RemoteMonitor>("PATCH", `/monitors/${id}`, body),
    setPaused: (id: string, paused: boolean) =>
      call<RemoteMonitor>("POST", `/monitors/${id}/${paused ? "pause" : "resume"}`),
    remove: (id: string) => call<undefined>("DELETE", `/monitors/${id}`),
  };
}

export type Client = ReturnType<typeof createClient>;
