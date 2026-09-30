import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import { NAV_ITEMS, activeSegment, workspaceHref } from "@/lib/navigation";

const push = vi.fn();
let pathname = "/w/acme/monitors";

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push }),
}));

const { SidebarNav } = await import("@/components/app/sidebar-nav");
const { CommandPalette, isCommandShortcut } = await import("@/components/app/command-palette");

beforeEach(() => {
  push.mockReset();
  pathname = "/w/acme/monitors";
});

describe("navigation helpers", () => {
  it("builds workspace links and finds the active section", () => {
    expect(workspaceHref("acme co", "monitors")).toBe("/w/acme%20co/monitors");
    expect(activeSegment("/w/acme/monitors/123")).toBe("monitors");
    expect(activeSegment("/pricing")).toBeUndefined();
  });

  it("recognizes ⌘K and Ctrl+K only", () => {
    expect(isCommandShortcut({ key: "k", metaKey: true, ctrlKey: false })).toBe(true);
    expect(isCommandShortcut({ key: "K", metaKey: false, ctrlKey: true })).toBe(true);
    expect(isCommandShortcut({ key: "k", metaKey: false, ctrlKey: false })).toBe(false);
  });
});

describe("SidebarNav", () => {
  it("renders every section inside a labelled nav and marks the current page", () => {
    renderWithProviders(<SidebarNav workspace="acme" />);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(nav.querySelectorAll("a")).toHaveLength(NAV_ITEMS.length);
    expect(screen.getByRole("link", { name: "Monitors" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Overview" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "Incidents" })).toHaveAttribute(
      "href",
      "/w/acme/incidents",
    );
  });
});

describe("CommandPalette", () => {
  it("opens with Ctrl+K, filters, and navigates on select", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CommandPalette workspace="acme" />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.keyboard("{Control>}k{/Control}");
    expect(await screen.findByRole("dialog", { name: "Command palette" })).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("Type a command or search…"), "incid");
    await user.keyboard("{Enter}");
    expect(push).toHaveBeenCalledWith("/w/acme/incidents");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens from the header button", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CommandPalette workspace="acme" />);
    await user.click(screen.getByRole("button", { name: /Search or jump to/ }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });
});
