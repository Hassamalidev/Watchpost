/* Status pages: host names, the address suggested for a name, and what the public page renders. */
import type * as React from "react";
import { render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import type { PublicStatusPage } from "@app/shared";
import messages from "@/messages/en.json";
import { badgeMarkdown } from "@/features/monitors/components/badges-card";
import { slugFromName } from "@/features/statuspages/api";
import {
  StatusPageView,
  groupComponents,
} from "@/features/statuspages/components/status-page-view";
import { isStatusRef } from "@/features/statuspages/public";
import { statusBaseDomain, statusPathFor, statusRefForHost } from "@/lib/status-host";

const days = Array.from({ length: 90 }, (_, index) => ({
  date: new Date(Date.UTC(2026, 6, 10 + index)).toISOString().slice(0, 10),
  status: index === 80 ? ("major" as const) : ("up" as const),
  uptimePercent: index === 80 ? 97.2 : 100,
}));

const page = (patch: Partial<PublicStatusPage> = {}): PublicStatusPage => ({
  page: {
    name: "Acme",
    slug: "acme",
    url: "https://acme.status.example.net",
    branding: {
      logoUrl: null,
      faviconUrl: null,
      accentColor: "#2563eb",
      description: "Live status of Acme.",
      supportUrl: "https://acme.example.net/support",
    },
    subscribe: false,
    showUptime: true,
    poweredByUrl: "https://watchpost.example.net",
  },
  status: "partial_outage",
  components: [
    {
      id: "c1",
      name: "API",
      description: null,
      group: "Core",
      status: "major_outage",
      uptime: { percent: 99.97, days },
    },
    {
      id: "c2",
      name: "Website",
      description: "Marketing site",
      group: null,
      status: "operational",
      uptime: null,
    },
    {
      id: "c3",
      name: "Workers",
      description: null,
      group: "Core",
      status: "unknown",
      uptime: null,
    },
  ],
  incidents: {
    active: [
      {
        id: "i1",
        title: "API errors",
        status: "identified",
        impact: "major_outage",
        components: ["API"],
        startedAt: "2026-10-07T10:00:00.000Z",
        resolvedAt: null,
        updates: [
          {
            id: "u2",
            status: "identified",
            message: "A bad deploy.",
            at: "2026-10-07T10:10:00.000Z",
          },
          {
            id: "u1",
            status: "investigating",
            message: "Looking.",
            at: "2026-10-07T10:00:00.000Z",
          },
        ],
      },
    ],
    recent: [],
  },
  maintenance: [
    {
      id: "m1",
      name: "Database upgrade",
      active: false,
      startsAt: "2026-10-09T02:00:00.000Z",
      endsAt: "2026-10-09T03:00:00.000Z",
      components: ["API"],
    },
  ],
  generatedAt: "2026-10-07T10:11:00.000Z",
  ...patch,
});

const show = (
  data: PublicStatusPage,
  feedBase?: string,
  extra: Partial<React.ComponentProps<typeof StatusPageView>> = {},
) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <StatusPageView data={data} {...(feedBase === undefined ? {} : { feedBase })} {...extra} />
    </NextIntlClientProvider>,
  );

describe("badges", () => {
  it("builds the Markdown to paste: the image, linking back to us", () => {
    expect(
      badgeMarkdown(
        "API status",
        "https://app.acme.io/api/public/badges/x.y/status.svg",
        "https://acme.io",
      ),
    ).toBe(
      "[![API status](https://app.acme.io/api/public/badges/x.y/status.svg)](https://acme.io)",
    );
    /* Brackets in a monitor's name can't break the link. */
    expect(badgeMarkdown("API [eu] status", "https://a.test/b.svg", "https://a.test")).toBe(
      "[![API eu status](https://a.test/b.svg)](https://a.test)",
    );
  });
});

