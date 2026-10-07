/*
 * My notifications (P4-T02b): the account email is ready, a second address is verified with the
 * emailed code, and a personal rule is saved and still there after a reload.
 */
import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { emailField, uniqueEmail } from "./helpers";

const workspace = () =>
  (JSON.parse(readFileSync("e2e/.auth/workspace.json", "utf8")) as { workspaceId: string })
    .workspaceId;

async function noAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

test("a member verifies a second address and sets when it is used", async ({ page }) => {
  /* One long journey (an emailed code, three accessibility scans): give it room on a busy runner. */
  test.setTimeout(120_000);
  const second = uniqueEmail("e2e-second");
  await page.goto(`/w/${workspace()}/notifications`);
  await expect(page.getByRole("heading", { level: 1, name: "My notifications" })).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: "My notifications" }),
  ).toHaveAttribute("aria-current", "page");

  /* The account email is there already, verified. */
  const methods = page.getByRole("list", { name: "Contact methods" });
  await expect(methods.getByRole("listitem").first()).toContainText("Verified");
  await noAxeViolations(page);

  await page.getByLabel("Email address").fill(second);
  await page.getByLabel("Label (optional)").fill("Personal");
  await page.getByRole("button", { name: "Add and send code" }).click();
  const added = methods.getByRole("listitem").filter({ hasText: second });
  await expect(added).toContainText("Not verified yet");

  /* A wrong code says so; the emailed one verifies. */
  const code = await emailField(second, "contact-code", "code");
  await page.getByLabel(`Code sent to ${second}`).fill(code === "000000" ? "000001" : "000000");
  await added.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByText("That code isn't right or has expired.")).toBeVisible();
  await noAxeViolations(page);
  await page.getByLabel(`Code sent to ${second}`).fill(code);
  await added.getByRole("button", { name: "Verify" }).click();
  await expect(added).toContainText("Verified");
  await expect(added).not.toContainText("Not verified yet");

  /* High urgency: use the new address five minutes in. */
  const high = page.locator("form").filter({ hasText: "something is down" });
  await high.getByLabel(second).selectOption({ label: "After 5 minutes" });
  await high.getByRole("button", { name: "Save rules" }).click();
  await expect(high.getByText("Rules saved.")).toBeVisible();
  await noAxeViolations(page);

  await page.reload();
  const again = page.locator("form").filter({ hasText: "something is down" });
  await expect(again.getByLabel(second)).toHaveValue("5");
});

test("the app can be installed, and says so when device notifications aren't set up", async ({
  page,
}) => {
  const manifest = await page.request.get("/manifest.webmanifest");
  expect(manifest.status()).toBe(200);
  const body = (await manifest.json()) as {
    display: string;
    start_url: string;
    icons: { src: string; sizes: string; purpose: string }[];
  };
  expect(body).toMatchObject({ display: "standalone", start_url: "/w" });
  expect(body.icons.map((i) => `${i.sizes} ${i.purpose}`)).toEqual([
    "192x192 any",
    "512x512 any",
    "512x512 maskable",
  ]);
  for (const icon of body.icons) {
    const res = await page.request.get(icon.src);
    expect(res.status(), icon.src).toBe(200);
    expect(res.headers()["content-type"]).toBe("image/png");
  }
  const worker = await page.request.get("/sw.js");
  expect(worker.status()).toBe(200);
  expect(await worker.text()).toContain("notificationclick");

  await page.goto(`/w/${workspace()}/notifications`);
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    "href",
    "/manifest.webmanifest",
  );
  await expect(page.getByRole("heading", { name: "Notifications on this device" })).toBeVisible();
  /* The test server has no push keys: the page says so instead of offering a dead button. */
  await expect(
    page.getByText("Notifications on devices aren't set up on this server yet."),
  ).toBeVisible();
  await noAxeViolations(page);
});
