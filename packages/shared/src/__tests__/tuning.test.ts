import { describe, expect, it } from "vitest";
import { noiseLevel, suggestTuning, type TuningSettings } from "../explain/tuning.js";

const base: TuningSettings = {
  regions: ["eu-central", "us-east"],
  minFailingRegions: 1,
  recoverySuccesses: 0,
  intervalSeconds: 300,
  timeoutMs: 10_000,
};
const quiet = { incidents: 1, falseAlarms: 0, flapping: 0, shortLived: 0 };

describe("alert tuning advisor", () => {
  it("suggests nothing for a quiet monitor", () => {
    expect(suggestTuning(quiet, base)).toEqual([]);
    expect(noiseLevel(quiet)).toBe(0);
  });

  it("asks for one more failing region when blips get through", () => {
    const [s] = suggestTuning({ incidents: 4, falseAlarms: 1, flapping: 0, shortLived: 2 }, base);
    expect(s).toMatchObject({ id: "confirm-more-regions", patch: { minFailingRegions: 2 } });
  });

  it("adds a launch region to single-region monitors instead", () => {
    const [s] = suggestTuning(
      { incidents: 3, falseAlarms: 2, flapping: 0, shortLived: 0 },
      { ...base, regions: ["eu-central"] },
    );
    expect(s).toMatchObject({
      id: "add-region",
      patch: { regions: ["eu-central", "us-east"], minFailingRegions: 2 },
    });
  });

  it("doesn't ask for more regions than the monitor has", () => {
    const ids = suggestTuning(
      { incidents: 3, falseAlarms: 3, flapping: 0, shortLived: 0 },
      { ...base, minFailingRegions: 2 },
    ).map((s) => s.id);
    expect(ids).not.toContain("confirm-more-regions");
  });

  it("requires more good checks for flapping monitors, from the effective default", () => {
    const fast = suggestTuning(
      { incidents: 2, falseAlarms: 0, flapping: 2, shortLived: 0 },
      { ...base, intervalSeconds: 60 },
    );
    expect(fast).toEqual([
      expect.objectContaining({ id: "longer-recovery", patch: { recoverySuccesses: 3 } }),
    ]);
    expect(
      suggestTuning(
        { incidents: 2, falseAlarms: 0, flapping: 2, shortLived: 0 },
        { ...base, recoverySuccesses: 3 },
      ),
    ).toEqual([]);
  });

  it("lengthens short timeouts, staying under the interval", () => {
    const noisy = { incidents: 3, falseAlarms: 0, flapping: 0, shortLived: 3 };
    const twoRequired = { ...base, minFailingRegions: 2 };
    expect(suggestTuning(noisy, { ...twoRequired, timeoutMs: 9_000 })).toEqual([
      expect.objectContaining({ id: "longer-timeout", patch: { timeoutMs: 18_000 } }),
    ]);
    expect(suggestTuning(noisy, { ...twoRequired, timeoutMs: 8_000, intervalSeconds: 15 })).toEqual(
      [expect.objectContaining({ id: "longer-timeout", patch: { timeoutMs: 14_000 } })],
    );
    expect(suggestTuning(noisy, { ...twoRequired, timeoutMs: 10_000 })).toEqual([]);
  });
});
