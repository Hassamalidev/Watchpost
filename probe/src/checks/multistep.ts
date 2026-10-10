/*
 * Multi-step API checks (PRODUCT.md §6.1): requests run one after another through the SSRF-safe
 * client. A step can take values out of its response (a token, an ID) for later steps to use as
 * {{name}}, and assert on its JSON body. The first step that fails ends the check and names itself.
 * Secrets and extracted values never leave the probe: they are struck out of messages and evidence.
 */
import jsonata from "jsonata";
import {
  isAcceptedStatus,
  renderTemplate,
  type CheckErrorCode,
  type CheckEvidence,
  type MonitorConfig,
} from "@app/shared";
import type { CheckContext, CheckOutcome } from "../executor/executor.js";
import { CheckError } from "../net/errors.js";
import { httpRequest, type HttpResponse } from "../net/http-client.js";
import { evidenceOf } from "./evidence.js";
import { compare } from "./http.js";

type Multistep = Extract<MonitorConfig, { type: "multistep" }>;
type Step = Multistep["steps"][number];

/* Values shorter than this are too common in ordinary text to strike out ("1", "true"). */
const MIN_REDACTED_LENGTH = 6;
const STRUCK = "***";

interface StepRecord {
  name: string;
  status?: number;
  ms: number;
}

/* What a JSONata result looks like as a variable. */
function asVariable(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export async function runMultistep(
  config: MonitorConfig,
  ctx: CheckContext,
): Promise<CheckOutcome> {
  if (config.type !== "multistep") throw new Error("runMultistep got a non-multistep config");
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const variables: Record<string, string> = {};
  const sensitive = new Set<string>();
  for (const secret of config.secrets) {
    variables[secret.name] = secret.value;
    sensitive.add(secret.value);
  }
  const redact = (text: string): string => {
    let out = text;
    for (const value of sensitive) {
      if (value.length >= MIN_REDACTED_LENGTH) out = out.split(value).join(STRUCK);
    }
    return out;
  };
  const redactEvidence = (evidence: CheckEvidence): CheckEvidence => ({
    ...evidence,
    headers: Object.fromEntries(
      Object.entries(evidence.headers ?? {}).map(([name, value]) => [name, redact(value)]),
    ),
    ...(evidence.bodySnippet === undefined ? {} : { bodySnippet: redact(evidence.bodySnippet) }),
  });

  const done: StepRecord[] = [];
  let last: HttpResponse | undefined;

  const fail = (
    index: number,
    step: Step,
    code: CheckErrorCode,
    message: string,
    res?: HttpResponse,
  ): CheckOutcome => ({
    ok: false,
    errorCode: code,
    message: redact(`Step ${index + 1} "${step.name}": ${message}`).slice(0, 500),
    latencyMs: elapsed(),
    ...(res === undefined
      ? {}
      : { httpStatus: res.status, ip: res.ip, evidence: redactEvidence(evidenceOf(res)) }),
    details: { steps: done, failedStep: index + 1 },
  });

  for (const [index, step] of config.steps.entries()) {
    const remaining = ctx.timeoutMs - elapsed();
    if (remaining <= 0) {
      return fail(index, step, "response_timeout", "the check ran out of time before this step");
    }
    const stepStarted = performance.now();
    let res: HttpResponse;
    try {
      res = await httpRequest({
        url: renderTemplate(step.url, variables),
        method: step.method,
        headers: step.headers.map((h) => ({
          name: h.name,
          value: renderTemplate(h.value, variables),
        })),
        ...(step.body !== undefined ? { body: renderTemplate(step.body, variables) } : {}),
        timeoutMs: remaining,
        followRedirects: config.followRedirects,
        ignoreTlsErrors: config.ignoreTlsErrors,
        policy: ctx.policy,
        signal: ctx.signal,
        ...(ctx.ca ? { ca: ctx.ca } : {}),
      });
    } catch (err) {
      done.push({ name: step.name, ms: Math.round(performance.now() - stepStarted) });
      if (err instanceof CheckError) return fail(index, step, err.code, err.message);
      throw err;
    }
    last = res;
    done.push({ name: step.name, status: res.status, ms: res.timings.total });

    if (!isAcceptedStatus(res.status, step.acceptedStatusCodes)) {
      return fail(
        index,
        step,
        "http_status_unexpected",
        `HTTP ${res.status} (expected ${step.acceptedStatusCodes.join(", ")})`,
        res,
      );
    }

    /* The body is read as JSON only when something asks for it. */
    const needsJson =
      step.assertions.length > 0 || step.extract.some((extract) => extract.from === "body");
    let data: unknown;
    if (needsJson) {
      if (res.truncated) {
        return fail(index, step, "body_too_large", "response is over 1 MB; JSON not read", res);
      }
      try {
        data = JSON.parse(res.body.toString("utf8"));
      } catch (err) {
        return fail(index, step, "json_invalid", `invalid JSON: ${(err as Error).message}`, res);
      }
    }

    for (const extract of step.extract) {
      let value: string | undefined;
      if (extract.from === "header") {
        value = res.headers[extract.expression.toLowerCase()];
      } else {
        try {
          value = asVariable(await jsonata(extract.expression).evaluate(data));
        } catch (err) {
          return fail(
            index,
            step,
            "json_query_failed",
            `can't read "${extract.name}": ${(err as { message?: string }).message ?? String(err)}`,
            res,
          );
        }
      }
      if (value === undefined) {
        return fail(
          index,
          step,
          "json_query_failed",
          extract.from === "header"
            ? `no "${extract.expression}" header to take "${extract.name}" from`
            : `${extract.expression} found nothing to take "${extract.name}" from`,
          res,
        );
      }
      variables[extract.name] = value;
      sensitive.add(value);
    }

    for (const assertion of step.assertions) {
      const expected = renderTemplate(assertion.expected, variables);
      let actual: unknown;
      let matched: boolean;
      try {
        actual = await jsonata(assertion.expression).evaluate(data);
        matched = await compare(actual, assertion.operator, expected);
      } catch (err) {
        return fail(
          index,
          step,
          "json_query_failed",
          `expression error: ${(err as { message?: string }).message ?? String(err)}`,
          res,
        );
      }
      if (!matched) {
        return fail(
          index,
          step,
          "json_query_failed",
          `${assertion.expression} was ${JSON.stringify(actual) ?? "undefined"}, expected ${assertion.operator} ${JSON.stringify(expected)}`,
          res,
        );
      }
    }
  }

  return {
    ok: true,
    latencyMs: elapsed(),
    ...(last === undefined
      ? {}
      : { httpStatus: last.status, ip: last.ip, ...(last.tls ? { tls: last.tls } : {}) }),
    details: { steps: done },
  };
}
