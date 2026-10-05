/*
 * Probe health guard (PRODUCT.md §9.2): when one of our probes suddenly fails most of what it checks,
 * the problem is far more likely ours (its network, its host) than a simultaneous outage of dozens of
 * unrelated customers. Such a probe is quarantined: its failures stop counting, verification goes to
 * other regions, and ops are told. Rule 13: when in doubt, don't page.
 */

/* The rule needs enough monitors to mean something. */
export const GUARD_MIN_MONITORS = 50;
export const GUARD_MIN_RATIO = 0.3;
export const GUARD_BASELINE_FACTOR = 3;
/* How far back "now" looks, and what it is compared with. */
export const GUARD_WINDOW_MS = 5 * 60_000;
export const GUARD_BASELINE_MS = 24 * 60 * 60_000;
/* How long failures from a quarantined probe are ignored; renewed while the rule still holds. */
export const QUARANTINE_MS = 10 * 60_000;
/*
 * One batch that fails nearly everything is quarantined at once, before any of it is evaluated:
 * waiting for the window to fill would let the first monitors open incidents.
 */
export const GUARD_BATCH_MIN_MONITORS = 20;
export const GUARD_BATCH_RATIO = 0.9;
/* A probe that reported within the last day is one we check from; older ones are retired. */
export const SERVED_WINDOW_MS = 24 * 60 * 60_000;
/* Twice the health timeout, so one slow heartbeat doesn't raise a notice. */
export const SILENT_AFTER_MS = 2 * 60_000;

export interface GuardStats {
  /* Monitors the probe reported on in the window, and those whose latest result from it failed. */
  monitors: number;
  failing: number;
  /* Share of its results that failed over the 24 hours before the window; 0 without history. */
  baselineRatio: number;
}

/* Failing more than max(30%, 3× its usual rate) of at least 50 monitors. */
export function overThreshold(stats: GuardStats): boolean {
  if (stats.monitors < GUARD_MIN_MONITORS) return false;
  const limit = Math.max(GUARD_MIN_RATIO, GUARD_BASELINE_FACTOR * stats.baselineRatio);
  return stats.failing / stats.monitors > limit;
}

export function batchLooksBroken(batch: { monitors: number; failing: number }): boolean {
  return (
    batch.monitors >= GUARD_BATCH_MIN_MONITORS &&
    batch.failing / batch.monitors >= GUARD_BATCH_RATIO
  );
}
