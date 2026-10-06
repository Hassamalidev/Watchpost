/*
 * P1-T29: the integration gallery and setup flow in a browser, light and dark, with axe — search and
 * filters, connecting a webhook (saved, tested against the local receiver, shown with its signing
 * secret), editing its rules, API field errors next to inputs, write-only secrets and the warning
 * for tools that page people. Nothing here calls a real third-party service.
 */
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const RECEIVER = "http://127.0.0.1:4199";

const workspace = () =>
  (JSON.parse(readFileSync("e2e/.auth/workspace.json", "utf8")) as { workspaceId: string })
    .workspaceId;
const path = (section: string) => `/w/${workspace()}/${section}`;

async function noAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

test("the gallery lists every integration and narrows by search and category", async ({ page }) => {
  await page.goto(path("integrations"));
  await expect(page.getByRole("heading", { name: "Add an integration" })).toBeVisible();
  const gallery = page.getByRole("region", { name: "Add an integration" });
  await expect(gallery.getByRole("listitem")).toHaveCount(25);
  await expect(gallery.getByRole("link", { name: /^Slack Chat/ })).toContainText(
    "Not set up on this server",
  );

  await page.getByRole("searchbox", { name: "Search integrations" }).fill("pager");
  await expect(gallery.getByRole("listitem")).toHaveCount(1);
  await expect(gallery.getByRole("link", { name: /PagerDuty/ })).toBeVisible();
  await expect(page.getByText("1 integration", { exact: true })).toBeVisible();

  await page.getByRole("searchbox", { name: "Search integrations" }).fill("");
  await page.getByRole("button", { name: "Push", exact: true }).click();
  await expect(gallery.getByRole("heading", { level: 3 })).toHaveText([
    "Pushover",
    "ntfy",
    "Pushbullet",
    "Gotify",
  ]);
  await noAxeViolations(page);

  await page.getByRole("searchbox", { name: "Search integrations" }).fill("fax machine");
  await expect(page.getByText("No integration matches “fax machine”.")).toBeVisible();
  await page.getByRole("link", { name: "Set up a webhook" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Connect Webhook" })).toBeVisible();
});

test("connecting a webhook tests it, shows the signing secret, and its rules can be changed", async ({
  page,
}, testInfo) => {
  const name = `Catalog hook ${testInfo.project.name}`;
  await page.goto(path("integrations"));
  await page
    .getByRole("region", { name: "Add an integration" })
    .getByRole("link", { name: /^Webhook Automation/ })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Connect Webhook" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "How to set it up" })).toBeVisible();
  await noAxeViolations(page);

  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Endpoint URL").fill(`${RECEIVER}/hook`);
  await page.getByLabel("Request headers (optional)").fill("Authorization: Bearer e2e-token");
  await page.getByRole("button", { name: "Save and send test" }).click();

  /* The channel's own page: connected, tested, with the secret to verify signatures. */
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(`${name} is connected. The test alert was delivered.`)).toBeVisible();
  await expect(page.getByLabel("Signing secret")).toHaveValue(/^whsec_/);
  /* The header's value is write-only: its name comes back, the token doesn't. */
  await expect(page.getByLabel("Request headers (optional)")).toHaveValue(
    "Authorization: ********",
  );
  await expect(page.getByText("e2e-token")).toHaveCount(0);
  await noAxeViolations(page);

  /* The receiver got the test, with the custom header and a signature. */
  const hooks = (await (await page.request.get(`${RECEIVER}/hooks`)).json()) as Array<{
    headers: Record<string, string>;
    body: string;
  }>;
  const mine = hooks.filter((h) => {
    const body = JSON.parse(h.body) as { type: string; workspace?: { id: string } };
    return body.type === "incident.test" && body.workspace?.id === workspace();
  });
  expect(mine.length).toBeGreaterThanOrEqual(1);
  expect(mine.at(-1)?.headers.authorization).toBe("Bearer e2e-token");
  expect(mine.at(-1)?.headers["watchpost-signature"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);

  /* Rules: only critical incidents, no reminders. The masked header is kept. */
  await page.getByLabel("Incidents").selectOption("critical");
  await page.getByRole("checkbox", { name: "Reminders while down" }).uncheck();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Send test/ }).click();
  await expect(page.getByText("Delivered.", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "All integrations" }).click();
  const row = page.getByRole("listitem").filter({ hasText: name });
  await expect(row).toContainText("Critical only · no reminders");
  await expect(row).toContainText("Healthy");

  /* Remove it from its page. */
  await row.getByRole("link", { name: `Edit ${name}` }).click();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Integrations" })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: name })).toHaveCount(0);
});

test("a value pasted into the wrong integration is explained next to its field", async ({
  page,
}) => {
  await page.goto(path("integrations/new/google-chat"));
  await expect(page.getByRole("heading", { level: 1, name: "Connect Google Chat" })).toBeVisible();
  await page.getByLabel("Webhook URL").fill("https://hooks.slack.com/services/T0AAA/B0BBB/abc");
  await page.getByRole("button", { name: "Save and send test" }).click();
  await expect(page.getByText(/must be a Google Chat webhook URL/)).toBeVisible();
  await expect(page.getByLabel("Webhook URL")).toHaveAttribute("aria-invalid", "true");
  await noAxeViolations(page);
});

test("on-call tools aren't tested without asking, and their keys are never shown again", async ({
  page,
}, testInfo) => {
  const name = `Pager ${testInfo.project.name}`;
  const key = "E2EROUTINGKEY".padEnd(32, "0");
  await page.goto(path("integrations/new/pagerduty"));
  await expect(page.getByText(/whoever is on call may be paged/)).toBeVisible();
  await expect(page.getByLabel("Incidents")).toHaveValue("high");
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Integration key").fill(key);
  /* "Save", not "Save and send test": nothing is sent to PagerDuty. */
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByText(`${name} is connected. Send a test to check that it works.`),
  ).toBeVisible();
  await expect(page.getByLabel("Integration key")).toHaveValue("");
  await expect(page.getByLabel("Integration key")).toHaveAccessibleDescription(
    /Saved\. Leave empty to keep it\./,
  );
  await expect(page.getByText(key)).toHaveCount(0);
  const detail = await page.request.get(
    `/api/w/${workspace()}/channels/${page.url().split("/").at(-1)}`,
  );
  expect(await detail.text()).not.toContain(key);
  await noAxeViolations(page);

  await page.getByRole("link", { name: "All integrations" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: name })).toContainText(
    "High and critical",
  );
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: `Remove ${name}` }).click();
  await expect(page.getByRole("listitem").filter({ hasText: name })).toHaveCount(0);
});

test("integrations the server can't deliver to say so and offer what works", async ({ page }) => {
  await page.goto(path("integrations/new/slack"));
  await expect(page.getByRole("heading", { level: 1, name: "Connect Slack" })).toBeVisible();
  await expect(page.getByText(/The Slack app isn't configured on this server yet/)).toBeVisible();
  await noAxeViolations(page);
  await page.getByRole("link", { name: "Use an incoming webhook" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Connect Slack (incoming webhook)" }),
  ).toBeVisible();

  await page.goto(path("integrations/new/carrier-pigeon"));
  await expect(page.getByText("We don't have that integration.")).toBeVisible();
});
