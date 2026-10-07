/*
 * P3-T07: the public site. Pricing (table, calculator, questions), comparison pages with dated
 * sources, docs and legal drafts are reachable from the landing page, in light and dark with no axe
 * violations.
 */
import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.use({ storageState: { cookies: [], origins: [] } });

async function noAxeViolations(page: Page) {
  /* After a link click the page's title can arrive a moment after its heading (Next streams it). */
  await expect(page).toHaveTitle(/\S/);
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

test("pricing shows every plan, what is coming soon, and the per-seat calculator", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Compare every feature" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Pricing" })).toBeVisible();

  const table = page.getByRole("table", { name: /Plan limits and features/ });
  await expect(table.getByRole("row", { name: /^Monitors 20 50 150 500$/ })).toBeVisible();
  await expect(table.getByRole("row", { name: /Private probes Coming soon/ })).toBeVisible();

  await page.getByLabel("People on your team").fill("12");
  await expect(page.getByRole("row", { name: /Better Stack/ })).toContainText("$348");
  await expect(page.getByText("Do you charge per user?")).toBeVisible();
  await noAxeViolations(page);
});

test("a comparison page states its sources and the date they were checked", async ({ page }) => {
  await page.goto("/pricing");
  await page.getByRole("link", { name: "UptimeWatch vs Better Stack" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "UptimeWatch vs Better Stack" }),
  ).toBeVisible();
  await expect(page.getByText(/Checked on 2026-09-30/)).toBeVisible();
  await expect(
    page.getByRole("link", { name: "https://hyperping.com/compare/betterstack-alternative" }),
  ).toBeVisible();
  await noAxeViolations(page);
  expect((await page.goto("/compare/nobody"))?.status()).toBe(404);
});

test("docs and legal drafts are reachable and the drafts say they are drafts", async ({ page }) => {
  await page.goto("/docs");
  await page.getByRole("link", { name: "Heartbeats" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Heartbeats" })).toBeVisible();
  await noAxeViolations(page);

  await page.getByRole("link", { name: "Refund Policy" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Refund Policy" })).toBeVisible();
  await expect(page.getByText(/Draft, needs owner review/)).toBeVisible();
  await noAxeViolations(page);
});

test("the Opsgenie page states the dates with sources and leads to the migration guide", async ({
  page,
}) => {
  await page.goto("/alternatives/opsgenie");
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Moving on from Opsgenie? Bring your schedules with you.",
    }),
  ).toBeVisible();
  await expect(page.getByText("Support for Opsgenie ends on April 5, 2027.")).toBeVisible();
  await expect(page.getByText(/checked on 2026-09-30/)).toBeVisible();
  await expect(page.getByRole("link", { name: /^https:\/\// }).first()).toBeVisible();
  await noAxeViolations(page);

  await page.getByRole("link", { name: "Read the migration guide" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Moving from Opsgenie" })).toBeVisible();
  await expect(page.getByText(/api\.opsgenie\.com\/v2\/schedules\?expand=rotation/)).toBeVisible();
  await noAxeViolations(page);

  /* The comparison page no longer calls the importer "planned". */
  await page.goto("/compare/opsgenie");
  await expect(
    page.getByText(/an importer for Opsgenie schedules and escalations are included/),
  ).toBeVisible();
});
