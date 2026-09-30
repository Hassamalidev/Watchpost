import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { MONITOR_STATUSES } from "@app/shared";
import { StatusBadge } from "@/components/app/status-badge";
import { renderWithProviders } from "@/test/render";

describe("StatusBadge", () => {
  it.each(MONITOR_STATUSES)("shows text and an icon for %s, never color alone", (status) => {
    renderWithProviders(<StatusBadge status={status} />);
    const badge = document.querySelector(`[data-status="${status}"]`);
    expect(badge).not.toBeNull();
    expect(badge?.textContent?.trim().length).toBeGreaterThan(0);
    expect(badge?.querySelector("svg[aria-hidden]")).not.toBeNull();
  });

  it("uses the translated label", () => {
    renderWithProviders(<StatusBadge status="down" />);
    expect(screen.getByText("Down")).toBeInTheDocument();
  });
});
