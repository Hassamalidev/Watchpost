/*
 * Billing page (P3-T06): what the plan picker offers in every subscription state, the Paddle checkout
 * call, and the page itself against a stubbed API: a trial workspace, a subscriber who cancels with a
 * reason, a credit pack purchase, and a member who can only read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BillingState, CatalogPlan, CreditsState, PlanLimits } from "@app/shared";
import { WorkspaceContext, type WorkspaceRole } from "@/components/app/workspace-context";
import { renderWithProviders } from "@/test/render";
import { BillingPage } from "../components/billing-page";
import { PADDLE_JS_URL, openCheckout } from "../paddle";
import { daysUntil, formatCheckInterval, formatUsd, planAction } from "../plan";

const WS = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

const limits = (monitors: number, monthlyCredits: number): PlanLimits => ({
  monitors,
  heartbeats: 5,
  minIntervalSeconds: 180,
  regionsPerMonitor: 2,
  members: 3,
  historyDays: 30,
  monthlyCredits,
  onCallSchedules: 0,
  escalationPolicies: 0,
  inboundSources: 1,
  statusPages: 1,
  statusSubscribers: 0,
  aiGenerationsPerMonth: 20,
  privateProbes: 0,
  clientWorkspaces: 0,
});

const features = {
  smsVoice: false,
  customStatusDomain: false,
  privateStatusPages: false,
  whiteLabel: false,
  apiWrite: false,
  monthlyEmailReport: false,
  slaReports: false,
  sso: false,
  auditLog: false,
  customRoles: false,
};

const plan = (
  key: CatalogPlan["key"],
  name: string,
  monthlyUsd: number,
  annualMonthlyUsd: number,
  sold = true,
): CatalogPlan => ({
  key,
  name,
  limits: limits(key === "free" ? 20 : 150, key === "free" ? 0 : 150),
  features,
  monthlyUsd,
  annualMonthlyUsd,
  purchasable: { month: sold && key !== "free", year: sold && key !== "free" },
});

function billingState(patch: Partial<BillingState> = {}, sold = true): BillingState {
  return {
    entitlements: {
      plan: "free",
      planName: "Free",
      source: "free",
      trialEndsAt: null,
      graceEndsAt: null,
      limits: limits(20, 0),
      features,
    },
    subscription: null,
    usage: { members: { used: 2, limit: 3 } },
    catalog: {
      plans: [
        plan("free", "Free", 0, 0),
        plan("starter", "Starter", 9, 7.5, sold),
        plan("pro", "Pro", 29, 24, sold),
        plan("business", "Business", 79, 66, sold),
      ],
      creditPacks: [
        { credits: 100, usd: 6, purchasable: sold },
        { credits: 500, usd: 25, purchasable: sold },
      ],
    },
    paddle: sold ? { environment: "sandbox", clientToken: "test_token" } : null,
    portalAvailable: false,
    foundingOfferAvailable: false,
    isFoundingCustomer: false,
    ...patch,
  };
}

const subscribed = (patch: Partial<NonNullable<BillingState["subscription"]>> = {}) =>
  billingState({
    entitlements: {
      ...billingState().entitlements,
      plan: "pro",
      planName: "Pro",
      source: "subscription",
    },
    subscription: {
      status: "active",
      plan: "pro",
      interval: "month",
      currentPeriodEnd: "2026-11-12T12:00:00.000Z",
      scheduledChange: null,
      downgrade: null,
      ...patch,
    },
    portalAvailable: true,
  });

describe("planAction", () => {
  const of = (state: BillingState, key: string, interval: "month" | "year") => {
    const target = state.catalog.plans.find((p) => p.key === key);
    if (target === undefined) throw new Error(`no plan ${key}`);
    return planAction(state, target, interval);
  };

  it("offers a checkout for every paid plan when there is no subscription", () => {
    const state = billingState();
    expect(of(state, "free", "month")).toBe("current");
    expect(of(state, "starter", "month")).toBe("subscribe");
    expect(of(state, "business", "year")).toBe("subscribe");
    expect(of(billingState({}, false), "pro", "month")).toBe("unavailable");
  });

  it("shows Free as reachable by canceling during a trial or a subscription", () => {
    const trial = billingState({
      entitlements: { ...billingState().entitlements, plan: "pro", source: "trial" },
    });
    expect(of(trial, "free", "month")).toBe("free");
    expect(of(subscribed(), "free", "month")).toBe("free");
  });

  it("offers upgrades, same-interval downgrades and the switch to yearly", () => {
    const state = subscribed();
    expect(of(state, "pro", "month")).toBe("current");
    expect(of(state, "business", "month")).toBe("upgrade");
    expect(of(state, "business", "year")).toBe("upgrade");
    expect(of(state, "pro", "year")).toBe("switch_yearly");
    expect(of(state, "starter", "month")).toBe("downgrade");
    expect(of(state, "starter", "year")).toBe("blocked_interval");
  });

  it("blocks changes while yearly, paused, overdue or set to cancel", () => {
    expect(of(subscribed({ interval: "year" }), "starter", "month")).toBe("blocked_yearly");
    expect(of(subscribed({ interval: "year" }), "business", "year")).toBe("upgrade");
    expect(of(subscribed({ status: "past_due" }), "business", "month")).toBe("blocked_status");
    expect(of(subscribed({ status: "paused" }), "business", "month")).toBe("blocked_status");
    expect(
      of(
        subscribed({ scheduledChange: { action: "cancel", effectiveAt: "2026-11-12T12:00:00Z" } }),
        "business",
        "month",
      ),
    ).toBe("blocked_status");
  });
});

describe("formatting", () => {
  it("writes prices, check intervals and days left", () => {
    expect(formatUsd(9)).toBe("$9");
    expect(formatUsd(7.5)).toBe("$7.50");
    expect(formatUsd(792)).toBe("$792");
    expect(formatCheckInterval(180)).toBe("3 min");
    expect(formatCheckInterval(30)).toBe("30 s");
    const now = Date.parse("2026-10-01T00:00:00Z");
    expect(daysUntil("2026-10-15T00:00:00Z", now)).toBe(14);
    expect(daysUntil("2026-10-01T06:00:00Z", now)).toBe(1);
    expect(daysUntil("2026-09-01T00:00:00Z", now)).toBe(0);
  });
});

describe("openCheckout", () => {
  it("initializes Paddle once and opens the overlay with the signed custom data", async () => {
    const paddle = {
      Environment: { set: vi.fn() },
      Initialize: vi.fn(),
      Checkout: { open: vi.fn() },
    };
    window.Paddle = paddle;
    const onEvent = vi.fn();
    const session = {
      items: [{ priceId: "pri_pro", quantity: 1 }],
      customerEmail: "sara@example.com",
      customData: { workspaceId: WS, userId: "u1", sig: "signed" },
      discountId: "dsc_founding",
    };
    const options = {
      paddle: { environment: "sandbox" as const, clientToken: "test_token" },
      session,
      theme: "dark" as const,
      onEvent,
    };
    await openCheckout(options);
    await openCheckout({ ...options, session: { ...session, discountId: null } });

    expect(PADDLE_JS_URL).toBe("https://cdn.paddle.com/paddle/v2/paddle.js");
    expect(paddle.Environment.set).toHaveBeenCalledWith("sandbox");
    expect(paddle.Initialize).toHaveBeenCalledTimes(1);
    expect(paddle.Initialize.mock.calls[0]?.[0]).toMatchObject({ token: "test_token" });
    expect(paddle.Checkout.open).toHaveBeenNthCalledWith(1, {
      items: session.items,
      customer: { email: "sara@example.com" },
      customData: session.customData,
      discountId: "dsc_founding",
      settings: { displayMode: "overlay", theme: "dark", allowLogout: false },
    });
    expect(paddle.Checkout.open.mock.calls[1]?.[0]).not.toHaveProperty("discountId");

    /* Paddle's events reach whoever opened the checkout. */
    const callback = paddle.Initialize.mock.calls[0]?.[0].eventCallback as (e: object) => void;
    callback({ name: "checkout.completed" });
    expect(onEvent).toHaveBeenCalledWith({ name: "checkout.completed" });
    delete window.Paddle;
  });
});

