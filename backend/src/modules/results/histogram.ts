/*
 * Fixed log-scale latency buckets (PRODUCT.md §9.9). Every rollup keeps a count per bucket, so hourly
 * and daily rollups are plain element-wise sums and percentiles stay mergeable across regions and
 * time. Bucket i holds latencies in [BOUNDS[i-1], BOUNDS[i]) ms; the last bucket is open-ended.
 */

/* Upper bounds in ms, roughly 1.5× apart; 30 bounds + 1 overflow bucket. */
export const LATENCY_BOUNDS_MS = [
  1, 2, 3, 5, 7, 10, 15, 20, 30, 40, 50, 75, 100, 150, 200, 300, 400, 500, 750, 1_000, 1_500, 2_000,
  3_000, 4_000, 5_000, 7_500, 10_000, 15_000, 20_000, 30_000,
] as const;

export const HISTOGRAM_SIZE = LATENCY_BOUNDS_MS.length + 1;

export function bucketOf(latencyMs: number): number {
  const i = LATENCY_BOUNDS_MS.findIndex((bound) => latencyMs < bound);
  return i === -1 ? LATENCY_BOUNDS_MS.length : i;
}

export function emptyHistogram(): number[] {
  return new Array<number>(HISTOGRAM_SIZE).fill(0);
}

export function mergeHistograms(histograms: ReadonlyArray<readonly number[]>): number[] {
  const merged = emptyHistogram();
  for (const h of histograms) for (let i = 0; i < HISTOGRAM_SIZE; i += 1) merged[i]! += h[i] ?? 0;
  return merged;
}

/*
 * Estimated latency at quantile `q` (0–1), interpolating linearly inside the bucket that holds it.
 * The open-ended last bucket reports its lower bound. Null for an empty histogram.
 */
export function percentile(histogram: readonly number[], q: number): number | null {
  const total = histogram.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const rank = Math.max(1, Math.ceil(q * total));
  let seen = 0;
  for (let i = 0; i < histogram.length; i += 1) {
    const count = histogram[i] ?? 0;
    if (count === 0) continue;
    if (seen + count >= rank) {
      const lower = i === 0 ? 0 : (LATENCY_BOUNDS_MS[i - 1] ?? 0);
      const upper = LATENCY_BOUNDS_MS[i];
      if (upper === undefined) return lower;
      const within = (rank - seen) / count;
      return Math.round((lower + (upper - lower) * within) * 10) / 10;
    }
    seen += count;
  }
  return null;
}
