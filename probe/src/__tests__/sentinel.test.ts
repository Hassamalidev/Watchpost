/*
 * The sentinel (P2-T11): who is told, when, and how. Everything runs against a fake fetch and a
 * fake clock; no real Telegram or Twilio call is ever made.
 */
import { describe, expect, it } from "vitest";
import { SentinelConfigError, loadSentinelConfig } from "../sentinel/config.js";
import { renderStatusPage } from "../sentinel/page.js";
import { createSentinel } from "../sentinel/run.js";
import { SILENT_MISSES, decide, type Observation, type SentinelState } from "../sentinel/watch.js";

const env = {
  SENTINEL_TARGETS:
    "Platform=https://app.acme.io/api/ready, Status pages=https://demo.status.acme.io/, https://acme.io",
  SENTINEL_TELEGRAM_BOT_TOKEN: "123456:telegram-token",
  SENTINEL_TELEGRAM_CHAT_ID: "-100200300",
  SENTINEL_SMS_TO: "+14155550100, +923001234567",
  SENTINEL_SMS_FROM: "+14155550199",
  TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000000",
  TWILIO_AUTH_TOKEN: "twilio-token",
  SENTINEL_PORT: "0",
};

describe("sentinel config", () => {
  it("reads targets with names, and knows our readiness URL from the others", () => {
    const config = loadSentinelConfig(env);
    expect(config.targets).toEqual([
      { name: "Platform", url: "https://app.acme.io/api/ready", kind: "ready" },
      { name: "Status pages", url: "https://demo.status.acme.io/", kind: "http" },
      { name: "acme.io", url: "https://acme.io/", kind: "http" },
    ]);
    expect(config).toMatchObject({ intervalMs: 30_000, repeatMs: 900_000, dryRun: false });
    expect(config.sms?.to).toEqual(["+14155550100", "+923001234567"]);
  });

  it("refuses a setup in which nobody would be told", () => {
    expect(() => loadSentinelConfig({ SENTINEL_TARGETS: "https://acme.io" })).toThrow(
      /Nobody would be told/,
    );
    expect(
      loadSentinelConfig({ SENTINEL_TARGETS: "https://acme.io", SENTINEL_DRY_RUN: "true" }).dryRun,
    ).toBe(true);
  });

  it("names what is missing or wrong", () => {
    const bad = (patch: Record<string, string | undefined>) => {
      try {
        loadSentinelConfig({ ...env, ...patch });
      } catch (err) {
        return err instanceof SentinelConfigError ? err.message : String(err);
      }
      return "";
    };
    expect(bad({ SENTINEL_TELEGRAM_CHAT_ID: undefined })).toMatch(/Telegram needs both/);
    expect(bad({ TWILIO_AUTH_TOKEN: undefined })).toMatch(/SMS needs TWILIO_ACCOUNT_SID/);
    expect(bad({ SENTINEL_SMS_TO: "0300-1234567" })).toMatch(/is not a phone number/);
    expect(bad({ SENTINEL_TARGETS: "ftp://acme.io" })).toMatch(/must be an http\(s\) URL/);
    expect(bad({ SENTINEL_TARGETS: "https://acme.io, https://acme.io/x" })).toMatch(
      /two targets are named "acme.io"/,
    );
  });
});

const seen = (patch: Partial<Observation> = {}): Observation => ({
  target: "Platform",
  ok: true,
  answered: true,
  detail: "",
  warnings: [],
  ...patch,
});
const REPEAT = { repeatMs: 15 * 60_000 };

