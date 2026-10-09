/* Private status pages: the lock a visitor sees, how the page is asked for, and the editor card. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PublicStatusLocked, StatusPageView } from "@app/shared";
import { renderWithProviders } from "@/test/render";
import { AccessCard, parseAllowedIps } from "@/features/statuspages/components/access-card";
import { StatusPageLocked } from "@/features/statuspages/components/status-page-locked";
import {
  isLocked,
  loadStatusPage,
  loadStatusPageAs,
  visitorIp,
} from "@/features/statuspages/public";

afterEach(() => vi.unstubAllGlobals());

const locked = (kind: PublicStatusLocked["locked"]): PublicStatusLocked => ({
  locked: kind,
  page: {
    name: "Acme",
    slug: "acme",
    url: "https://acme.status.example.net",
    branding: {
      logoUrl: null,
      faviconUrl: null,
      accentColor: null,
      description: null,
      supportUrl: null,
    },
    languages: ["en"],
  },
});

describe("the lock on a private page", () => {
  it("asks for the password with a plain form that posts to the API", () => {
    const { container } = renderWithProviders(
      <StatusPageLocked
        locked={locked("password")}
        unlockAction="/api/public/status/acme/unlock"
      />,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Acme" })).toBeInTheDocument();
    expect(
      screen.getByText("This status page is private. Enter its password to see it."),
    ).toBeInTheDocument();
    const form = container.querySelector("form");
    expect(form).toHaveAttribute("method", "post");
    expect(form).toHaveAttribute("action", "/api/public/status/acme/unlock");
    const field = screen.getByLabelText("Password");
    expect(field).toHaveAttribute("type", "password");
    expect(field).toHaveAttribute("name", "password");
    expect(screen.getByRole("button", { name: "Open the page" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("says when the password was wrong", () => {
    renderWithProviders(
      <StatusPageLocked locked={locked("password")} unlockAction="/unlock" wrong />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("That password is not right. Try again.");
    expect(screen.getByLabelText("Password")).toHaveAttribute("aria-invalid", "true");
  });

  it("has no form when the page is limited to networks", () => {
    renderWithProviders(<StatusPageLocked locked={locked("ip_allowlist")} unlockAction="/x" />);
    expect(
      screen.getByText(
        "This status page is private. It can be opened only from its owner's network.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
  });
});

describe("asking the API for a page", () => {
  it("reads 401 as a locked page, and asks again for the visitor without caching", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify(locked("password")), { status: 401 });
      }),
    );
    const first = await loadStatusPage("acme");
    expect(first !== null && isLocked(first)).toBe(true);
    /* The shared, cached read names nobody. */
    expect(calls[0]?.init?.headers).toBeUndefined();

    await loadStatusPageAs("acme", { ip: "203.0.113.9", cookie: "wp_sp_x=1.abc" });
    expect(calls[1]?.url).toContain("/api/public/status/acme");
    expect(calls[1]?.init?.cache).toBe("no-store");
    expect(calls[1]?.init?.headers).toEqual({
      "x-status-web-secret": "watchpost-dev-revalidate",
      "x-status-visitor-ip": "203.0.113.9",
      cookie: "wp_sp_x=1.abc",
    });
    expect(await loadStatusPageAs("Not A Ref", {})).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("takes the visitor's address from the proxy in front", () => {
    const from = (sent: Record<string, string>) => visitorIp((name) => sent[name] ?? null);
    expect(from({ "x-forwarded-for": "203.0.113.9, 10.0.0.2" })).toBe("203.0.113.9");
    expect(from({ "x-real-ip": "198.51.100.4" })).toBe("198.51.100.4");
    expect(from({})).toBeUndefined();
  });
});

describe("AccessCard", () => {
  const page = (patch: Partial<StatusPageView> = {}) =>
    ({
      id: "p1",
      visibility: "public",
      hasPassword: false,
      allowedIps: [],
      ...patch,
    }) as StatusPageView;

  function show(view: StatusPageView) {
    const sent: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          visibility: string;
          allowedIps?: string[];
        };
        sent.push(body);
        return new Response(
          JSON.stringify({
            ...view,
            visibility: body.visibility,
            allowedIps: body.allowedIps ?? view.allowedIps,
            hasPassword: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    renderWithProviders(
      <QueryClientProvider client={new QueryClient()}>
        <AccessCard ws="ws1" page={view} />
      </QueryClientProvider>,
    );
    return sent;
  }

  it("sets a password, and shows the field only for that choice", async () => {
    const sent = show(page());
    const user = userEvent.setup();
    expect(screen.queryByLabelText("Page password")).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Open to"), "password");
    await user.type(screen.getByLabelText("Page password"), "open sesame 1");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved. Visitors need the password.")).toBeInTheDocument();
    expect(sent).toEqual([{ visibility: "password", password: "open sesame 1" }]);
    expect(screen.getByLabelText("Page password")).toHaveValue("");
  });

  it("keeps the current password when the field is left empty", async () => {
    const sent = show(page({ visibility: "password", hasPassword: true }));
    const user = userEvent.setup();
    expect(screen.getByLabelText("Page password")).not.toBeRequired();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved. Visitors need the password.");
    expect(sent).toEqual([{ visibility: "password" }]);
  });

  it("sends the listed networks, one per line", async () => {
    const sent = show(page({ visibility: "ip_allowlist", allowedIps: ["203.0.113.0/24"] }));
    const user = userEvent.setup();
    const field = screen.getByLabelText("Allowed addresses and networks");
    expect(field).toHaveValue("203.0.113.0/24");
    await user.type(field, "\n2001:db8::/32");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved. Only the listed networks can open this page.");
    expect(sent).toEqual([
      { visibility: "ip_allowlist", allowedIps: ["203.0.113.0/24", "2001:db8::/32"] },
    ]);
    expect(parseAllowedIps(" 203.0.113.7 ,\n\n198.51.100.0/24 ")).toEqual([
      "203.0.113.7",
      "198.51.100.0/24",
    ]);
  });
});