describe("BillingPage", { timeout: 30_000 }, () => {
  let state: BillingState;
  let credits: CreditsState;
  const calls: Array<{ method: string; path: string; body: unknown }> = [];

  const emptyCredits: CreditsState = {
    included: 0,
    purchased: 0,
    total: 0,
    monthlyAllowance: 0,
    lowBalance: false,
    recent: [],
  };

  beforeEach(() => {
    calls.length = 0;
    credits = emptyCredits;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        const path = input.replace(`/api/w/${WS}`, "");
        const method = init?.method ?? "GET";
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ method, path, body });
        const json = (data: unknown, status = 200) =>
          new Response(JSON.stringify(data), { status });
        if (path === "/billing" && method === "GET") return json(state);
        if (path === "/credits") return json(credits);
        if (path === "/monitor-usage") {
          return json({
            monitors: { used: 20, limit: 20 },
            heartbeats: { used: 1, limit: 5 },
            pausedByPlan: 2,
          });
        }
        if (path === "/billing/cancel") {
          state = subscribed({
            scheduledChange: { action: "cancel", effectiveAt: "2026-11-12T12:00:00.000Z" },
          });
          return json(state);
        }
        if (path === "/billing/resume") {
          state = subscribed();
          return json(state);
        }
        if (path === "/billing/credits") {
          credits = { ...credits, purchased: credits.purchased + 100, total: credits.total + 100 };
          return json({ status: "charging" }, 202);
        }
        return json({ code: "not_found", detail: "No route." }, 404);
      }),
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function renderPage(role: WorkspaceRole = "owner") {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return renderWithProviders(
      <QueryClientProvider client={client}>
        <WorkspaceContext.Provider
          value={{
            id: WS,
            name: "Acme",
            role,
            user: { id: "u1", email: "sara@example.com", name: "Sara" },
          }}
        >
          <BillingPage />
        </WorkspaceContext.Provider>
      </QueryClientProvider>,
    );
  }

  it("explains the trial, shows usage against the plan and says when checkout is off", async () => {
    state = billingState(
      {
        entitlements: {
          ...billingState().entitlements,
          plan: "pro",
          planName: "Pro",
          source: "trial",
          trialEndsAt: new Date(Date.now() + 10 * 86_400_000).toISOString(),
        },
      },
      false,
    );
    renderPage();
    expect(await screen.findByText("Pro plan")).toBeInTheDocument();
    expect(screen.getByText(/Free trial of Pro, no card needed/)).toHaveTextContent(
      /10 days left.*nothing is deleted/,
    );
    const monitors = await screen.findByRole("meter", { name: "Monitors: 20 of 20" });
    expect(monitors).toHaveAttribute("aria-valuenow", "20");
    expect(screen.getByRole("meter", { name: "Team members: 2 of 3" })).toBeInTheDocument();
    expect(screen.getByText(/2 monitors are paused because of the plan limit/)).toBeInTheDocument();
    expect(screen.getAllByText("Checkout isn't set up on this server yet.")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: /Choose/ })).not.toBeInTheDocument();
    expect(await screen.findByText(/This plan has no SMS or voice credits/)).toBeInTheDocument();
    /* Nothing to cancel and no invoices yet. */
    expect(screen.queryByRole("button", { name: "Cancel subscription" })).not.toBeInTheDocument();
    expect(screen.getByText("Invoices appear here after your first payment.")).toBeInTheDocument();
  });

  it("shows yearly prices and offers each plan when checkout is on", async () => {
    state = billingState({ foundingOfferAvailable: true });
    renderPage();
    const user = userEvent.setup();
    expect(await screen.findByRole("button", { name: "Choose Starter" })).toBeEnabled();
    expect(screen.getByText("$9 per month")).toBeInTheDocument();
    expect(screen.getByText(/first 100 paying workspaces get 30% off/)).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Yearly (two months free)" }));
    expect(screen.getByText("$7.50 per month, billed yearly ($90)")).toBeInTheDocument();
    expect(screen.getByText("$66 per month, billed yearly ($792)")).toBeInTheDocument();
  });

  it("lets a subscriber cancel with a reason, then keep the subscription", async () => {
    state = subscribed();
    renderPage();
    const user = userEvent.setup();
    expect(await screen.findByText(/Billed monthly\. Renews on November 12, 2026/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Upgrade to Business" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Move to Starter" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Cancel subscription" }));
    expect(screen.getByRole("heading", { name: "Cancel your subscription" })).toBeVisible();
    const confirm = screen.getByRole("button", { name: "Cancel at the end of the period" });
    expect(confirm).toBeDisabled();
    expect(screen.getByRole("button", { name: "Pause instead" })).toBeEnabled();
    await user.selectOptions(screen.getByLabelText("Why are you canceling?"), "too_expensive");
    await user.type(screen.getByLabelText("Anything else? (optional)"), "Budget cut");
    await user.click(confirm);

    expect(await screen.findByText(/The subscription ends on November 12, 2026/)).toBeVisible();
    expect(calls.find((c) => c.path === "/billing/cancel")?.body).toEqual({
      reason: "too_expensive",
      comment: "Budget cut",
    });
    /* A scheduled cancel blocks plan changes and replaces the cancel form with "keep". */
    expect(screen.queryByRole("button", { name: "Upgrade to Business" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel subscription" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Keep subscription" }));
    expect(await screen.findByRole("button", { name: "Cancel subscription" })).toBeVisible();
    expect(calls.some((c) => c.path === "/billing/resume" && c.method === "POST")).toBe(true);
  });

  it("buys a credit pack after confirming the charge", async () => {
    state = subscribed();
    credits = {
      included: 3,
      purchased: 0,
      total: 3,
      monthlyAllowance: 150,
      lowBalance: true,
      recent: [
        {
          id: "e1",
          delta: -2,
          bucket: "included",
          reason: "charge",
          balanceAfter: 3,
          createdAt: "2026-10-01T10:00:00.000Z",
        },
      ],
    };
    renderPage();
    const user = userEvent.setup();
    expect(await screen.findByText("3 credits left")).toBeVisible();
    expect(screen.getByText(/Credits are running low/)).toBeVisible();
    const history = screen.getByText("Alert sent").closest("ul");
    if (history === null) throw new Error("no credit history list");
    expect(within(history).getByText("-2")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Buy 100 credits for $6" }));
    expect(window.confirm).toHaveBeenCalledWith(
      "Buy 100 credits for $6? Your saved payment method is charged now.",
    );
    expect(calls.find((c) => c.path === "/billing/credits")?.body).toEqual({ credits: 100 });
    await waitFor(() => expect(screen.getByText("103 credits left")).toBeVisible(), {
      timeout: 5_000,
    });
    expect(screen.getByText("Credits added.")).toBeVisible();
  });

  it("is read-only for members", async () => {
    state = subscribed();
    renderPage("member");
    expect(await screen.findByText("Pro plan")).toBeVisible();
    expect(
      screen.getByText(/Owners, admins and billing members can change the plan/),
    ).toBeVisible();
    await screen.findByText("0 credits left");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByText("Invoices and payment method")).not.toBeInTheDocument();
  });
});
