/* The probe health guard's rule (PRODUCT.md §9.2): max(30%, 3× baseline) over at least 50 monitors. */
import { describe, expect, it } from "vitest";
import { batchLooksBroken, overThreshold } from "../guard.js";

describe("five-minute rule", () => {
  it("needs at least 50 monitors", () => {
    expect(overThreshold({ monitors: 49, failing: 49, baselineRatio: 0 })).toBe(false);
    expect(overThreshold({ monitors: 50, failing: 50, baselineRatio: 0 })).toBe(true);
  });

  it("triggers above 30% when the probe usually fails little", () => {
    expect(overThreshold({ monitors: 100, failing: 30, baselineRatio: 0.01 })).toBe(false);
    expect(overThreshold({ monitors: 100, failing: 31, baselineRatio: 0.01 })).toBe(true);
  });

  it("allows three times the usual rate when that is more than 30%", () => {
    /* A probe whose monitors fail 15% of the time anyway: the line is 45%. */
    expect(overThreshold({ monitors: 100, failing: 40, baselineRatio: 0.15 })).toBe(false);
    expect(overThreshold({ monitors: 100, failing: 46, baselineRatio: 0.15 })).toBe(true);
  });
});

describe("batch rule", () => {
  it("is for batches that fail nearly everything, not small or mixed ones", () => {
    expect(batchLooksBroken({ monitors: 19, failing: 19 })).toBe(false);
    expect(batchLooksBroken({ monitors: 20, failing: 17 })).toBe(false);
    expect(batchLooksBroken({ monitors: 20, failing: 18 })).toBe(true);
    expect(batchLooksBroken({ monitors: 100, failing: 100 })).toBe(true);
  });
});
