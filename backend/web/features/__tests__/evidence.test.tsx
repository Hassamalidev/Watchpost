/* The incident's evidence panel: what the failing check saw, per region, and what it says once it's gone. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { IncidentEvidenceItem } from "@app/shared";
import { renderWithProviders } from "@/test/render";
import { EvidencePanel } from "@/features/incidents/components/evidence-panel";

const bundle: IncidentEvidenceItem = {
  region: "eu-west",
  checkedAt: "2026-10-05T10:00:00.000Z",
  available: true,
  bundle: {
    version: 1,
    resultId: "018f0000-0000-7000-8000-000000000001",
    monitorId: "018f0000-0000-7000-8000-0000000000aa",
    region: "eu-west",
    checkedAt: "2026-10-05T10:00:00.000Z",
    errorCode: "http_status_unexpected",
    message: "HTTP 502 (expected 2xx)",
    httpStatus: 502,
    latencyMs: 412,
    timings: { dns: 4, connect: 12, tls: 16, ttfb: 370, download: 10, total: 412 },
    ip: "203.0.113.9",
    tls: null,
    details: null,
    headers: { "content-type": "text/html", server: "nginx" },
    bodySnippet: "<h1>502 Bad Gateway</h1>",
    bodyBytes: 24,
    bodyTruncated: false,
  },
};

function renderPanel(items: IncidentEvidenceItem[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ data: items }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithProviders(
    <QueryClientProvider client={client}>
      <EvidencePanel ws="ws1" incidentRef="482" />
    </QueryClientProvider>,
  );
}

describe("EvidencePanel", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows the status, timings in words and numbers, headers and the body", async () => {
    renderPanel([bundle]);
    const region = await screen.findByRole("region", { name: "eu-west" });
    expect(within(region).getByText("The server answered with HTTP 502")).toBeInTheDocument();
    expect(within(region).getByText("http_status_unexpected")).toBeInTheDocument();
    expect(within(region).getByText("Where the time went (412 ms in all)")).toBeInTheDocument();
    /* Never the bar alone: each step has its name and its duration. */
    const step = within(region).getByText("Waiting for first byte").closest("li");
    expect(step).toHaveTextContent("370 ms");
    expect(within(region).getByText("server")).toBeInTheDocument();
    expect(within(region).getByText("nginx")).toBeInTheDocument();
    expect(within(region).getByText("<h1>502 Bad Gateway</h1>")).toBeInTheDocument();
    expect(within(region).getByText("Response body")).toBeInTheDocument();
  });

  it("says when stored evidence is gone, and renders nothing when there is none", async () => {
    const { unmount } = renderPanel([
      { region: "us-east", checkedAt: "2026-09-01T10:00:00.000Z", available: false },
    ]);
    const region = await screen.findByRole("region", { name: "us-east" });
    expect(region).toHaveTextContent("no longer available. It is kept for 30 days.");
    unmount();

    renderPanel([]);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    /* Give the answer time to render, then check the card never appears. */
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText("What the failing check saw")).not.toBeInTheDocument();
  });
});
