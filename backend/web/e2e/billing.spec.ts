/*
 * P3-T06: the billing page in light and dark with no axe violations.
 * - Against the real API (no Paddle keys in e2e): a new workspace sees its Pro trial, usage against
 *   the plan, every plan's limits, and a clear note that checkout isn't set up.
 * - With the billing API and Paddle.js stubbed: a user subscribes through the checkout overlay,
 *   upgrades, buys a credit pack, cancels with a reason and keeps the subscription after all, without
 *   contacting support (the task's acceptance criterion). The API side of each call is covered by the
 *   backend's integration tests.
 */
import { readFileSync } from "node:fs";
import { expect, test, type Page, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type { BillingState, CreditsState } from "@app/shared";

const workspace = () =>
  (JSON.parse(readFileSync("e2e/.auth/workspace.json", "utf8")) as { workspaceId: string })
    .workspaceId;
const billingPath = () => `/w/${workspace()}/billing`;

async function noAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

test("a new workspace sees its trial, its usage and the plans", async ({ page }) => {
  await page.goto(billingPath());
  await expect(page.getByRole("heading", { level: 1, name: "Billing" })).toBeVisible();
  await expect(page.getByText("Pro plan", { exact: true })).toBeVisible();
  await expect(page.getByText(/Free trial of Pro, no card needed/)).toBeVisible();
  await expect(page.getByRole("meter", { name: /^Monitors: \d+ of 150$/ })).toBeVisible();
  await expect(page.getByRole("meter", { name: /^Heartbeat monitors: \d+ of 75$/ })).toBeVisible();
  await expect(page.getByText(/\d+ \(no limit\)/)).toBeVisible();

  for (const name of ["Free", "Starter", "Pro", "Business"]) {
    await expect(page.getByRole("heading", { level: 3, name, exact: true })).toBeVisible();
  }
  await expect(page.getByText("$29 per month")).toBeVisible();
  await page.getByRole("radio", { name: "Yearly (two months free)" }).check();
  await expect(page.getByText("$24 per month, billed yearly ($288)")).toBeVisible();
  /* The e2e server has no Paddle keys: plans are shown, checkout is plainly off. */
  await expect(page.getByText("Checkout isn't set up on this server yet.")).toHaveCount(3);
  await expect(page.getByRole("button", { name: /^Choose / })).toHaveCount(0);
  await expect(page.getByText(/This plan has no SMS or voice credits/)).toBeVisible();
  await noAxeViolations(page);
});

const PADDLE_STUB = `
  window.__paddle = { initialize: [], open: [], environment: null };
  window.Paddle = {
    Environment: { set: (value) => { window.__paddle.environment = value; } },
    Initialize: (options) => {
      window.__paddle.initialize.push({ token: options.token });
      window.__paddle.callback = options.eventCallback;
    },
    Checkout: {
      open: (options) => {
        window.__paddle.open.push(options);
        setTimeout(() => window.__paddle.callback({ name: "checkout.completed" }), 50);
      },
    },
  };
`;

test("a user subscribes, upgrades, buys credits and cancels on their own", async ({
  page,
}, testInfo) => {
  /* One long journey (two webhook waits, three accessibility scans): give it room on a busy runner. */
  test.setTimeout(120_000);
  /* Start from what the API really returns, so the stub can't drift from the real shape. */
  const real = (await (
    await page.request.get(`/api/w/${workspace()}/billing`)
  ).json()) as BillingState;
  const planName = (key: string) => real.catalog.plans.find((p) => p.key === key)?.name ?? key;
  const limitsOf = (key: string) =>
    real.catalog.plans.find((p) => p.key === key)?.limits ?? real.entitlements.limits;

  let state: BillingState = {
    ...real,
    entitlements: {
      ...real.entitlements,
      plan: "free",
      planName: "Free",
      source: "free",
      trialEndsAt: null,
      limits: limitsOf("free"),
    },
    catalog: {
      plans: real.catalog.plans.map((p) => ({
        ...p,
        purchasable: { month: p.key !== "free", year: p.key !== "free" },
      })),
      creditPacks: real.catalog.creditPacks.map((p) => ({ ...p, purchasable: true })),
    },
    paddle: { environment: "sandbox", clientToken: "test_e2e_token" },
  };
  let credits: CreditsState = {
    included: 0,
    purchased: 0,
    total: 0,
    monthlyAllowance: 0,
    lowBalance: false,
    recent: [],
  };
  const subscribedTo = (plan: "starter" | "pro"): BillingState => ({
    ...state,
    entitlements: {
      ...state.entitlements,
      plan,
      planName: planName(plan),
      source: "subscription",
      limits: limitsOf(plan),
    },
    subscription: {
      status: "active",
      plan,
      interval: "month",
      currentPeriodEnd: "2026-11-12T12:00:00.000Z",
      scheduledChange: null,
      downgrade: null,
    },
    portalAvailable: true,
  });
  const posts: Array<{ path: string; body: unknown }> = [];
  /* The webhook hasn't arrived for the first poll after checkout. */
  let pollsUntilActive = -1;

  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

  await page.route("https://cdn.paddle.com/paddle/v2/paddle.js", (route) =>
    route.fulfill({ contentType: "text/javascript", body: PADDLE_STUB }),
  );
  await page.route("**/api/w/*/credits", (route) => json(route, credits));
  await page.route("**/api/w/*/billing", (route) => {
    if (pollsUntilActive > 0) pollsUntilActive -= 1;
    else if (pollsUntilActive === 0) {
      pollsUntilActive = -1;
      state = subscribedTo("starter");
      credits = { ...credits, included: 25, total: 25, monthlyAllowance: 25 };
    }
    return json(route, state);
  });
  await page.route("**/api/w/*/billing/*", (route) => {
    const request = route.request();
    const action = new URL(request.url()).pathname.split("/").at(-1) ?? "";
    const body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
    posts.push({ path: action, body });
    if (action === "checkout") {
      pollsUntilActive = 1;
      return json(route, {
        items: [{ priceId: "pri_e2e_starter", quantity: 1 }],
        customerEmail: "owner@example.com",
        customData: { workspaceId: workspace(), userId: "user-1", sig: "signed-by-api" },
        discountId: null,
      });
    }
    if (action === "plan") {
      state = subscribedTo("pro");
      credits = { ...credits, included: 150, total: 150, monthlyAllowance: 150 };
      return json(route, state);
    }
    if (action === "credits") {
      credits = { ...credits, purchased: 100, total: credits.total + 100 };
      return json(route, { status: "charging" }, 202);
    }
    if (action === "cancel" && state.subscription !== null) {
      state = {
        ...state,
        subscription: {
          ...state.subscription,
          scheduledChange: { action: "cancel", effectiveAt: "2026-11-12T12:00:00.000Z" },
        },
      };
      return json(route, state);
    }
    if (action === "resume" && state.subscription !== null) {
      state = { ...state, subscription: { ...state.subscription, scheduledChange: null } };
      return json(route, state);
    }
    return json(route, { code: "not_found", detail: "No route." }, 404);
  });
  page.on("dialog", (dialog) => void dialog.accept());

  /* Subscribe through Paddle's overlay. */
  await page.goto(billingPath());
  await expect(page.getByText("Free plan", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Choose Starter" }).click();
  await expect(page.getByText("Payment received. Activating your plan…")).toBeVisible();
  await expect(page.getByText("Starter plan", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Payment received. Activating your plan…")).toBeHidden();
  /* Only plain data crosses back from the page (the stub also holds the event callback). */
  const paddle = await page.evaluate(() => {
    const recorded = (
      window as unknown as {
        __paddle: { environment: string; initialize: unknown[]; open: unknown[] };
      }
    ).__paddle;
    return {
      environment: recorded.environment,
      initialize: recorded.initialize,
      open: recorded.open,
    };
  });
  expect(paddle.environment).toBe("sandbox");
  expect(paddle.initialize).toEqual([{ token: "test_e2e_token" }]);
  expect(paddle.open).toEqual([
    {
      items: [{ priceId: "pri_e2e_starter", quantity: 1 }],
      customer: { email: "owner@example.com" },
      customData: { workspaceId: workspace(), userId: "user-1", sig: "signed-by-api" },
      settings: { displayMode: "overlay", theme: testInfo.project.name, allowLogout: false },
    },
  ]);
  expect(posts[0]).toEqual({ path: "checkout", body: { plan: "starter", interval: "month" } });
  await expect(page.getByText("25 credits left")).toBeVisible();

  /* Upgrade. */
  await page.getByRole("button", { name: "Upgrade to Pro" }).click();
  await expect(page.getByText("Pro plan", { exact: true })).toBeVisible();
  await expect(page.getByText(/Billed monthly\. Renews on November 12, 2026/)).toBeVisible();
  await expect(page.getByText("150 credits left")).toBeVisible();

  /* Buy a credit pack with the saved payment method. */
  await page.getByRole("button", { name: "Buy 100 credits for $6" }).click();
  await expect(page.getByText("Credits added.")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("250 credits left")).toBeVisible();
  await noAxeViolations(page);

  /* Cancel with a reason, then change one's mind. */
  await page.getByRole("button", { name: "Cancel subscription" }).click();
  await expect(page.getByRole("heading", { name: "Cancel your subscription" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Cancel at the end of the period" }),
  ).toBeDisabled();
  await page.getByLabel("Why are you canceling?").selectOption("missing_feature");
  await page.getByLabel("Anything else? (optional)").fill("Need SAML on Pro");
  await noAxeViolations(page);
  await page.getByRole("button", { name: "Cancel at the end of the period" }).click();
  await expect(page.getByText(/The subscription ends on November 12, 2026/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel subscription" })).toHaveCount(0);
  await page.getByRole("button", { name: "Keep subscription" }).click();
  await expect(page.getByRole("button", { name: "Cancel subscription" })).toBeVisible();

  expect(posts.map((p) => p.path)).toEqual(["checkout", "plan", "credits", "cancel", "resume"]);
  expect(posts[1]?.body).toEqual({ plan: "pro", interval: "month" });
  expect(posts[2]?.body).toEqual({ credits: 100 });
  expect(posts[3]?.body).toEqual({ reason: "missing_feature", comment: "Need SAML on Pro" });
  await noAxeViolations(page);
});
