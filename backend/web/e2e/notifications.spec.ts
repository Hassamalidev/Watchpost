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
