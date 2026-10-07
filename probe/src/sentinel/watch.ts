/*
 * What the sentinel does each round (PRODUCT.md §13): look at every target, then decide who must be
 * told. Looking is one HTTP request per target; deciding is a pure function of the previous state
 * and what was seen, so every rule below is tested without a network or a clock.
 *
 * Rules:
 *  - A target that answers with a failure (our API saying "not ready", a 5xx) is down: page at once.
 *  - A target that doesn't answer at all may be our own network: page on the second miss in a row.
 *  - While it stays down the page is repeated every `repeatMs`.
 *  - When it is back, say so once.
 *  - Warnings in the readiness answer (a region without a healthy probe) are a notice, not a page:
 *    sent when they appear or change, and once when they clear.
 */
import type { SentinelTarget } from "./config.js";

export interface Observation {
  target: string;
  ok: boolean;
  /* True when the target itself answered that something is wrong; false when nothing answered. */
  answered: boolean;
  /* What is wrong, in a few words; empty when ok. */
  detail: string;
  /* Readiness warnings by name; empty for other targets. */
  warnings: string[];
}

export interface TargetState {
  down: boolean;
  /* Checks failed in a row, counting this one. */
  misses: number;
  downSince: number | null;
  /* When the founders were last paged about this outage; null when they haven't been. */
  pagedAt: number | null;
  detail: string;
  warnings: string[];
}

export type SentinelState = Record<string, TargetState>;

export interface Message {
  /* A page wakes people up (Telegram and SMS); a notice is Telegram only. */
  level: "page" | "notice";
  target: string;
  text: string;
}

/* Misses in a row before a target that doesn't answer is called down. */
export const SILENT_MISSES = 2;

const FRESH: TargetState = {
  down: false,
  misses: 0,
  downSince: null,
  pagedAt: null,
  detail: "",
  warnings: [],
};

const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));

export function decide(
  previous: SentinelState,
  observations: readonly Observation[],
  now: number,
  options: { repeatMs: number },
): { state: SentinelState; messages: Message[] } {
  const state: SentinelState = {};
  const messages: Message[] = [];
  for (const seen of observations) {
    const before = previous[seen.target] ?? FRESH;
    if (seen.ok) {
      if (before.pagedAt !== null) {
        const outage =
          before.downSince === null ? "" : ` after ${minutes(now - before.downSince)} min`;
        messages.push({
          level: "page",
          target: seen.target,
          text: `RECOVERED: ${seen.target} is working again${outage}.`,
        });
      }
      const changed = seen.warnings.join("; ") !== before.warnings.join("; ");
      if (changed) {
        messages.push({
          level: "notice",
          target: seen.target,
          text:
            seen.warnings.length > 0
              ? `Warning for ${seen.target}: ${seen.warnings.join("; ")}.`
              : `${seen.target}: the warnings have cleared.`,
        });
      }
      state[seen.target] = { ...FRESH, warnings: seen.warnings };
      continue;
    }

    const misses = before.misses + 1;
    const downSince = before.downSince ?? now;
    const confirmed = seen.answered || misses >= SILENT_MISSES;
    let pagedAt = before.pagedAt;
    if (confirmed && pagedAt === null) {
      pagedAt = now;
      messages.push({
        level: "page",
        target: seen.target,
        text: `DOWN: ${seen.target}. ${seen.detail}`,
      });
    } else if (pagedAt !== null && now - pagedAt >= options.repeatMs) {
      pagedAt = now;
      messages.push({
        level: "page",
        target: seen.target,
        text: `STILL DOWN (${minutes(now - downSince)} min): ${seen.target}. ${seen.detail}`,
      });
    }
    state[seen.target] = {
      down: confirmed,
      misses,
      downSince,
      pagedAt,
      detail: seen.detail,
      /* Warnings can't be read while the target fails; keep the last known ones. */
      warnings: before.warnings,
    };
  }
  return { state, messages };
}

/* A page that reached nobody is owed: forget it was sent, so the next round sends it again. */
export function owePage(state: SentinelState, target: string): SentinelState {
  const current = state[target];
  if (current === undefined) return state;
  return { ...state, [target]: { ...current, pagedAt: null } };
}

interface ReadyBody {
  status?: unknown;
  checks?: Record<string, { ok?: unknown; error?: unknown }>;
  warnings?: Record<string, unknown>;
}

/* One look at one target. Never throws. */
export async function observe(
  target: SentinelTarget,
  options: { fetch: typeof fetch; timeoutMs: number },
): Promise<Observation> {
  const base = { target: target.name, warnings: [] as string[] };
  let res: Response;
  try {
    res = await options.fetch(target.url, {
      method: "GET",
      redirect: "follow",
      headers: { "user-agent": "watchpost-sentinel" },
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (err) {
    const reason =
      err instanceof Error && err.name === "TimeoutError"
        ? `No answer within ${Math.round(options.timeoutMs / 1_000)} s.`
        : "It can't be reached.";
    return { ...base, ok: false, answered: false, detail: reason };
  }

  if (target.kind === "ready") {
    const body = (await res.json().catch(() => null)) as ReadyBody | null;
    const warnings = Object.entries(body?.warnings ?? {}).map(
      ([name, text]) => `${name}: ${typeof text === "string" ? text : "failing"}`,
    );
    if (res.ok) return { ...base, ok: true, answered: true, detail: "", warnings };
    const failing = Object.entries(body?.checks ?? {})
      .filter(([, check]) => check.ok === false)
      .map(([name, check]) =>
        typeof check.error === "string" ? `${name} (${check.error})` : name,
      );
    return {
      ...base,
      ok: false,
      /* A gateway error page is our proxy talking, not the API: it still means "down". */
      answered: true,
      detail:
        failing.length > 0
          ? `Not ready: ${failing.join(", ")}.`
          : `It answered HTTP ${res.status}.`,
    };
  }

  /* Drain the body so the connection can be reused. */
  await res.arrayBuffer().catch(() => undefined);
  return res.ok
    ? { ...base, ok: true, answered: true, detail: "" }
    : { ...base, ok: false, answered: true, detail: `It answered HTTP ${res.status}.` };
}
