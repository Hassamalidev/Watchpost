/*
 * P1-T24: the insight views (health tiles, error budgets, change timeline, alert drill, delivery log)
 * render in light and dark with no axe violations.
 */
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { WEB_ORIGIN } from "../playwright.config";

const workspace = () =>
  (JSON.parse(readFileSync("e2e/.auth/workspace.json", "utf8")) as { workspaceId: string })
    .workspaceId;
const path = (section: string) => `/w/${workspace()}/${section}`;

async function noAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

const post = (page: Page, apiPath: string, data: object) =>
  page.request.post(`/api/w/${workspace()}${apiPath}`, {
    data,
    headers: { Origin: WEB_ORIGIN },
  });

test("the overview shows health tiles and error budgets", async ({ page }) => {
  await page.goto(path("overview"));
  await expect(page.getByText("Alert accuracy (30 days)")).toBeVisible();
  await expect(page.getByText("Acknowledge / resolve")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Error budgets" })).toBeVisible();
  await noAxeViolations(page);
});

test("a monitor shows its error budget and recent changes", async ({ page }, testInfo) => {
  const created = await post(page, "/monitors", {
    settings: { name: `Budget ${testInfo.project.name}`, regions: ["eu-central"], sloTarget: 99.5 },
    config: { type: "tcp", host: "example.com", port: 443 },
  });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: string };

  await page.goto(path(`monitors/${id}`));
  await expect(page.getByRole("heading", { name: "Error budget this month" })).toBeVisible();
  await expect(page.getByText("Target: 99.5% availability.")).toBeVisible();
  await expect(page.getByRole("meter", { name: "Error budget this month" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent changes" })).toBeVisible();
  await expect(page.getByText("Monitor created")).toBeVisible();
  await noAxeViolations(page);
});

test("an alert drill is labelled and shows who was notified", async ({ page }) => {
  const drill = await post(page, "/incidents/drill", {});
  expect(drill.status()).toBe(201);
  const { number } = (await drill.json()) as { number: number };

  await page.goto(path(`incidents/${number}`));
  await expect(page.getByText("This is an alert drill, not a real outage.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Who was notified" })).toBeVisible();
  await noAxeViolations(page);
  await page.getByRole("button", { name: "Resolve" }).click();
  await expect(page.getByText("Resolved").first()).toBeVisible();
});

test("admins create a deploy URL and see it once", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "light", "creating the URL twice would rotate it mid-run");
  await page.goto(path("integrations"));
  await expect(page.getByRole("heading", { name: "Deploy markers" })).toBeVisible();
  /* Rotating asks first (native confirm); creating doesn't. Accept either way. */
  page.on("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: /deploy URL/ }).click();
  await expect(page.getByLabel("Deploy URL")).toHaveValue(/\/api\/deploys\/[A-Za-z0-9_-]+$/);
  await expect(page.getByLabel("Secret")).not.toHaveValue("");
  await noAxeViolations(page);
});
