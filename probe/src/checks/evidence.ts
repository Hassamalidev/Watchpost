/*
 * What a probe keeps of a response it didn't like (PRODUCT.md §9.1, P2-T04): the allowlisted headers
 * and the start of a text body. Attached to failed results only, and only where it tells something
 * new: the first failures of a streak and then every twentieth, so a monitor that stays down for a
 * day doesn't store the same error page thousands of times.
 */
import {
  EVIDENCE_BODY_MAX_CHARS,
  pickEvidenceHeaders,
  type CheckEvidence,
  type CheckResult,
} from "@app/shared";
import type { HttpResponse } from "../net/http-client.js";

/* Content types whose first characters a person can read. */
const TEXT_TYPE =
  /^(text\/|application\/(json|xml|xhtml\+xml|javascript|problem\+json|ld\+json|x-www-form-urlencoded)|[\w.-]+\/[\w.-]+\+(json|xml))/i;
/* Control characters that would garble a log line or a terminal; newlines and tabs stay. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function looksLikeText(sample: Buffer): boolean {
  /* A NUL byte or invalid UTF-8 near the start means binary. */
  if (sample.includes(0)) return false;
  return !sample.toString("utf8").includes("�");
}

export function evidenceOf(res: HttpResponse): CheckEvidence {
  const evidence: CheckEvidence = {
    headers: pickEvidenceHeaders(res.headers),
    bodyBytes: res.body.length,
  };
  if (res.body.length === 0) return evidence;

  const contentType = res.headers["content-type"];
  /* A few bytes more than the limit: enough for the snippet even with multi-byte characters. */
  const sample = res.body.subarray(0, EVIDENCE_BODY_MAX_CHARS * 4);
  const isText =
    contentType === undefined
      ? looksLikeText(sample.subarray(0, 512))
      : TEXT_TYPE.test(contentType);
  if (!isText) return evidence;

  const text = sample.toString("utf8").replace(CONTROL, "");
  const snippet = text.slice(0, EVIDENCE_BODY_MAX_CHARS);
  return {
    ...evidence,
    bodySnippet: snippet,
    bodyTruncated: res.truncated || res.body.length > sample.length || text.length > snippet.length,
  };
}

/* Consecutive failures that always carry evidence, and how often after that. */
export const EVIDENCE_FIRST_FAILURES = 3;
export const EVIDENCE_EVERY = 20;
const MAX_TRACKED = 50_000;

/*
 * Decides per result whether its evidence is worth sending. Task results (verification, "Test now")
 * always keep it: they are the ones incidents are opened on and people look at.
 */
export function createEvidenceLimiter() {
  const failures = new Map<string, number>();
  return {
    apply(result: CheckResult): CheckResult {
      if (result.ok) {
        failures.delete(result.monitorId);
        return result;
      }
      if (result.evidence === undefined || result.taskId !== undefined) return result;
      if (failures.size >= MAX_TRACKED && !failures.has(result.monitorId)) failures.clear();
      const count = (failures.get(result.monitorId) ?? 0) + 1;
      failures.set(result.monitorId, count);
      if (count <= EVIDENCE_FIRST_FAILURES || count % EVIDENCE_EVERY === 0) return result;
      const { evidence: _evidence, ...rest } = result;
      return rest;
    },
  };
}
