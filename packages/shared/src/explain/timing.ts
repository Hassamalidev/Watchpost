/*
 * The key timing of a failed check in one line (PRODUCT.md §4 pillar 2, P2-T04): how long it took and
 * where the time went. Alerts and the incident page show the same sentence. Pure and dependency-free.
 */

export const TIMING_PHASES = ["dns", "connect", "tls", "ttfb", "download"] as const;
export type TimingPhase = (typeof TIMING_PHASES)[number];

export type PhaseTimings = Partial<Record<TimingPhase, number | undefined>> & {
  total?: number | undefined;
};

const PHASE_LABEL: Record<TimingPhase, string> = {
  dns: "DNS lookup",
  connect: "connecting",
  tls: "TLS handshake",
  ttfb: "waiting for the first byte",
  download: "downloading the response",
};

/* 412 ms, 9.8 s, 61 s. */
export function formatMs(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 10_000) return `${(ms / 1_000).toFixed(1)} s`;
  return `${Math.round(ms / 1_000)} s`;
}

/* The phase that took longest, when the probe timed at least two phases. */
export function slowestPhase(
  timings: PhaseTimings | null | undefined,
): { phase: TimingPhase; ms: number } | null {
  if (timings === null || timings === undefined) return null;
  const measured = TIMING_PHASES.flatMap((phase) => {
    const ms = timings[phase];
    return typeof ms === "number" ? [{ phase, ms }] : [];
  });
  if (measured.length < 2) return null;
  return measured.reduce((slowest, next) => (next.ms > slowest.ms ? next : slowest));
}

/*
 * "Answered in 412 ms; slowest step: waiting for the first byte (380 ms)" for a response we didn't
 * like, "Failed after 10 s" when there was no response. Null when nothing was timed.
 */
export function describeTiming(input: {
  latencyMs?: number | null | undefined;
  timings?: PhaseTimings | null | undefined;
  /* True when the server answered (there is an HTTP status), false when the request itself failed. */
  answered: boolean;
}): string | null {
  const total = input.timings?.total ?? input.latencyMs ?? 0;
  if (!(total > 0)) return null;
  const head = `${input.answered ? "Answered in" : "Failed after"} ${formatMs(total)}`;
  const slowest = slowestPhase(input.timings);
  return slowest === null
    ? head
    : `${head}; slowest step: ${PHASE_LABEL[slowest.phase]} (${formatMs(slowest.ms)})`;
}

/* The same sentence from what an incident keeps about its first failure. */
export function describeEvidenceTiming(
  evidence: Record<string, unknown> | null | undefined,
): string | null {
  if (evidence === null || evidence === undefined) return null;
  const timings =
    typeof evidence.timings === "object" && evidence.timings !== null
      ? (evidence.timings as PhaseTimings)
      : null;
  return describeTiming({
    latencyMs: typeof evidence.latencyMs === "number" ? evidence.latencyMs : null,
    timings,
    answered: typeof evidence.httpStatus === "number",
  });
}
