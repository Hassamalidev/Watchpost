/* The app shell renders in light and dark (one Playwright project per color scheme) with no axe violations. */
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const OVERVIEW = "/w/demo/overview";

test("app shell renders with navigation, header and main", async ({ page }) => {
  await page.goto(OVERVIEW);
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Overview" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByRole("main")).toBeVisible();
});

test("follows the system color scheme", async ({ page }, testInfo) => {
  await page.goto(OVERVIEW);
  const html = page.locator("html");
  if (testInfo.project.name === "dark") await expect(html).toHaveClass(/dark/);
  else await expect(html).not.toHaveClass(/dark/);

  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.screenshot({
    path: testInfo.outputPath(`shell-${testInfo.project.name}.png`),
    fullPage: true,
  });
  expect(background).not.toBe("");
});

test("theme toggle switches between light and dark", async ({ page }) => {
  await page.goto(OVERVIEW);
  const html = page.locator("html");
  const toggle = page.getByRole("button", { name: /Toggle theme/ });
  await expect(toggle).toHaveAccessibleName(/System/);
  await toggle.click();
  await expect(html).not.toHaveClass(/dark/);
  await toggle.click();
  await expect(html).toHaveClass(/dark/);
});

test("⌘K palette opens and navigates", async ({ page }) => {
  await page.goto(OVERVIEW);
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.getByRole("dialog", { name: "Command palette" });
  await expect(dialog).toBeVisible();
  await page.keyboard.type("monit");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/w\/demo\/monitors$/);
  await expect(page.getByRole("heading", { level: 1, name: "Monitors" })).toBeVisible();
});

test("skip link moves focus to main content", async ({ page }) => {
  await page.goto(OVERVIEW);
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await skip.press("Enter");
  await expect(page).toHaveURL(/#main$/);
});

test("unknown sections return 404", async ({ page }) => {
  const response = await page.goto("/w/demo/does-not-exist");
  expect(response?.status()).toBe(404);
});

for (const path of ["/", OVERVIEW, "/w/demo/monitors"]) {
  test(`no axe violations on ${path}`, async ({ page }) => {
    await page.goto(path);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
}

test("no axe violations with the command palette open", async ({ page }) => {
  await page.goto(OVERVIEW);
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByRole("dialog")).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});
