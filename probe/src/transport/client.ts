/*
 * Signed HTTPS client for the probe protocol. Every call is signed over the exact bytes sent; responses
 * are validated with the shared Zod schemas. Network failures and 5xx become ApiUnavailableError so
 * callers can buffer and retry; 4xx become ApiRejectedError (a bug or a bad credential, not an outage).
 */
import type { z } from "zod";
import { PROBE_API_PREFIX } from "@app/shared";
import { signRequest } from "./signer.js";

export class ApiUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ApiUnavailableError";
  }
}

export class ApiRejectedError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiRejectedError";
  }
}

export interface ProbeClientOptions {
  apiUrl: string;
  probeId: string;
  secret: string;
  now?: () => number;
  /* Per-request timeout; long-polls pass a longer one. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface ProbeClient {
  request<S extends z.ZodType>(
    method: "GET" | "POST",
    path: string,
    options: { body?: unknown; schema: S; timeoutMs?: number },
  ): Promise<z.infer<S>>;
}

export function createProbeClient(options: ProbeClientOptions): ProbeClient {
  const now = options.now ?? Date.now;
  const doFetch = options.fetch ?? fetch;

  return {
    async request(method, path, { body, schema, timeoutMs }) {
      const fullPath = `${PROBE_API_PREFIX}${path}`;
      const payload = body === undefined ? "" : JSON.stringify(body);
      const signPath = fullPath.split("?")[0] ?? fullPath;
      const headers: Record<string, string> = {
        ...signRequest({
          probeId: options.probeId,
          secret: options.secret,
          method,
          path: signPath,
          body: payload,
          nowMs: now(),
        }),
        accept: "application/json",
      };
      if (body !== undefined) headers["content-type"] = "application/json";

      let response: Response;
      try {
        response = await doFetch(`${options.apiUrl}${fullPath}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body: payload }),
          signal: AbortSignal.timeout(timeoutMs ?? options.timeoutMs ?? 10_000),
        });
      } catch (err) {
        throw new ApiUnavailableError(`${method} ${path} failed: ${(err as Error).message}`, {
          cause: err,
        });
      }
      const text = await response.text();
      if (response.status >= 500 || response.status === 429) {
        throw new ApiUnavailableError(`${method} ${path} returned ${response.status}`);
      }
      if (response.status >= 400) {
        throw new ApiRejectedError(
          response.status,
          `${method} ${path} returned ${response.status}: ${text.slice(0, 300)}`,
        );
      }
      const parsed = schema.safeParse(text === "" ? {} : JSON.parse(text));
      if (!parsed.success) {
        throw new ApiRejectedError(
          response.status,
          `${method} ${path}: unexpected response (${parsed.error.message})`,
        );
      }
      return parsed.data;
    },
  };
}
