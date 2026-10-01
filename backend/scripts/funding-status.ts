/*
 * Shows what our provider balances must cover (PRODUCT.md §11 "Upstream funding"):
 *   pnpm --filter @app/api funding:status
 * For each provider: what customers have paid for and not used yet, this month's spend, the balance
 * where the provider reports one, and the auto-reload threshold to set in the provider's console.
 * Read-only: it buys nothing.
 */
import { loadConfig } from "../src/config/index.js";
import { createContainer } from "../src/composition/container.js";
import type { CreditsModule } from "../src/modules/credits/index.js";

const usd = (micros: number | null) =>
  micros === null ? "not reported" : `$${(micros / 1_000_000).toFixed(2)}`;
/* Round up to the next $5, never under $5: providers reload in whole amounts. */
const threshold = (micros: number) => Math.max(5, Math.ceil(micros / 5_000_000) * 5);

const container = createContainer(loadConfig(), { service: "api" });
try {
  const credits = container.modules.find((m) => m.name === "credits") as CreditsModule | undefined;
  if (!credits) throw new Error("credits module is not registered");
  const lines: string[] = [];
  for (const s of await credits.service.fundingStatus()) {
    lines.push(
      `${s.provider}`,
      `  paid for by customers, not used yet   ${usd(s.committedMicros)}`,
      `  allowance for free and trial plans    ${usd(s.platformAllowanceMicros)}`,
      `  balance needed                        ${usd(s.requiredMicros)}`,
      `  spent this month                      ${usd(s.spentThisMonthMicros)} (of which platform-paid ${usd(s.unfundedThisMonthMicros)})`,
      `  balance at the provider               ${usd(s.balanceMicros)}`,
      `  short by                              ${usd(s.shortfallMicros)}`,
      `  set auto-reload to keep at least      $${threshold(s.requiredMicros)}`,
      "",
    );
  }
  process.stdout.write(`${lines.join("\n")}\n`);
} finally {
  await container.close();
}
