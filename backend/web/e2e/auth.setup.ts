/* Creates one signed-in user with a workspace for the shell tests, and saves the session. */
import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test as setup } from "@playwright/test";
import { STORAGE_STATE } from "../playwright.config";
import { signUpAndVerify, uniqueEmail } from "./helpers";

setup("sign up and create a workspace", async ({ page }) => {
  await signUpAndVerify(page, uniqueEmail("e2e-shell"));
  await page.getByLabel("Workspace name").fill("Shell Co");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByLabel("Website or API URL")).toBeVisible();

  const workspaces = await (await page.request.get("/api/auth/organization/list")).json();
  const workspaceId = (workspaces as Array<{ id: string }>)[0]?.id;
  expect(workspaceId).toBeTruthy();
  mkdirSync("e2e/.auth", { recursive: true });
  writeFileSync("e2e/.auth/workspace.json", JSON.stringify({ workspaceId }));
  await page.context().storageState({ path: STORAGE_STATE });
});
