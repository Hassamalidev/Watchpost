/*
 * Public header: account links follow the visitor's session, and the menu for narrow screens opens,
 * closes on Escape and closes after a link is used.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderWithProviders } from "@/test/render";
import { HeaderAccount, MobileMenu } from "@/features/marketing/components/site-nav";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

const LINKS = [
  { href: "/pricing", label: "Pricing" },
  { href: "/#features", label: "Features" },
];

function renderNav(session: unknown, fail = false) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      if (fail) throw new TypeError("network down");
      return new Response(JSON.stringify(session), { status: 200 });
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithProviders(
    <QueryClientProvider client={client}>
      <HeaderAccount />
      <MobileMenu links={LINKS} />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("public header", () => {
  it("offers sign in and sign up to a signed-out visitor", async () => {
    renderNav(null);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.getByRole("link", { name: "Sign up" })).toHaveAttribute("href", "/signup");
    expect(screen.queryByRole("link", { name: "Open the app" })).toBeNull();
  });

  it("offers the app to a signed-in visitor, in the bar and not sign in in the menu", async () => {
    renderNav({ user: { id: "u1", email: "a@b.co", name: "A", emailVerified: true }, session: {} });
    expect(await screen.findByRole("link", { name: "Open the app" })).toHaveAttribute("href", "/w");
    expect(screen.queryByRole("link", { name: "Sign up" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();
  });

  it("stays signed out when the API can't be reached", async () => {
    renderNav(null, true);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.getByRole("link", { name: "Sign up" })).toBeInTheDocument();
  });

  it("opens the menu, closes it on Escape and after a link is used", async () => {
    renderNav(null);
    const toggle = screen.getByRole("button", { name: "Open menu" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: "Pricing" })).toBeNull();

    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Close menu" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("link", { name: "Pricing" })).toHaveAttribute("href", "/pricing");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("link", { name: "Pricing" })).toBeNull();
    expect(toggle).toHaveFocus();

    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("link", { name: "Features" }));
    expect(screen.queryByRole("link", { name: "Features" })).toBeNull();
  });
});
