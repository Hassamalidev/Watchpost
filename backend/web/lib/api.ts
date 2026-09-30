/*
 * The one typed API client (PRODUCT.md §7.10). Same-origin `/api/*` with cookies; RFC 9457 problem
 * responses become ApiError with the field errors, so forms can show them next to their inputs.
 */
export interface FieldError {
  path: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fieldErrors: FieldError[] = [],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export async function api<T>(
  path: string,
  options: { method?: Method; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const res = await fetch(path, {
    method: options.method ?? "GET",
    credentials: "include",
    headers: options.body === undefined ? {} : { "content-type": "application/json" },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data: unknown = text === "" ? undefined : safeJson(text);
  if (!res.ok) {
    const problem = (data ?? {}) as {
      code?: string;
      detail?: string;
      message?: string;
      errors?: FieldError[];
    };
    throw new ApiError(
      res.status,
      problem.code ?? String(res.status),
      problem.detail ?? problem.message ?? `Request failed (${res.status})`,
      problem.errors ?? [],
    );
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/* Workspace-scoped paths: `/api/w/<id>/…`. */
export const wsPath = (workspaceId: string, path: string) =>
  `/api/w/${encodeURIComponent(workspaceId)}${path}`;

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : "Something went wrong.";
}
