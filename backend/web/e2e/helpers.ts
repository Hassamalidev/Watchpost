/*
 * E2E helpers: sign up through the UI and confirm the email with the link the API queued (read from
 * the outbox, as the email worker would send it). No test-only endpoints exist in the product.
 */
import { randomBytes } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import pg from "pg";
import { E2E_DATABASE_URL } from "../playwright.config";

export const uniqueEmail = (who: string) => `${who}-${randomBytes(4).toString("hex")}@example.com`;

export async function verificationLink(email: string): Promise<string> {
  const client = new pg.Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  try {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const { rows } = await client.query<{ url: string }>(
        `select payload->'data'->>'url' as url from outbox_events
         where type = 'email.requested' and payload->>'to' = $1 and payload->>'template' = 'verify-email'
         order by created_at desc limit 1`,
        [email],
      );
      if (rows[0]?.url) return rows[0].url;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`no verification email for ${email}`);
  } finally {
    await client.end();
  }
}

/* Signs up through the UI and opens the verification link; ends signed in on /onboarding. */
export async function signUpAndVerify(page: Page, email: string, name = "Sara Ahmed") {
  await page.goto("/signup");
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await page.goto(await verificationLink(email));
  await expect(page).toHaveURL(/\/onboarding/);
}
