/*
 * Invitation emails open a working page: a new teammate creates an account from the invitation,
 * confirms the email, comes back to the invitation and joins the workspace.
 */
import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { emailLink, uniqueEmail, verificationLink } from "./helpers";

const workspace = () =>
  (JSON.parse(readFileSync("e2e/.auth/workspace.json", "utf8")) as { workspaceId: string })
    .workspaceId;

async function noAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

test("an invited teammate signs up from the email and joins the workspace", async ({
  page,
  browser,
}, testInfo) => {
  test.skip(testInfo.project.name !== "light", "one sign-up per run is enough");
  const workspaceId = workspace();
  const email = uniqueEmail("e2e-invitee");

  await page.goto(`/w/${workspaceId}/team`);
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send invite" }).click();
  await expect(page.getByText(`Invitation sent to ${email}.`)).toBeVisible();

  const invitee = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const tab = await invitee.newPage();
  const link = new URL(await emailLink(email, "invite"));
  await tab.goto(link.pathname);
  await expect(tab.getByRole("heading", { name: "Join a workspace" })).toBeVisible();
  await tab.getByRole("link", { name: "Create an account" }).click();

  await tab.getByLabel("Your name").fill("Omar Khan");
  await tab.getByLabel("Work email").fill(email);
  await tab.getByLabel("Password").fill("correct horse battery");
  await tab.getByRole("button", { name: "Create account" }).click();
  await expect(tab.getByRole("heading", { name: "Check your email" })).toBeVisible();

  await tab.goto(await verificationLink(email));
  await expect(tab).toHaveURL(new RegExp(link.pathname));
  await tab.getByRole("button", { name: "Join Shell Co" }).click();
  await expect(tab).toHaveURL(new RegExp(`/w/${workspaceId}/overview`));
  await invitee.close();
});

test("the invite form offers every role but owner and says what each may do", async ({ page }) => {
  await page.goto(`/w/${workspace()}/team`);
  const role = page.getByLabel("Role");
  await expect(role.getByRole("option")).toHaveText([
    "Admin",
    "Member",
    "Responder",
    "Viewer",
    "Billing",
  ]);
  await role.selectOption("responder");
  await expect(page.getByText(/acknowledge, resolve and comment on incidents/)).toBeVisible();
  await role.selectOption("billing");
  await expect(page.getByText(/Billing pages only/)).toBeVisible();
  await noAxeViolations(page);
});

test("a billing member lands on billing and sees nothing else", async ({
  page,
  browser,
}, testInfo) => {
  test.skip(testInfo.project.name !== "light", "one sign-up per run is enough");
  const workspaceId = workspace();
  const email = uniqueEmail("e2e-billing");

  await page.goto(`/w/${workspaceId}/team`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Role").selectOption("billing");
  await page.getByRole("button", { name: "Send invite" }).click();
  await expect(page.getByText(`Invitation sent to ${email}.`)).toBeVisible();

  const invitee = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const tab = await invitee.newPage();
  const link = new URL(await emailLink(email, "invite"));
  await tab.goto(link.pathname);
  await tab.getByRole("link", { name: "Create an account" }).click();
  await tab.getByLabel("Your name").fill("Bilal Accounts");
  await tab.getByLabel("Work email").fill(email);
  await tab.getByLabel("Password").fill("correct horse battery");
  await tab.getByRole("button", { name: "Create account" }).click();
  await expect(tab.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await tab.goto(await verificationLink(email));
  await tab.getByRole("button", { name: "Join Shell Co" }).click();

  /* Joining sends everyone to the overview; the billing role is taken on to billing. */
  await expect(tab).toHaveURL(new RegExp(`/w/${workspaceId}/billing`));
  await expect(tab.getByRole("heading", { level: 1, name: "Billing" })).toBeVisible();
  const nav = tab.getByRole("navigation", { name: "Primary" });
  await expect(nav.getByRole("link")).toHaveText(["Billing"]);

  /* Typing another section's address comes back to billing, and the API refuses the data. */
  await tab.goto(`/w/${workspaceId}/monitors`);
  await expect(tab).toHaveURL(new RegExp(`/w/${workspaceId}/billing`));
  const monitors = await tab.request.get(`/api/w/${workspaceId}/monitors`);
  expect(monitors.status()).toBe(403);
  await noAxeViolations(tab);
  await invitee.close();
});