describe("status hosts", () => {
  it("maps a subdomain of the base domain to its page, and nothing else", () => {
    const options = { baseDomain: "status.acme.io" };
    expect(statusRefForHost("shop.status.acme.io", options)).toBe("shop");
    expect(statusRefForHost("Shop.Status.Acme.io:443", options)).toBe("shop");
    expect(statusRefForHost("status.acme.io", options)).toBeUndefined();
    expect(statusRefForHost("a.b.status.acme.io", options)).toBeUndefined();
    expect(statusRefForHost("app.acme.io", options)).toBeUndefined();
    expect(statusRefForHost("evilstatus.acme.io", options)).toBeUndefined();
    expect(statusRefForHost("shop.status.acme.io", { baseDomain: undefined })).toBeUndefined();
    expect(statusRefForHost(null, options)).toBeUndefined();
  });

  it("treats a host that is none of ours as a customer's domain", () => {
    const options = { baseDomain: "status.acme.io", appDomain: "app.acme.io" };
    expect(statusRefForHost("status.customer.com", options)).toBe("status.customer.com");
    expect(statusRefForHost("Status.Customer.com:443", options)).toBe("status.customer.com");
    /* Ours: the app, the site, anything else under our domain, and the base domain itself. */
    for (const own of ["app.acme.io", "acme.io", "www.acme.io", "hb.acme.io", "status.acme.io"]) {
      expect(statusRefForHost(own, options), own).toBeUndefined();
    }
    /* Never pages: internal names and addresses. */
    for (const internal of ["web:3000", "localhost:3000", "127.0.0.1:3100", "[::1]:3000"]) {
      expect(statusRefForHost(internal, options), internal).toBeUndefined();
    }
    expect(
      statusRefForHost("partner.net", { ...options, ownHosts: ["partner.net"] }),
    ).toBeUndefined();
    /* Without the app's own host nothing is guessed. */
    expect(
      statusRefForHost("status.customer.com", { baseDomain: "status.acme.io" }),
    ).toBeUndefined();
  });

  it("ignores the placeholder domain and keeps the rest of the path", () => {
    expect(statusBaseDomain("status.example.com")).toBeUndefined();
    expect(statusBaseDomain("")).toBeUndefined();
    expect(statusBaseDomain(" Status.Acme.io ")).toBe("status.acme.io");
    expect(statusPathFor("shop", "/")).toBe("/s/shop");
    expect(statusPathFor("shop", "/history/")).toBe("/s/shop/history");
  });

  it("accepts page references and suggests an address from a name", () => {
    expect(isStatusRef("shop")).toBe(true);
    expect(isStatusRef("status.shop.example.net")).toBe(true);
    expect(isStatusRef("../etc")).toBe(false);
    expect(isStatusRef("a b")).toBe(false);
    expect(slugFromName("Acme, Inc.")).toBe("acme-inc");
    expect(slugFromName("  Zürich Café  ")).toBe("zurich-cafe");
    expect(slugFromName("x".repeat(80))).toHaveLength(63);
  });
});

describe("the public page", () => {
  it("keeps groups together in page order", () => {
    expect(
      groupComponents(page().components).map((s) => [s.group, s.items.map((c) => c.name)]),
    ).toEqual([
      ["Core", ["API", "Workers"]],
      [null, ["Website"]],
    ]);
  });

  it("says the status in words, lists incidents with updates, and announces maintenance", () => {
    show(page(), "/api/public/status/acme");
    expect(screen.getByRole("heading", { level: 1, name: "Acme status" })).toBeDefined();
    expect(
      within(screen.getByRole("region", { name: "Current status" })).getByText("Partial outage"),
    ).toBeDefined();
    const api = screen.getAllByRole("listitem").find((li) => li.textContent?.includes("API"));
    expect(api?.textContent).toContain("Major outage");
    expect(
      screen.getByRole("img", { name: "API: 99.97% uptime over the last 90 days" }),
    ).toBeDefined();
    expect(screen.getByText("No data yet")).toBeDefined();

    const incident = screen.getByRole("heading", { name: "API errors" }).closest("article");
    expect(incident?.textContent).toContain("Affects: API");
    expect(incident?.textContent).toContain("Identified · 7 Oct 2026, 10:10 UTC");
    expect(incident?.textContent).toContain("A bad deploy.");

    expect(screen.getByText("9 Oct 2026, 02:00 UTC to 9 Oct 2026, 03:00 UTC.")).toBeDefined();
    expect(screen.getByText("No incidents in the last 14 days.")).toBeDefined();
    expect(screen.getByRole("link", { name: "RSS" }).getAttribute("href")).toBe(
      "/api/public/status/acme/rss",
    );
    expect(screen.getByRole("link", { name: "Contact support" })).toBeDefined();
    expect(screen.getByRole("link", { name: "Powered by UptimeWatch" }).getAttribute("href")).toBe(
      "https://watchpost.example.net",
    );
  });

  it("offers the subscribe form only when the page takes subscribers, and says what happened", () => {
    const taking = page();
    taking.page.subscribe = true;
    const { unmount } = show(taking, undefined, {
      subscribeAction: "/api/public/status/acme/subscribers",
      notice: "sent",
    });
    const email = screen.getByLabelText("Email address") as HTMLInputElement;
    expect(email.form?.getAttribute("action")).toBe("/api/public/status/acme/subscribers");
    expect(email.form?.method).toBe("post");
    expect(email.name).toBe("email");
    expect(screen.getByRole("status").textContent).toContain("Check your inbox");
    unmount();

    show(page(), undefined, { subscribeAction: "/api/public/status/acme/subscribers" });
    expect(screen.queryByLabelText("Email address")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("a quiet page says so, and the preview has no feed links", () => {
    show(
      page({
        status: "operational",
        components: [],
        incidents: { active: [], recent: [] },
        maintenance: [],
      }),
    );
    expect(screen.getByText("All systems operational")).toBeDefined();
    expect(screen.getByText("No services are listed yet.")).toBeDefined();
    expect(screen.queryByRole("heading", { name: "Open incidents" })).toBeNull();
    expect(screen.queryByRole("link", { name: "RSS" })).toBeNull();
  });
});
