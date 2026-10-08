/* Status pages: addresses, how monitor states and incidents become page statuses, and the banner. */
import { describe, expect, it } from "vitest";
import {
  componentStatusOf,
  createStatusPageSchema,
  overallStatusOf,
  statusBrandingSchema,
  statusPageSettingsSchema,
  statusSlugSchema,
  worseStatus,
} from "../index.js";

describe("page addresses", () => {
  it("accepts subdomain-safe names and lowercases them", () => {
    expect(statusSlugSchema.parse("Acme-Shop")).toBe("acme-shop");
    expect(statusSlugSchema.parse("a1b")).toBe("a1b");
    expect(statusSlugSchema.parse("x".repeat(63))).toHaveLength(63);
  });

  it("refuses names that can't be a subdomain or that we keep for ourselves", () => {
    for (const bad of ["ab", "-acme", "acme-", "ac me", "acme.io", "x".repeat(64), "www", "api"]) {
      expect(statusSlugSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe("page settings", () => {
  it("fills in defaults, so a page saved before a field existed still has it", () => {
    expect(statusPageSettingsSchema.parse({})).toEqual({
      showUptime: true,
      autoIncidents: { enabled: false, afterMinutes: 5, publish: "auto" },
      subscribers: true,
      tone: "neutral",
    });
    expect(statusBrandingSchema.parse({})).toEqual({
      logoUrl: null,
      faviconUrl: null,
      accentColor: null,
      description: null,
      supportUrl: null,
    });
  });

  it("takes only https links and #rrggbb colors", () => {
    expect(statusBrandingSchema.safeParse({ logoUrl: "http://x.test/a.png" }).success).toBe(false);
    expect(statusBrandingSchema.safeParse({ logoUrl: "javascript:alert(1)" }).success).toBe(false);
    expect(statusBrandingSchema.safeParse({ accentColor: "red" }).success).toBe(false);
    expect(
      statusBrandingSchema.safeParse({
        logoUrl: "https://x.test/a.png",
        accentColor: "#2563EB",
      }).success,
    ).toBe(true);
    expect(createStatusPageSchema.safeParse({ name: "A", slug: "acme", extra: 1 }).success).toBe(
      false,
    );
  });
});

describe("statuses", () => {
  it("maps what a monitor is doing to what the page says", () => {
    expect(componentStatusOf("up")).toBe("operational");
    expect(componentStatusOf("verifying")).toBe("operational");
    expect(componentStatusOf("degraded")).toBe("degraded");
    expect(componentStatusOf("down")).toBe("major_outage");
    expect(componentStatusOf("maintenance")).toBe("maintenance");
    expect(componentStatusOf("pending")).toBe("unknown");
    expect(componentStatusOf("paused")).toBe("unknown");
  });

  it("keeps the worse of two statuses; unknown never wins", () => {
    expect(worseStatus("operational", "degraded")).toBe("degraded");
    expect(worseStatus("major_outage", "degraded")).toBe("major_outage");
    expect(worseStatus("unknown", "operational")).toBe("operational");
    expect(worseStatus("maintenance", "partial_outage")).toBe("partial_outage");
  });

  it("sums the components up for the banner", () => {
    expect(overallStatusOf([])).toBe("operational");
    expect(overallStatusOf(["unknown", "unknown"])).toBe("operational");
    expect(overallStatusOf(["operational", "operational"])).toBe("operational");
    expect(overallStatusOf(["operational", "maintenance"])).toBe("maintenance");
    expect(overallStatusOf(["operational", "degraded", "maintenance"])).toBe("degraded");
    expect(overallStatusOf(["operational", "major_outage"])).toBe("partial_outage");
    expect(overallStatusOf(["partial_outage", "operational"])).toBe("partial_outage");
    expect(overallStatusOf(["major_outage", "major_outage", "unknown"])).toBe("major_outage");
  });
});
