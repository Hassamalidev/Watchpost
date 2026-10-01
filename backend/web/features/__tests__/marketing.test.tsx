/* Public site: plan picker, per-seat calculator, the plan kept for billing, and page content. */
import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import { PlanPicker } from "@/features/marketing/components/plan-picker";
import { SeatCalculator } from "@/features/marketing/components/seat-calculator";
import {
  CHECKED_ON,
  COMPETITORS,
  MAX_TEAM_SIZE,
  compareSeatCost,
} from "@/features/marketing/competitors";
import { DOCS_PAGES } from "@/features/marketing/content/docs";
import { LEGAL_PAGES } from "@/features/marketing/content/legal";
import { formatPlanPrice, isMarketingPlanKey, parseSelectedPlan } from "@/features/marketing/plans";

describe("PlanPicker", () => {
  it("shows the four plans with monthly prices and sign-up links that carry the plan", () => {
    renderWithProviders(<PlanPicker />);
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "Free",
      "Starter",
      "Pro",
      "Business",
    ]);
    expect(screen.getByText("$29")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Start free" })).toHaveAttribute("href", "/signup");
    expect(screen.getByRole("link", { name: "Choose Pro" })).toHaveAttribute(
      "href",
      "/signup?plan=pro&billing=monthly",
    );
  });

  it("switches to annual prices and links", () => {
    renderWithProviders(<PlanPicker />);
    const annual = screen.getByRole("button", { name: "Annual (2 months free)" });
    fireEvent.click(annual);
    expect(annual).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("$7.50")).toBeInTheDocument();
    expect(screen.getByText("$24")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Choose Business" })).toHaveAttribute(
      "href",
      "/signup?plan=business&billing=annual",
    );
  });
});

describe("marketing plans", () => {
  it("formats prices and accepts only known plan keys", () => {
    expect(formatPlanPrice(0)).toBe("$0");
    expect(formatPlanPrice(7.5)).toBe("$7.50");
    expect(isMarketingPlanKey("pro")).toBe(true);
    expect(isMarketingPlanKey("enterprise")).toBe(false);
    expect(isMarketingPlanKey(null)).toBe(false);
  });
});

describe("per-seat calculator", () => {
  it("multiplies per-user prices by the team and compares a year with flat Pro", () => {
    expect(compareSeatCost(10)).toEqual([
      { key: "better-stack", name: "Better Stack", monthly: 290, yearlyDifference: 3_192 },
      { key: "pagerduty", name: "PagerDuty Professional", monthly: 210, yearlyDifference: 2_232 },
    ]);
  });

  it("never shows a negative difference and keeps the team size in range", () => {
    expect(compareSeatCost(1).map((row) => row.yearlyDifference)).toEqual([60, 0]);
    expect(compareSeatCost(0)).toEqual(compareSeatCost(1));
    expect(compareSeatCost(Number.NaN)).toEqual(compareSeatCost(1));
    expect(compareSeatCost(10_000)).toEqual(compareSeatCost(MAX_TEAM_SIZE));
  });

  it("updates the table as the team size changes", () => {
    renderWithProviders(<SeatCalculator />);
    fireEvent.change(screen.getByLabelText("People on your team"), { target: { value: "20" } });
    expect(screen.getByText("$580")).toBeInTheDocument();
    expect(screen.getByText("$6,672")).toBeInTheDocument();
  });
});

describe("plan chosen before sign-up", () => {
  it("reads a stored paid plan and its billing period", () => {
    expect(parseSelectedPlan('{"plan":"pro","billing":"annual"}')).toEqual({
      plan: "pro",
      interval: "year",
    });
    expect(parseSelectedPlan('{"plan":"starter","billing":"monthly"}')).toEqual({
      plan: "starter",
      interval: "month",
    });
  });

  it("ignores Free, unknown plans and broken values", () => {
    for (const raw of [null, "", "{", '{"plan":"free"}', '{"plan":"enterprise"}', "null"]) {
      expect(parseSelectedPlan(raw)).toBeNull();
    }
  });
});

describe("public content", () => {
  it("gives every comparison dated sources and unique addresses", () => {
    expect(CHECKED_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Set(COMPETITORS.map((c) => c.slug)).size).toBe(COMPETITORS.length);
    for (const competitor of COMPETITORS) {
      expect(competitor.sources.length).toBeGreaterThan(0);
      for (const source of competitor.sources) expect(source).toMatch(/^https:\/\//);
      expect(competitor.differences.length).toBeGreaterThan(0);
    }
  });

  it("has the four legal pages and unique docs pages", () => {
    expect(LEGAL_PAGES.map((page) => page.slug)).toEqual([
      "terms",
      "privacy",
      "acceptable-use",
      "refunds",
    ]);
    expect(new Set(DOCS_PAGES.map((page) => page.slug)).size).toBe(DOCS_PAGES.length);
    for (const page of [...LEGAL_PAGES, ...DOCS_PAGES]) {
      expect(page.sections.length).toBeGreaterThan(0);
    }
  });
});
