/*
 * P1-T19 AC: the whole outage loop in a browser, against the real API, worker and probe — a monitor
 * on fake-target, the target switched to fail, an incident plus a signed webhook and an alert email
 * with action links, then recovery and an automatically resolved incident. Must finish in 5 minutes.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { E2E_DATABASE_URL } from "../playwright.config";

const TARGET = "http://127.0.0.1:4110";
const RECEIVER = "http://127.0.0.1:4199";

interface Hook {
  headers: Record<string, string>;
  body: string;
}

const workspace = () =>
  (JSON.parse(readFileSync("e2e/.auth/workspace.json", "utf8")) as { workspaceId: string })
    .workspaceId;

async function switchTarget(page: Page, state: "ok" | "fail") {
  const res = await page.request.post(`${TARGET}/control/switch?state=${state}`);
  expect(res.ok()).toBe(true);
}

async function hooksOfType(page: Page, type: string): Promise<Hook[]> {
  const hooks = (await (await page.request.get(`${RECEIVER}/hooks`)).json()) as Hook[];
  return hooks.filter((h) => (JSON.parse(h.body) as { type: string }).type === type);
}

async function addChannel(page: Page, type: "webhook" | "email", name: string, value?: string) {
  await page.getByLabel("Channel type").selectOption(type);
  await page.getByLabel("Name", { exact: true }).fill(name);
  if (value !== undefined) await page.getByLabel("Webhook URL").fill(value);
  await page.getByRole("button", { name: "Add channel" }).click();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
}

test("an outage opens an incident, alerts by webhook and email, and resolves on recovery", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "light", "one outage run is enough");
  test.setTimeout(300_000);
  const started = Date.now();
  const ws = workspace();
  await switchTarget(page, "ok");

  /* Where alerts go: a signed webhook to the local receiver, and email. */
  await page.goto(`/w/${ws}/integrations`);
  await addChannel(page, "webhook", "E2E hook", `${RECEIVER}/hook`);
  await addChannel(page, "email", "E2E email");

  /* A single-region monitor on the switchable target. */
  await page.goto(`/w/${ws}/monitors/new`);
  await page.getByLabel("Name", { exact: true }).fill("Checkout");
  await page.getByLabel("URL").fill(`${TARGET}/switch`);
  await page.getByRole("checkbox", { name: "us-east" }).uncheck();
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Checkout" })).toBeVisible();
  const monitorUrl = page.url();

  await page.getByRole("button", { name: "Test now" }).click();
  await expect(page.getByText(/eu-central: OK in \d+ ms/)).toBeVisible({ timeout: 45_000 });

  /* The outage: the probe sees failures, detection verifies and opens one incident. */
  await switchTarget(page, "fail");
  await page.getByRole("button", { name: "Test now" }).click();
  await expect(page.getByText(/eu-central: failed \(http_status_unexpected\)/)).toBeVisible({
    timeout: 45_000,
  });
  await page.goto(`/w/${ws}/incidents`);
  await expect(page.getByRole("link", { name: /#\d+ Checkout is down/ })).toBeVisible({
    timeout: 90_000,
  });

  /* The webhook arrived, signed with the channel's secret. */
  await expect
    .poll(async () => (await hooksOfType(page, "incident.triggered")).length, {
      timeout: 60_000,
    })
    .toBeGreaterThanOrEqual(1);
  const [triggered] = await hooksOfType(page, "incident.triggered");
  const channels = (await (await page.request.get(`/api/w/${ws}/channels`)).json()) as {
    data: Array<{ id: string; name: string }>;
  };
  const hookChannel = channels.data.find((c) => c.name === "E2E hook");
  const detail = (await (
    await page.request.get(`/api/w/${ws}/channels/${hookChannel?.id}`)
  ).json()) as {
    config: { secret: string };
  };
  const [t, v1] = (triggered?.headers["watchpost-signature"] ?? "")
    .split(",")
    .map((part) => part.split("=")[1]);
  expect(
    createHmac("sha256", detail.config.secret).update(`${t}.${triggered?.body}`).digest("hex"),
  ).toBe(v1);
  expect(JSON.parse(triggered?.body ?? "{}")).toMatchObject({
    type: "incident.triggered",
    incident: { title: "Checkout is down", status: "triggered" },
    monitor: { name: "Checkout" },
  });

  /* The alert email was sent with a single-use acknowledge link. */
  const db = new pg.Client({ connectionString: E2E_DATABASE_URL });
  await db.connect();
  try {
    await expect
      .poll(
        async () =>
          (
            await db.query(
              `select count(*)::int as n from outbox_events
               where type = 'email.requested' and workspace_id = $1 and payload->>'template' = 'alert'
                 and payload->'data'->>'kind' = 'triggered'
                 and payload->'data'->'actions'->>'acknowledge' like '%/a/%'`,
              [ws],
            )
          ).rows[0]?.n as number,
        { timeout: 30_000 },
      )
      .toBeGreaterThanOrEqual(1);
  } finally {
    await db.end();
  }

  /* Recovery: one good check resolves the incident automatically. */
  await switchTarget(page, "ok");
  await page.goto(monitorUrl);
  await page.getByRole("button", { name: "Test now" }).click();
  await expect(page.getByText(/eu-central: OK in \d+ ms/)).toBeVisible({ timeout: 45_000 });
  await page.goto(`/w/${ws}/incidents?status=resolved`);
  await expect(page.getByRole("link", { name: /#\d+ Checkout is down/ })).toBeVisible({
    timeout: 90_000,
  });
  await expect
    .poll(async () => (await hooksOfType(page, "incident.resolved")).length, {
      timeout: 60_000,
    })
    .toBeGreaterThanOrEqual(1);

  expect(Date.now() - started).toBeLessThan(300_000);
});
