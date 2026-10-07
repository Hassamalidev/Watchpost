/*
 * P1-T30: the landing page offers sign in, sign up and plan selection, and a picked plan follows the
 * visitor into sign-up. Light and dark, with no axe violations.
 * P3-T07c: the page says what is monitored, answers the common questions, and tells search engines
 * about itself (title, canonical link, share image, structured data, sitemap and robots).
 */
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.use({ storageState: { cookies: [], origins: [] } });

test("a visitor can sign in, sign up or pick a plan from the landing page", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Uptime monitoring that confirms an outage",
  );
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
  await expect(page.getByRole("heading", { name: "Sign in to UptimeWatch" })).toBeVisible();
});

test("the landing page describes itself to search engines", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("Uptime Monitoring, On-Call and Status Pages | UptimeWatch");
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    "content",
    /uptime monitoring/i,
  );
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    /^https?:\/\/[^/]+\/?$/,
  );
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
    "content",
    /opengraph-image/,
  );

  await expect(page.getByRole("heading", { level: 3, name: "Cron job monitoring" })).toBeVisible();
  await expect(page.getByText("UptimeWatch is an uptime monitoring service.")).toBeVisible();
  await page.getByText("How does UptimeWatch reduce false alarms?").click();
  await expect(page.getByText(/One failed check does not alert anyone/)).toBeVisible();

  const data = JSON.parse(
    (await page.locator('script[type="application/ld+json"]').textContent()) ?? "{}",
  ) as { "@graph": Array<{ "@type": string; mainEntity?: unknown[] }> };
  const types = data["@graph"].map((node) => node["@type"]);
  expect(types).toEqual(["Organization", "WebSite", "SoftwareApplication", "FAQPage"]);
  expect(data["@graph"][3]?.mainEntity).toHaveLength(9);

  const robots = await page.request.get("/robots.txt");
  expect(await robots.text()).toMatch(/Disallow: \/w\/[\s\S]*Sitemap: .*\/sitemap\.xml/);
  const sitemap = await page.request.get("/sitemap.xml");
  expect(await sitemap.text()).toContain("/compare/uptimerobot</loc>");
});
