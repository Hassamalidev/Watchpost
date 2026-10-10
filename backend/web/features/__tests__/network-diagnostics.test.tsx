/* The network trace on an incident's timeline: a one-line summary, and the two tables behind it. */
import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import { NetworkDiagnosticsEvent } from "@/features/incidents/components/network-diagnostics";

const data = {
  region: "eu-west",
  host: "shop.example.com",
  address: "203.0.113.9",
  traceroute: {
    tool: "tracepath",
    hops: [
      { hop: 1, ip: "192.0.2.1", rttMs: 0.4 },
      { hop: 2, ip: null, rttMs: null },
    ],
    reached: false,
  },
  dnsTrace: {
    name: "shop.example.com",
    steps: [
      {
        zone: ".",
        server: "a.root-servers.net (198.41.0.4)",
        ms: 18,
        outcome: "referral",
        detail: "com is served by a.gtld-servers.net",
      },
      {
        zone: "com",
        server: "a.gtld-servers.net (192.5.6.30)",
        ms: 21,
        outcome: "nxdomain",
        detail: "com says shop.example.com does not exist",
      },
    ],
  },
  notes: [],
  tookMs: 4200,
};

describe("NetworkDiagnosticsEvent", () => {
  it("says in one line where the path and the name end", () => {
    renderWithProviders(<NetworkDiagnosticsEvent data={data} />);
    const summary = screen.getByText(/eu-west: path and DNS for shop.example.com/);
    expect(summary).toHaveTextContent("the path stops before the target");
    expect(summary).toHaveTextContent("No such name");
  });

  it("lists every hop and every DNS step in tables with headers", () => {
    renderWithProviders(<NetworkDiagnosticsEvent data={data} />);
    const path = screen.getByRole("table", { name: "Path to 203.0.113.9", hidden: true });
    const hops = within(path).getAllByRole("row", { hidden: true });
    expect(hops).toHaveLength(3);
    expect(hops[1]).toHaveTextContent("192.0.2.1");
    expect(hops[1]).toHaveTextContent("0.4 ms");
    expect(hops[2]).toHaveTextContent("no reply");
    const dns = screen.getByRole("table", {
      name: "How shop.example.com resolves, from the root down",
      hidden: true,
    });
    expect(within(dns).getAllByRole("row", { hidden: true })[2]).toHaveTextContent(
      "No such name: com says shop.example.com does not exist (21 ms)",
    );
  });

  it("shows the notes when nothing could be traced, and nothing at all for data it can't read", () => {
    const { container, unmount } = renderWithProviders(
      <NetworkDiagnosticsEvent
        data={{
          ...data,
          address: null,
          traceroute: null,
          dnsTrace: null,
          notes: ["This probe has no path-tracing tool installed."],
        }}
      />,
    );
    expect(container).toHaveTextContent("This probe has no path-tracing tool installed.");
    expect(screen.queryByRole("table", { hidden: true })).not.toBeInTheDocument();
    unmount();
    const broken = renderWithProviders(<NetworkDiagnosticsEvent data={{ region: "eu-west" }} />);
    expect(broken.container.querySelector("details")).toBeNull();
  });
});
