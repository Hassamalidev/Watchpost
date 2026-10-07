/*
 * Importing (P4-T07): an admin pastes an Uptime Kuma backup, sees what each monitor would become and
 * what can't come over, imports, and finds the monitors in the list.
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

test("an admin previews and imports an Uptime Kuma backup", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const tag = `${testInfo.project.name}-${Date.now()}`;
  const backup = {
    version: "1.23.13",
    monitorList: [
      {
        name: `Imported shop ${tag}`,
        type: "http",
        url: "https://shop.example.com",
        interval: 300,
      },
      { name: `Imported ping ${tag}`, type: "ping", hostname: "db.example.com", interval: 300 },
      { name: `Imported postgres ${tag}`, type: "postgres", interval: 60 },
    ],
  };
  await page.goto(`/w/${workspace()}/settings`);
  await page.getByRole("link", { name: "Import from another tool" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Import from another tool" }),
  ).toBeVisible();

  await page.getByLabel("Tool").selectOption("uptime_kuma");
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByText("Paste the export first.")).toBeVisible();
  await page.getByLabel("Export (JSON)").fill("{ nope");
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByText("That isn't valid JSON.")).toBeVisible();

  await page.getByLabel("Export (JSON)").fill(JSON.stringify(backup));
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByText("2 of 3 can be imported (66.7%).")).toBeVisible();
  const table = page.getByRole("table", { name: "What each object becomes" });
  await expect(table.getByRole("row").filter({ hasText: `Imported shop ${tag}` })).toContainText(
    "HTTP check every 5 min",
  );
  await expect(
    table.getByRole("row").filter({ hasText: `Imported postgres ${tag}` }),
  ).toContainText("Not imported:");
  await noAxeViolations(page);

  await page.getByRole("button", { name: "Import 2 items" }).click();
  await expect(page.getByRole("heading", { name: "Import finished" })).toBeVisible();
  await expect(page.getByText(/^2 items were created/)).toBeVisible();
  await noAxeViolations(page);

  await page.goto(`/w/${workspace()}/monitors`);
  await expect(page.getByRole("link", { name: new RegExp(`Imported shop ${tag}`) })).toBeVisible();
});
