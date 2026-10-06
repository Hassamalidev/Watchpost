/*
 * On-call (P4-T03b): an admin creates a weekly schedule, the page says who is on call, the calendar
 * shows the next two weeks, an override puts someone on call by hand, and the calendar link is shown.
 */
import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const workspace = () =>
  (JSON.parse(readFileSync("e2e/.auth/workspace.json", "utf8")) as { workspaceId: string })
    .workspaceId;

async function noAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

test("an admin builds a schedule and sees who is on call", async ({ page }, testInfo) => {
  /* A form, three pages and three accessibility scans: give it room on a busy runner. */
  test.setTimeout(120_000);
  const name = `Primary ${testInfo.project.name} ${Date.now()}`;
  await page.goto(`/w/${workspace()}/on-call`);
  await expect(page.getByRole("heading", { level: 1, name: "On-call" })).toBeVisible();

  await page.getByRole("button", { name: "New schedule" }).click();
  await page.getByLabel("Schedule name").fill(name);
  /* The first handoff was a week ago, so someone is on call today. */
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  await page
    .getByLabel("First handoff")
    .fill(
      `${weekAgo.getFullYear()}-${pad(weekAgo.getMonth() + 1)}-${pad(weekAgo.getDate())}T09:00`,
    );
  await page.getByRole("button", { name: "Create schedule" }).click();
  await expect(page.getByText("Layer 1 needs at least one person.")).toBeVisible();

  const person = page.getByLabel("Add a person");
  await person.selectOption({ index: 1 });
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await noAxeViolations(page);
  await page.getByRole("button", { name: "Create schedule" }).click();

  const row = page.getByRole("listitem").filter({ hasText: name });
  await expect(row).toContainText("On call now:");
  await row.getByRole("link", { name }).click();

  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  await expect(page.getByText(/^Until /)).toBeVisible();
  const calendar = page.getByRole("table", { name: `Who is on call for ${name}, day by day` });
  await expect(calendar.getByRole("row")).toHaveCount(15);
  await expect(page.getByText("No overrides ahead.")).toBeVisible();
  await noAxeViolations(page);

  await page.getByRole("button", { name: "Add override" }).click();
  await expect(page.getByText("Override added.")).toBeVisible();
  await expect(page.getByText(/^Covering by override until /)).toBeVisible();
  await expect(calendar).toContainText("(override)");
  const overrides = page.getByRole("list", { name: "Overrides" });
  await expect(overrides.getByRole("listitem")).toHaveCount(1);
  await overrides.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("No overrides ahead.")).toBeVisible();

  /* Edit: the name changes everywhere. */
  await page.getByRole("button", { name: "Edit schedule" }).click();
  await page.getByLabel("Schedule name").fill(`${name} v2`);
  await page.getByRole("button", { name: "Save schedule" }).click();
  await expect(page.getByRole("heading", { level: 1, name: `${name} v2` })).toBeVisible();

  await page.getByRole("link", { name: "All schedules" }).click();
  await expect(page.getByRole("link", { name: `${name} v2` })).toBeVisible();
});

test("a member creates their private calendar link", async ({ page, request }) => {
  await page.goto(`/w/${workspace()}/on-call`);
  await expect(page.getByRole("heading", { name: "Your on-call calendar" })).toBeVisible();
  const create = page.getByRole("button", { name: /Create my calendar link|Replace the link/ });
  await create.click();
  const link = page.getByRole("textbox", { name: "Calendar link" });
  await expect(link).toHaveValue(/\/api\/oncall\/ical\/[A-Za-z0-9_-]+\.ics$/);
  await noAxeViolations(page);

  /* The link works without a session, as a calendar app would fetch it. */
  const url = new URL(await link.inputValue());
  const feed = await request.get(url.pathname, { headers: { cookie: "" } });
  expect(feed.status()).toBe(200);
  expect(await feed.text()).toContain("BEGIN:VCALENDAR");
});
