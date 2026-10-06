/* Latency histograms merge exactly and estimate percentiles within one bucket. */
import { describe, expect, it } from "vitest";
import {
  HISTOGRAM_SIZE,
  LATENCY_BOUNDS_MS,
  bucketOf,
  emptyHistogram,
  mergeHistograms,
  percentile,
} from "../histogram.js";

const histogramOf = (latencies: number[]) => {
  const h = emptyHistogram();
  for (const l of latencies) h[bucketOf(l)]! += 1;
  return h;
};

describe("latency histogram", () => {
  it("puts each latency in the bucket below its upper bound", () => {
    expect(bucketOf(0)).toBe(0);
    expect(bucketOf(1)).toBe(1);
    expect(bucketOf(99)).toBe(LATENCY_BOUNDS_MS.indexOf(100));
    expect(bucketOf(100)).toBe(LATENCY_BOUNDS_MS.indexOf(150));
    expect(bucketOf(120_000)).toBe(HISTOGRAM_SIZE - 1);
  });

  it("merging histograms equals building one from all samples", () => {
    const a = [12, 48, 51, 230, 980];
    const b = [3, 75, 76, 4_100];
    expect(mergeHistograms([histogramOf(a), histogramOf(b)])).toEqual(histogramOf([...a, ...b]));
  });

  it("estimates percentiles inside the right bucket", () => {
    /* 100 samples: 90 fast (40–49 ms), 9 slow (300–399 ms), 1 very slow (2.5 s). */
    const samples = [
      ...Array.from({ length: 90 }, (_, i) => 40 + (i % 10)),
      ...Array.from({ length: 9 }, (_, i) => 300 + i * 10),
      2_500,
    ];
    const h = histogramOf(samples);
    const p50 = percentile(h, 0.5) ?? 0;
    const p95 = percentile(h, 0.95) ?? 0;
    const p99 = percentile(h, 0.99) ?? 0;
    expect(p50).toBeGreaterThanOrEqual(40);
    expect(p50).toBeLessThan(50);
    expect(p95).toBeGreaterThanOrEqual(300);
    expect(p95).toBeLessThan(400);
    expect(p99).toBeGreaterThanOrEqual(300);
    expect(p99).toBeLessThanOrEqual(400);
    expect(percentile(h, 1)).toBeGreaterThanOrEqual(2_000);
    expect(percentile(emptyHistogram(), 0.5)).toBeNull();
  });
});
