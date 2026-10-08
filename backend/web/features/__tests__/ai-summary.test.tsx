/* The AI summary on an incident: labeled as AI, with its checks, and a rating that can be taken back. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderWithProviders } from "@/test/render";
import { AiSummaryCard } from "@/features/incidents/components/ai-summary";
import type { AiSummary } from "@/features/incidents/api";

const summary: AiSummary = {
  headline: "Checkout API returns 502 from all three regions after a deploy",
  likelyCause: "The proxy can't reach the application behind it.",
  confidence: "medium",
  nextChecks: ["Check whether the service started.", "Look at the proxy's error log."],
  generationId: "0190e2e0-0000-7000-8000-0000000000d4",
};

function renderCard(canRate: boolean) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  let stored: string | null = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      calls.push({ url, method, body });
      if (method === "PUT") stored = (body as { feedback: string | null }).feedback;
      return new Response(JSON.stringify({ feedback: stored }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  renderWithProviders(
    <QueryClientProvider client={client}>
      <AiSummaryCard ws="ws1" summary={summary} canRate={canRate} />
    </QueryClientProvider>,
  );
  return calls;
}

describe("AiSummaryCard", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is labeled as AI and says how sure it is and what to check", () => {
    renderCard(false);
    expect(screen.getByText("AI summary")).toBeInTheDocument();
    expect(screen.getByText("AI")).toBeInTheDocument();
    expect(screen.getByText(summary.headline)).toBeInTheDocument();
    expect(screen.getByText("Look at the proxy's error log.")).toBeInTheDocument();
    expect(screen.getByText(/Medium confidence\. Written by AI/)).toBeInTheDocument();
    /* People who can't respond to incidents don't rate. */
    expect(screen.queryByRole("button", { name: "Helpful" })).toBeNull();
  });

  it("stores a rating, and pressing it again takes it back", async () => {
    const calls = renderCard(true);
    const up = screen.getByRole("button", { name: "Helpful" });
    expect(up).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(up);
    await waitFor(() => expect(up).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByRole("status")).toHaveTextContent("Thanks.");
    fireEvent.click(up);
    await waitFor(() => expect(up).toHaveAttribute("aria-pressed", "false"));
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts.map((c) => c.body)).toEqual([{ feedback: "up" }, { feedback: null }]);
    expect(puts[0]?.url).toBe(
      "/api/w/ws1/ai/generations/0190e2e0-0000-7000-8000-0000000000d4/feedback",
    );
  });
});
