/*
 * Invitation emails open a working page: a new teammate creates an account from the invitation,
 * confirms the email, comes back to the invitation and joins the workspace.
 */
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { emailLink, uniqueEmail, verificationLink } from "./helpers";

test("an invited teammate signs up from the email and joins the workspace", async ({
  page,
  browser,
}, testInfo) => {
  test.skip(testInfo.project.name !== "light", "one sign-up per run is enough");
  const { workspaceId } = JSON.parse(readFileSync("e2e/.auth/workspace.json", "utf8")) as {
    workspaceId: string;
  };
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
