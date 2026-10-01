/* Landing page plan picker: prices, billing period and the sign-up links. */
import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import { PlanPicker } from "@/features/marketing/components/plan-picker";
import { formatPlanPrice, isMarketingPlanKey } from "@/features/marketing/plans";

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
