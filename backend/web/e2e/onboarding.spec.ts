/*
 * P1-T17 AC: a new user reaches a delivered test alert in under 3 minutes — sign up, confirm the
 * email, name the workspace, create suggested monitors from a URL, choose email alerts, send a test.
 */
import { expect, test } from "@playwright/test";
import { signUpAndVerify, uniqueEmail } from "./helpers";

test.use({ storageState: { cookies: [], origins: [] } });

test("a new user gets a delivered test alert in under 3 minutes", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "light", "one sign-up per run is enough");
  const started = Date.now();
  const email = uniqueEmail("e2e-onboard");

  await signUpAndVerify(page, email);

  await page.getByLabel("Workspace name").fill("Acme");
  await page.getByRole("button", { name: "Continue" }).click();

  await page.getByLabel("Website or API URL").fill("https://example.com");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("checkbox", { name: /Homepage is up/ })).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: /SSL certificate for example.com/ }),
  ).toBeChecked();
  await page.getByRole("button", { name: "Create monitors" }).click();

  await expect(page.getByLabel("Email alerts to")).toHaveValue(email);
  await page.getByRole("button", { name: "Save and continue" }).click();

  await page.getByRole("button", { name: "Send test alert" }).click();
  await expect(page.getByText(`Test alert delivered to ${email}.`)).toBeVisible();
  expect(Date.now() - started).toBeLessThan(180_000);

  await page.getByRole("button", { name: "Go to overview" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await expect(
    page.getByRole("table").getByRole("link", { name: "example.com homepage" }),
  ).toBeVisible();
  await expect(
    page.getByRole("table").getByRole("link", { name: "example.com certificate" }),
  ).toBeVisible();
});

test("signed-out visitors are sent to sign in", async ({ page }) => {
  await page.goto("/w/00000000-0000-7000-8000-000000000000/overview");
  await expect(page).toHaveURL(/\/login\?next=/);
  await expect(page.getByRole("heading", { name: "Sign in to Watchpost" })).toBeVisible();
});
