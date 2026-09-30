/* Onboarding suggestions, accessible fields and charts. */
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { createMonitorSchema } from "@app/shared";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { renderWithProviders } from "@/test/render";
import { suggestMonitors } from "@/features/onboarding/components/onboarding-wizard";
import { UptimeBars } from "@/features/monitors/components/charts";

const label = (key: string, values: Record<string, string>) =>
  `${key}:${Object.values(values).join(",")}`;

describe("onboarding suggestions", () => {
  it("suggests homepage, health, certificate and domain monitors that the API accepts", () => {
    const list = suggestMonitors("https://shop.example.com/pricing", label);
    expect(list?.map((s) => [s.key, s.checked])).toEqual([
      ["home", true],
      ["health", false],
      ["ssl", true],
      ["domain", true],
    ]);
    for (const s of list ?? []) expect(createMonitorSchema.safeParse(s.body).success).toBe(true);
    expect(list?.[3]?.body.config).toEqual({ type: "domain", domain: "example.com" });
  });

  it("skips the certificate for plain http and rejects non-URLs", () => {
    expect(suggestMonitors("http://example.org", label)?.map((s) => s.key)).toEqual([
      "home",
      "health",
      "domain",
    ]);
    expect(suggestMonitors("not a url", label)).toBeUndefined();
    expect(suggestMonitors("ftp://example.org", label)).toBeUndefined();
  });
});

describe("Field", () => {
  it("labels the control and links hint and error to it", () => {
    renderWithProviders(
      <Field label="Email" htmlFor="f-email" hint="Work address" error="Invalid">
        <Input id="f-email" />
      </Field>,
    );
    const input = screen.getByLabelText("Email");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("aria-describedby", "f-email-hint f-email-error");
    expect(screen.getByRole("alert")).toHaveTextContent("Invalid");
  });
});

describe("UptimeBars", () => {
  it("describes every day in text, not only color", () => {
    renderWithProviders(
      <UptimeBars
        days={[
          { date: "2026-09-30", uptimePercent: 100, downtimeSeconds: 0, status: "up" },
          { date: "2026-10-01", uptimePercent: 98.5, downtimeSeconds: 1_296, status: "major" },
          { date: "2026-10-02", uptimePercent: null, downtimeSeconds: 0, status: "none" },
        ]}
      />,
    );
    expect(screen.getByText("2026-10-01: 98.500%")).toBeInTheDocument();
    expect(screen.getByText("2026-10-02: no data")).toBeInTheDocument();
  });
});
