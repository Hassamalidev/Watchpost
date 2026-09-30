/*
 * P1-T18 AC, "templates render in light and dark mail clients": every template renders HTML and a
 * text version; HTML declares both color schemes, carries the dark overrides for clients that support
 * `prefers-color-scheme` and Outlook.com's `[data-ogsc]`, has no scripts, and both palettes keep text
 * at WCAG AA contrast. The Resend transport sends once per idempotency key and classifies failures.
 */
import { describe, expect, it, vi } from "vitest";
import {
  EMAIL_TEMPLATES,
  PALETTE,
  PermanentEmailError,
  createResendTransport,
  renderEmail,
  type EmailTemplate,
} from "../index.js";

const incident = {
  number: 482,
  title: "Checkout API is down",
  severity: "critical",
  causeCode: "http_status_unexpected",
  failingRegions: ["eu-central", "us-east"],
  monitorName: "Checkout API",
  startedAt: "2026-10-01T12:00:00.000Z",
  durationSeconds: 420,
  url: "https://app.example.com/w/1/incidents/482",
};

const SAMPLES: Record<EmailTemplate, Record<string, unknown>> = {
  "verify-email": { url: "https://app.example.com/verify?t=1", name: "Sara" },
  "magic-link": { url: "https://app.example.com/magic?t=1" },
  "reset-password": { url: "https://app.example.com/reset?t=1" },
  invite: {
    url: "https://app.example.com/invite/1",
    workspaceName: "Acme",
    inviterName: "Sara",
    role: "member",
  },
  alert: {
    kind: "triggered",
    subject: "[Critical] #482 Checkout API is down",
    workspaceName: "Acme",
    incident,
    actions: {
      acknowledge: "https://app.example.com/a/ack-token",
      resolve: "https://app.example.com/a/resolve-token",
    },
  },
  "channel-failing": {
    workspaceName: "Acme",
    channelName: "Ops hook",
    channelType: "webhook",
    error: "HTTP 410",
    url: "https://app.example.com/w/1/integrations",
  },
  digest: {
    workspaceName: "Acme",
    weekStart: "2026-09-21",
    weekEnd: "2026-09-27",
    incidents: 3,
    resolved: 3,
    mttrMinutes: 12.5,
    monitors: [{ name: "Checkout API", uptimePercent: 99.8, downtimeMinutes: 20 }],
    totalMonitors: 12,
    url: "https://app.example.com/w/1/overview",
    settingsUrl: "https://app.example.com/w/1/settings",
  },
};

/* WCAG relative luminance and contrast for #rrggbb colors. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

describe("email templates", () => {
  for (const template of Object.keys(EMAIL_TEMPLATES) as EmailTemplate[]) {
    it(`${template} renders HTML for light and dark clients, and text`, async () => {
      const email = await renderEmail(template, SAMPLES[template]);
      expect(email.subject.length).toBeGreaterThan(5);
      expect(email.html).toContain('<meta name="color-scheme" content="light dark"');
      expect(email.html).toContain('<meta name="supported-color-schemes" content="light dark"');
      expect(email.html).toContain("@media (prefers-color-scheme: dark)");
      expect(email.html).toContain("[data-ogsc] .wp-text");
      expect(email.html).not.toMatch(/<script/i);
      expect(email.text.length).toBeGreaterThan(20);
      expect(email.text).not.toMatch(/<[a-z]/i);
    });
  }

  it("puts the signed action links in alert emails", async () => {
    const email = await renderEmail("alert", SAMPLES.alert);
    expect(email.html).toContain('href="https://app.example.com/a/ack-token"');
    expect(email.html).toContain('href="https://app.example.com/a/resolve-token"');
    expect(email.text).toContain("Checkout API");
    expect(email.text).toContain("eu-central, us-east");
    const resolved = await renderEmail("alert", {
      ...SAMPLES.alert,
      kind: "resolved",
      actions: {},
    });
    expect(resolved.html).not.toContain("/a/");
    expect(resolved.text).toContain("7 min");
  });

  it("keeps text readable in both palettes (WCAG AA)", () => {
    for (const p of [PALETTE.light, PALETTE.dark]) {
      expect(contrast(p.text, p.card)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.muted, p.card)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.brandText, p.brand)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.down, p.card)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.up, p.card)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.warn, p.card)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("Resend transport", () => {
  const message = {
    to: "sara@example.com",
    subject: "Hi",
    text: "Hello",
    html: "<p>Hello</p>",
    idempotencyKey: "evt-1",
  };

  it("sends with the API key and idempotency key", async () => {
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ id: "re_123" }), { status: 200 }),
    );
    const transport = createResendTransport({ apiKey: "re_key", fetch });
    await expect(transport.send(message, "Watchpost <a@x.com>")).resolves.toEqual({
      providerRef: "resend:re_123",
    });
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer re_key");
    expect(headers["idempotency-key"]).toBe("evt-1");
    expect(JSON.parse(String(init.body))).toMatchObject({
      from: "Watchpost <a@x.com>",
      to: ["sara@example.com"],
      html: "<p>Hello</p>",
    });
  });

  it("treats rejected messages as permanent and outages as retryable", async () => {
    const reply = (status: number) =>
      createResendTransport({
        apiKey: "k",
        fetch: vi.fn(async () => new Response(JSON.stringify({ message: "nope" }), { status })),
      });
    await expect(reply(422).send(message, "a@x.com")).rejects.toBeInstanceOf(PermanentEmailError);
    const outage = await reply(503)
      .send(message, "a@x.com")
      .catch((e: unknown) => e);
    expect(outage).toBeInstanceOf(Error);
    expect(outage).not.toBeInstanceOf(PermanentEmailError);
    const limited = await reply(429)
      .send(message, "a@x.com")
      .catch((e: unknown) => e);
    expect(limited).not.toBeInstanceOf(PermanentEmailError);
  });
});
