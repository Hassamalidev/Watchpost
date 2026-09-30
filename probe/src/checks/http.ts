/*
 * HTTP(S), keyword and JSON-query checks (PRODUCT.md §6.1). All three share one request through the
 * SSRF-safe client; keyword and JSON checks then inspect the (capped) body.
 */
import jsonata from "jsonata";
import { isAcceptedStatus, type MonitorConfig } from "@app/shared";
import { failure, type CheckContext, type CheckOutcome } from "../executor/executor.js";
import { CheckError } from "../net/errors.js";
import { httpRequest, type HttpResponse } from "../net/http-client.js";
import { RegexError, safeRegexTest } from "./safe-regex.js";

type HttpLike = Extract<MonitorConfig, { type: "http" | "keyword" | "json_query" }>;

function authHeader(config: HttpLike): Array<{ name: string; value: string }> {
  if (config.auth.kind === "basic") {
    const token = Buffer.from(`${config.auth.username}:${config.auth.password}`).toString("base64");
    return [{ name: "authorization", value: `Basic ${token}` }];
  }
  if (config.auth.kind === "bearer")
    return [{ name: "authorization", value: `Bearer ${config.auth.token}` }];
  return [];
}

function baseOutcome(res: HttpResponse): Omit<CheckOutcome, "ok"> {
  return {
    httpStatus: res.status,
    latencyMs: res.timings.total,
    timings: res.timings,
    ip: res.ip,
    ...(res.tls ? { tls: res.tls } : {}),
    details: {
      finalUrl: res.finalUrl,
      ...(res.redirects.length ? { redirects: res.redirects } : {}),
      ...(res.truncated ? { truncated: true } : {}),
    },
  };
}

async function request(config: HttpLike, ctx: CheckContext): Promise<HttpResponse | CheckOutcome> {
  try {
    return await httpRequest({
      url: config.url,
      method: config.method,
      headers: [...config.headers, ...authHeader(config)],
      ...(config.body !== undefined ? { body: config.body } : {}),
      timeoutMs: ctx.timeoutMs,
      followRedirects: config.followRedirects,
      ignoreTlsErrors: config.ignoreTlsErrors,
      policy: ctx.policy,
      signal: ctx.signal,
      ...(ctx.ca ? { ca: ctx.ca } : {}),
    });
  } catch (err) {
    if (err instanceof CheckError) return failure(err.code, err.message);
    throw err;
  }
}

function isOutcome(value: HttpResponse | CheckOutcome): value is CheckOutcome {
  return "ok" in value;
}

/* Status check shared by all HTTP-family monitors. */
function statusFailure(config: HttpLike, res: HttpResponse): CheckOutcome | undefined {
  if (isAcceptedStatus(res.status, config.acceptedStatusCodes)) return undefined;
  return {
    ...baseOutcome(res),
    ok: false,
    errorCode: "http_status_unexpected",
    message: `HTTP ${res.status} (expected ${config.acceptedStatusCodes.join(", ")})`,
  };
}

export async function runHttp(config: MonitorConfig, ctx: CheckContext): Promise<CheckOutcome> {
  if (config.type !== "http") throw new Error("runHttp got a non-HTTP config");
  const res = await request(config, ctx);
  if (isOutcome(res)) return res;
  return statusFailure(config, res) ?? { ...baseOutcome(res), ok: true };
}

export async function runKeyword(config: MonitorConfig, ctx: CheckContext): Promise<CheckOutcome> {
  if (config.type !== "keyword") throw new Error("runKeyword got a non-keyword config");
  const res = await request(config, ctx);
  if (isOutcome(res)) return res;
  const statusFail = statusFailure(config, res);
  if (statusFail) return statusFail;

  const text = res.body.toString("utf8");
  let found: boolean;
  try {
    found = config.isRegex
      ? await safeRegexTest(config.keyword, text, { caseSensitive: config.caseSensitive })
      : config.caseSensitive
        ? text.includes(config.keyword)
        : text.toLowerCase().includes(config.keyword.toLowerCase());
  } catch (err) {
    if (err instanceof RegexError)
      return { ...baseOutcome(res), ok: false, errorCode: "keyword_missing", message: err.message };
    throw err;
  }

  if (config.mode === "contains" && !found) {
    if (res.truncated) {
      return {
        ...baseOutcome(res),
        ok: false,
        errorCode: "body_too_large",
        message: `"${config.keyword}" not found in the first 1 MB of the response`,
      };
    }
    return {
      ...baseOutcome(res),
      ok: false,
      errorCode: "keyword_missing",
      message: `"${config.keyword}" not found`,
    };
  }
  if (config.mode === "not_contains" && found) {
    return {
      ...baseOutcome(res),
      ok: false,
      errorCode: "keyword_present",
      message: `"${config.keyword}" found`,
    };
  }
  return { ...baseOutcome(res), ok: true };
}

function compare(actual: unknown, operator: string, expected: string): Promise<boolean> | boolean {
  const asText = typeof actual === "string" ? actual : JSON.stringify(actual);
  const asNumber = Number(expected);
  switch (operator) {
    case "==":
      return typeof actual === "number" && !Number.isNaN(asNumber)
        ? actual === asNumber
        : asText === expected;
    case "!=":
      return typeof actual === "number" && !Number.isNaN(asNumber)
        ? actual !== asNumber
        : asText !== expected;
    case "<":
      return typeof actual === "number" && actual < asNumber;
    case ">":
      return typeof actual === "number" && actual > asNumber;
    case "contains":
      return Array.isArray(actual)
        ? actual.map(String).includes(expected)
        : asText.includes(expected);
    case "matches":
      return safeRegexTest(expected, asText, { caseSensitive: true });
    default:
      return false;
  }
}

export async function runJsonQuery(
  config: MonitorConfig,
  ctx: CheckContext,
): Promise<CheckOutcome> {
  if (config.type !== "json_query") throw new Error("runJsonQuery got a non-JSON-query config");
  const res = await request(config, ctx);
  if (isOutcome(res)) return res;
  const statusFail = statusFailure(config, res);
  if (statusFail) return statusFail;

  if (res.truncated) {
    return {
      ...baseOutcome(res),
      ok: false,
      errorCode: "body_too_large",
      message: "response is over 1 MB; JSON not evaluated",
    };
  }
  let data: unknown;
  try {
    data = JSON.parse(res.body.toString("utf8"));
  } catch (err) {
    return {
      ...baseOutcome(res),
      ok: false,
      errorCode: "json_invalid",
      message: `invalid JSON: ${(err as Error).message}`,
    };
  }
  let actual: unknown;
  try {
    actual = await jsonata(config.expression).evaluate(data);
  } catch (err) {
    return {
      ...baseOutcome(res),
      ok: false,
      errorCode: "json_query_failed",
      message: `expression error: ${(err as { message?: string }).message ?? String(err)}`,
    };
  }
  let matched: boolean;
  try {
    matched = await compare(actual, config.operator, config.expected);
  } catch (err) {
    return {
      ...baseOutcome(res),
      ok: false,
      errorCode: "json_query_failed",
      message: (err as Error).message,
    };
  }
  if (!matched) {
    return {
      ...baseOutcome(res),
      ok: false,
      errorCode: "json_query_failed",
      message:
        `${config.expression} was ${JSON.stringify(actual) ?? "undefined"}, expected ${config.operator} ${JSON.stringify(config.expected)}`.slice(
          0,
          500,
        ),
    };
  }
  return { ...baseOutcome(res), ok: true, details: { ...baseOutcome(res).details, value: actual } };
}