describe("who is told, and when", () => {
  it("pages at once when the target itself says it is down", () => {
    const { state, messages } = decide(
      {},
      [seen({ ok: false, detail: "Not ready: worker (the worker last ticked 75 s ago)." })],
      1_000,
      REPEAT,
    );
    expect(messages).toEqual([
      {
        level: "page",
        target: "Platform",
        text: "DOWN: Platform. Not ready: worker (the worker last ticked 75 s ago).",
      },
    ]);
    expect(state.Platform).toMatchObject({ down: true, pagedAt: 1_000, downSince: 1_000 });
  });

  it("waits for a second miss when nothing answers, which may be our own network", () => {
    const silent = seen({ ok: false, answered: false, detail: "It can't be reached." });
    const first = decide({}, [silent], 0, REPEAT);
    expect(first.messages).toEqual([]);
    expect(first.state.Platform).toMatchObject({ down: false, misses: 1 });
    const second = decide(first.state, [silent], 30_000, REPEAT);
    expect(SILENT_MISSES).toBe(2);
    expect(second.messages.map((m) => m.text)).toEqual(["DOWN: Platform. It can't be reached."]);
    /* One blip that answers again is forgotten without a word. */
    const blip = decide(first.state, [seen()], 30_000, REPEAT);
    expect(blip.messages).toEqual([]);
    expect(blip.state.Platform).toMatchObject({ misses: 0, down: false });
  });

  it("repeats the page while it stays down, and says once when it is back", () => {
    const down = seen({ ok: false, detail: "It answered HTTP 502." });
    let state: SentinelState = decide({}, [down], 0, REPEAT).state;
    for (let t = 30_000; t < 15 * 60_000; t += 30_000) {
      const next = decide(state, [down], t, REPEAT);
      expect(next.messages).toEqual([]);
      state = next.state;
    }
    const repeated = decide(state, [down], 15 * 60_000, REPEAT);
    expect(repeated.messages.map((m) => m.text)).toEqual([
      "STILL DOWN (15 min): Platform. It answered HTTP 502.",
    ]);
    const back = decide(repeated.state, [seen()], 21 * 60_000, REPEAT);
    expect(back.messages).toEqual([
      {
        level: "page",
        target: "Platform",
        text: "RECOVERED: Platform is working again after 21 min.",
      },
    ]);
    expect(decide(back.state, [seen()], 22 * 60_000, REPEAT).messages).toEqual([]);
  });

  it("sends warnings as a notice when they appear, change and clear", () => {
    const warned = seen({ warnings: ["probes: no healthy probe in ap-southeast"] });
    const first = decide({}, [warned], 0, REPEAT);
    expect(first.messages).toEqual([
      {
        level: "notice",
        target: "Platform",
        text: "Warning for Platform: probes: no healthy probe in ap-southeast.",
      },
    ]);
    expect(decide(first.state, [warned], 30_000, REPEAT).messages).toEqual([]);
    const cleared = decide(first.state, [seen()], 60_000, REPEAT);
    expect(cleared.messages.map((m) => m.text)).toEqual(["Platform: the warnings have cleared."]);
  });
});

/* A fake internet: our targets, Telegram and Twilio, with every request recorded. */
function world() {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const answers = new Map<string, () => Response>();
  let providersDown = false;
  const fetchFake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.includes("api.telegram.org") || url.includes("api.twilio.com")) {
      if (providersDown) throw new TypeError("fetch failed");
      return new Response("{}", { status: 200 });
    }
    const answer = answers.get(url);
    if (answer === undefined) throw new TypeError("fetch failed");
    return answer();
  }) as typeof fetch;
  const json = (status: number, body: unknown) => () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  return {
    requests,
    fetch: fetchFake,
    set: (url: string, answer: (() => Response) | undefined) =>
      answer === undefined ? answers.delete(url) : answers.set(url, answer),
    json,
    providers: (down: boolean) => {
      providersDown = down;
    },
    sent: (host: string) => requests.filter((r) => r.url.includes(host)),
  };
}

const READY = "https://app.acme.io/api/ready";
const PAGES = "https://demo.status.acme.io/";
const SITE = "https://acme.io/";

function sentinelIn(w: ReturnType<typeof world>, clock: { now: number }) {
  const logs: string[] = [];
  const sentinel = createSentinel({
    config: loadSentinelConfig(env),
    fetch: w.fetch,
    now: () => clock.now,
    log: (_level, _event, text) => logs.push(text),
  });
  w.set(READY, w.json(200, { status: "ready", checks: {}, warnings: {} }));
  w.set(PAGES, () => new Response("<html></html>", { status: 200 }));
  w.set(SITE, () => new Response("<html></html>", { status: 200 }));
  return { sentinel, logs };
}

