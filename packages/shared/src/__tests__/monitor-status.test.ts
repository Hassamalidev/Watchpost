import { describe, expect, it } from "vitest";
import { MONITOR_STATUSES, monitorStatusSchema } from "../index.js";

describe("monitorStatusSchema", () => {
  it("accepts every known status", () => {
    for (const status of MONITOR_STATUSES) {
      expect(monitorStatusSchema.parse(status)).toBe(status);
    }
  });

  it("rejects unknown statuses", () => {
    expect(monitorStatusSchema.safeParse("exploded").success).toBe(false);
  });
});
