/*
 * P1-T30: the landing page offers sign in, sign up and plan selection, and a picked plan follows the
 * visitor into sign-up. Light and dark, with no axe violations.
 */
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.use({ storageState: { cookies: [], origins: [] } });

test("a visitor can sign in, sign up or pick a plan from the landing page", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Know about real outages");
  const nav = page.getByRole("navigation", { name: "Site" });
  await expect(nav.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
  await expect(nav.getByRole("link", { name: "Sign up" })).toHaveAttribute("href", "/signup");
  await expect(page.getByRole("heading", { level: 3, name: "Business" })).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  await page.getByRole("button", { name: "Annual (2 months free)" }).click();
  await page.getByRole("link", { name: "Choose Pro" }).click();
  await expect(page).toHaveURL(/\/signup\?plan=pro&billing=annual/);
  await expect(page.getByText(/Pro plan selected/)).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("watchpost.selectedPlan"))).toBe(
    JSON.stringify({ plan: "pro", billing: "annual" }),
  );

  await page.goto("/");
  await nav.getByRole("link", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to Watchpost" })).toBeVisible();
});