describe("a stopped worker pages the founders within 2 minutes", () => {
  it("the API calls itself not ready after 60 s; the next round pages by Telegram and SMS", async () => {
    const w = world();
    const clock = { now: Date.parse("2026-10-07T12:00:00Z") };
    const { sentinel } = sentinelIn(w, clock);
    expect(await sentinel.round()).toEqual([]);
    expect(w.sent("api.telegram.org")).toHaveLength(0);

    /*
     * The worker stops at 12:00:00. Its last tick is at most 10 s old then, so /api/ready fails no
     * later than 60 s after the stop. Rounds are 30 s apart: the first one after that is at most
     * 90 s after the stop, and it pages at once because the API itself answered.
     */
    const workerDeadAfterMs = 60_000;
    const config = loadSentinelConfig(env);
    expect(workerDeadAfterMs + config.intervalMs).toBeLessThanOrEqual(120_000);

    clock.now += 60_000;
    expect(await sentinel.round()).toEqual([]);
    w.set(
      READY,
      w.json(503, {
        status: "not_ready",
        checks: {
          postgres: { ok: true },
          worker: { ok: false, error: "the worker last ticked 61 s ago" },
        },
        warnings: {},
      }),
    );
    clock.now += 30_000;
    const messages = await sentinel.round();
    expect(messages.map((m) => m.text)).toEqual([
      "DOWN: Platform. Not ready: worker (the worker last ticked 61 s ago).",
    ]);

    const [telegram] = w.sent("api.telegram.org");
    expect(telegram?.url).toBe("https://api.telegram.org/bot123456:telegram-token/sendMessage");
    expect(JSON.parse(String(telegram?.init?.body))).toEqual({
      chat_id: "-100200300",
      text: "Watchpost sentinel\nDOWN: Platform. Not ready: worker (the worker last ticked 61 s ago).",
    });
    const texts = w.sent("api.twilio.com");
    expect(texts).toHaveLength(2);
    expect(texts[0]?.url).toBe(
      "https://api.twilio.com/2010-04-01/Accounts/AC00000000000000000000000000000000/Messages.json",
    );
    const form = new URLSearchParams(String(texts[0]?.init?.body));
    expect(form.get("To")).toBe("+14155550100");
    expect(form.get("From")).toBe("+14155550199");
    expect(form.get("Body")).toContain("DOWN: Platform.");
    expect((texts[0]?.init?.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from("AC00000000000000000000000000000000:twilio-token").toString("base64")}`,
    );

    /* The page it serves says so too, without the internal reason. */
    const page = sentinel.page();
    expect(page).toContain("Partial outage");
    expect(page).toContain("Platform went down.");
    expect(page).not.toContain("worker last ticked");
    expect(page).not.toContain("app.acme.io");
  });

  it("a page that reached nobody is sent again on the next round", async () => {
    const w = world();
    const clock = { now: 0 };
    const { sentinel, logs } = sentinelIn(w, clock);
    w.set(READY, w.json(503, { status: "not_ready", checks: { redis: { ok: false } } }));
    w.providers(true);
    await sentinel.round();
    expect(logs).toContain("the page reached nobody; trying again next round");
    expect(sentinel.state().Platform?.pagedAt).toBeNull();
    w.providers(false);
    const before = w.sent("api.telegram.org").length;
    clock.now += 30_000;
    const again = await sentinel.round();
    expect(again.map((m) => m.text)).toEqual(["DOWN: Platform. Not ready: redis."]);
    expect(w.sent("api.telegram.org").length).toBe(before + 1);
  });

  it("warnings go to Telegram only; other targets are watched the same way", async () => {
    const w = world();
    const clock = { now: 0 };
    const { sentinel } = sentinelIn(w, clock);
    w.set(
      READY,
      w.json(200, {
        status: "ready",
        checks: {},
        warnings: { probes: "no healthy probe in us-east" },
      }),
    );
    await sentinel.round();
    expect(w.sent("api.telegram.org")).toHaveLength(1);
    expect(w.sent("api.twilio.com")).toHaveLength(0);

    /* The status page host stops answering: paged on the second miss. */
    w.set(PAGES, undefined);
    clock.now += 30_000;
    expect(await sentinel.round()).toEqual([]);
    clock.now += 30_000;
    expect((await sentinel.round()).map((m) => m.text)).toEqual([
      "DOWN: Status pages. It can't be reached.",
    ]);
    expect(w.sent("api.twilio.com")).toHaveLength(2);
  });

  it("serves the page and a health check over HTTP", async () => {
    const w = world();
    const { sentinel } = sentinelIn(w, { now: Date.now() });
    const port = await sentinel.start();
    try {
      const page = await fetch(`http://127.0.0.1:${port}/`);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(await page.text()).toContain("<h1>Watchpost status</h1>");
      expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${port}/nope`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${port}/`, { method: "POST" })).status).toBe(405);
    } finally {
      await sentinel.stop();
    }
  });
});

describe("our own status page", () => {
  it("escapes names and shows what is down since when", () => {
    const html = renderStatusPage({
      title: "Acme <status>",
      targets: ["Platform", "<b>Site</b>"],
      state: {
        Platform: {
          down: true,
          misses: 3,
          downSince: Date.parse("2026-10-07T12:01:30Z"),
          pagedAt: 1,
          detail: "Not ready: postgres (password authentication failed)",
          warnings: [],
        },
        "<b>Site</b>": {
          down: false,
          misses: 0,
          downSince: null,
          pagedAt: null,
          detail: "",
          warnings: [],
        },
      },
      events: [{ at: Date.parse("2026-10-07T12:01:30Z"), text: "Platform went down." }],
      checkedAt: Date.parse("2026-10-07T12:02:00Z"),
    });
    expect(html).toContain("<title>Acme &lt;status&gt;</title>");
    expect(html).toContain("&lt;b&gt;Site&lt;/b&gt;");
    expect(html).not.toContain("<b>Site</b>");
    expect(html).toContain("Down since 2026-10-07 12:01 UTC");
    expect(html).toContain("Partial outage");
    expect(html).not.toContain("password authentication failed");
    expect(html).not.toContain("<script");
  });
});
