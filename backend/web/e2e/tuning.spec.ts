/*
 * P1-T28: the alert tuning advisor in light and dark with no axe violations. Two resolved false
 * alarms are written straight to the e2e database (a real noisy history takes days), then the advice
 * is applied with one click.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import pg from "pg";
import { E2E_DATABASE_URL, WEB_ORIGIN } from "../playwright.config";

const workspace = () =>
  (JSON.parse(readFileSync("e2e/.auth/workspace.json", "utf8")) as { workspaceId: string })
    .workspaceId;
const path = (section: string) => `/w/${workspace()}/${section}`;

async function seedFalseAlarms(monitorId: string, count: number) {
  const client = new pg.Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  try {
    for (let i = 0; i < count; i += 1) {
      const started = new Date(Date.now() - (i + 1) * 86_400_000);
      await client.query(
        `insert into incidents (id, workspace_id, number, source, monitor_id, title, severity, status,
           cause_code, failing_regions, started_at, resolved_at, false_alarm)
         values ($1, $2, $3, 'monitor', $4, 'Blip', 'high', 'resolved', 'connect_timeout',
           '{eu-central}', $5, $6, true)`,
        [
          randomUUID(),
          workspace(),
          900_000 + Math.floor(Math.random() * 99_999),
          monitorId,
          started.toISOString(),
          new Date(started.getTime() + 600_000).toISOString(),
        ],
      );
    }
  } finally {
    await client.end();
  }
}

async function noAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

test("noisy monitors get advice that applies with one click", async ({ page }, testInfo) => {
  const created = await page.request.post(`/api/w/${workspace()}/monitors`, {
    headers: { Origin: WEB_ORIGIN },
    data: {
      settings: { name: `Blippy ${testInfo.project.name}`, regions: ["eu-central"] },
      config: { type: "tcp", host: "blippy.example.com", port: 443 },
    },
  });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: string };
  await seedFalseAlarms(id, 2);

  await page.goto(path("overview"));
  await expect(page.getByRole("heading", { name: "Noisy monitors" })).toBeVisible();
  await noAxeViolations(page);

  await page.goto(path(`monitors/${id}`));
  await expect(page.getByRole("heading", { name: "Alert tuning" })).toBeVisible();
  await expect(page.getByText("Check from a second region (us-east)")).toBeVisible();
  await noAxeViolations(page);
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText("Applied. The new settings take effect")).toBeVisible();

  const after = await page.request.get(`/api/w/${workspace()}/monitors/${id}`);
  expect(await after.json()).toMatchObject({
    regions: ["eu-central", "us-east"],
    minFailingRegions: 2,
  });
});
