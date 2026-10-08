/*
 * P1-T25: editing a monitor, keyboard shortcuts on an incident and incident filters, in light and dark
 * with no axe violations.
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
  page.request.post(`/api/w/${workspace()}${apiPath}`, { data, headers: { Origin: WEB_ORIGIN } });

test("a monitor can be edited, keeping its type", async ({ page }, testInfo) => {
  const created = await post(page, "/monitors", {
    settings: { name: `Edit me ${testInfo.project.name}`, regions: ["eu-central"] },
    config: { type: "http", url: "https://example.com/health" },
  });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: string };

  await page.goto(path(`monitors/${id}`));
  await page.getByRole("link", { name: "Edit" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Edit monitor" })).toBeVisible();
  await expect(page.getByLabel("Type")).toBeDisabled();
  await expect(page.getByLabel("URL")).toHaveValue("https://example.com/health");
  await noAxeViolations(page);

  const name = `Health API ${testInfo.project.name}`;
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Availability target").selectOption("99.95");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  await expect(page.getByText("Target: 99.95% availability.")).toBeVisible();
});

test("pointing a monitor with saved credentials elsewhere asks to drop them", async ({
  page,
}, testInfo) => {
  const created = await post(page, "/monitors", {
    settings: { name: `Private ${testInfo.project.name}`, regions: ["eu-central"] },
    config: {
      type: "http",
      url: "https://api.example.com/health",
      auth: { kind: "bearer", token: "s3cret-token" },
    },
  });
  const { id } = (await created.json()) as { id: string };
  await page.goto(path(`monitors/${id}/edit`));
  await page.getByLabel("URL").fill("https://status.example.net/health");
  await expect(page.getByText("This monitor has saved credentials")).toBeVisible();
  await noAxeViolations(page);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("The target changed: confirm removing")).toBeVisible();
  await page.getByLabel("Remove the saved credentials and save").check();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("status.example.net/health")).toBeVisible();
});

test("A acknowledges and R resolves an incident from the keyboard", async ({ page }) => {
  const drill = await post(page, "/incidents/drill", {});
  const { number } = (await drill.json()) as { number: number };
  await page.goto(path(`incidents/${number}`));
  await expect(page.getByRole("button", { name: "Acknowledge" })).toHaveAttribute(
    "aria-keyshortcuts",
    "A",
  );
  await page.keyboard.press("a");
  await expect(page.getByRole("button", { name: "Acknowledge" })).toBeHidden();
  await expect(page.getByText("Acknowledged").first()).toBeVisible();

  /* Typing in the comment box doesn't trigger shortcuts. */
  await page.getByLabel("Add a comment").fill("r is for reading logs");
  await expect(page.getByRole("button", { name: "Resolve" })).toBeVisible();
  await page.getByLabel("Add a comment").blur();
  await page.keyboard.press("r");
  await expect(page.getByRole("button", { name: "Resolve" })).toBeHidden();
});

test("an open incident keeps its actions in a bar that stays in reach", async ({ page }) => {
  await page.goto(path("incidents"));
  const created = await page.request.post(`/api/w/${workspace()}/incidents`, {
    data: { title: `Command bar ${Date.now()}`, severity: "high" },
    headers: { origin: new URL(page.url()).origin },
  });
  expect(created.status()).toBe(201);
  const incident = (await created.json()) as { number: number };
  await page.goto(path(`incidents/${incident.number}`));
  const bar = page.getByRole("toolbar", { name: `Actions for incident #${incident.number}` });
  await expect(bar).toContainText(`#${incident.number} · Triggered`);
  await expect(bar).toHaveCSS("position", "sticky");
  await bar.getByRole("button", { name: /Acknowledge/ }).click();
  await expect(bar).toContainText(`#${incident.number} · Acknowledged`);
  await expect(bar.getByRole("button", { name: /Acknowledge/ })).toHaveCount(0);
  await noAxeViolations(page);
});

test("incidents filter by severity and keep the filter in the URL", async ({ page }) => {
  await page.goto(path("incidents?status=all"));
  await page.getByLabel("Filter by severity").selectOption("low");
  await expect(page).toHaveURL(/severity=low/);
  await expect(page.getByText("No incidents match these filters.")).toBeVisible();
  await noAxeViolations(page);
  await page.getByLabel("Filter by severity").selectOption("high");
  await expect(page.getByRole("link", { name: /Alert drill/ }).first()).toBeVisible();
});

test("the reports page shows an SLA report and offers it as files", async ({ page }) => {
  await page.goto(path("reports"));
  await expect(page.getByRole("heading", { level: 1, name: "Reports" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Download PDF" })).toHaveAttribute(
    "href",
    /\/reports\/sla\.pdf\?kind=workspace&from=/,
  );
  await page.getByLabel("Period").selectOption("last7");
  await expect(page.getByRole("link", { name: "Download CSV" })).toHaveAttribute(
    "href",
    /\/reports\/sla\.csv\?kind=workspace&from=/,
  );
  /* A monitor, a group or a status page has to be picked before there is a report. */
  await page.getByLabel("Report on").selectOption("monitor");
  await expect(page.getByText("Choose what to report on")).toBeVisible();
  await expect(page.getByText("No reports are scheduled.")).toBeVisible();
  await noAxeViolations(page);
});
