/*
 * What we hold at the providers we pay for usage (PRODUCT.md §11 "Upstream funding").
 *
 * Checked on 2026-10-01: neither provider sells prepaid balance through an API.
 * - Anthropic: credits are bought in the Console (Settings → Billing), by hand or by auto-reload
 *   (a minimum balance and a reload amount). No endpoint to buy credits or to read the balance.
 * - Twilio: funds are added in the Console, by hand or by auto-recharge. The Balance resource is
 *   read-only.
 * So the purchase itself is the provider's auto-reload, set up once with the company card. What this
 * code adds is the check: where a provider reports its balance, we compare it with what customers
 * have already paid for and warn the owner before it runs short.
 */
export type FundedProvider = "anthropic" | "twilio";

export interface ProviderBalanceReader {
  provider: FundedProvider;
  /* Prepaid balance in micro-USD, or null when the provider doesn't report one. */
  balanceMicros(): Promise<number | null>;
}

export const TWILIO_BALANCE_URL = (accountSid: string) =>
  `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Balance.json`;

export function createTwilioBalanceReader(options: {
  accountSid: string;
  authToken: string;
  fetch?: typeof fetch;
}): ProviderBalanceReader {
  const doFetch = options.fetch ?? fetch;
  return {
    provider: "twilio",
    async balanceMicros() {
      const res = await doFetch(TWILIO_BALANCE_URL(options.accountSid), {
        headers: {
          authorization: `Basic ${Buffer.from(`${options.accountSid}:${options.authToken}`).toString("base64")}`,
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`Twilio balance answered HTTP ${res.status}`);
      const body = (await res.json()) as { balance?: string; currency?: string };
      const balance = Number(body.balance);
      /* Budgets are in USD; an account in another currency can't be compared, so report nothing. */
      if (!Number.isFinite(balance) || body.currency !== "USD") return null;
      return Math.round(balance * 1_000_000);
    },
  };
}

/* Anthropic exposes no balance, so the check relies on its auto-reload alone. */
export const anthropicBalanceReader: ProviderBalanceReader = {
  provider: "anthropic",
  balanceMicros: async () => null,
};
