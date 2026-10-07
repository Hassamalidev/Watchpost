/*
 * P2-T07 in a browser, against the real API, worker and probe: a status page is created from a
 * monitor and is public at once; when the monitor goes down the public page says so within 10
 * seconds; an incident posted from the editor shows up with its updates; the page meets its
 * loading budget (LCP under 1.5 s) and has no accessibility violations.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { emailField, emailLink, uniqueEmail } from "./helpers";

const TARGET = "http://127.0.0.1:4110";
const LCP_BUDGET_MS = 1_500;
const SCRIPT_GUARD_BYTES = 150 * 1024;

const workspace = () =>
  (JSON.parse(readFileSync("e2e/.auth/workspace.json", "utf8")) as { workspaceId: string })
    .workspaceId;

async function createMonitor(page: Page, name: string, path: string): Promise<string> {
  await page.goto(`/w/${workspace()}/monitors/new`);
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("URL").fill(`${TARGET}${path}`);
  await page.getByRole("checkbox", { name: "us-east" }).uncheck();
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  return page.url().split("/").at(-1) ?? "";
}

async function monitorStatus(page: Page, monitorId: string): Promise<string> {
  const res = await page.request.get(`/api/w/${workspace()}/monitor-states`);
  const body = (await res.json()) as { data: Array<{ monitorId: string; status: string }> };
  return body.data.find((s) => s.monitorId === monitorId)?.status ?? "pending";
}

/* A request to the web server as if it had arrived for another host name. */
function getWithHost(path: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: 3100, path, headers: { host } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
  });
}

/* Largest Contentful Paint of the page that is open, in milliseconds. */
const lcpOf = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        new PerformanceObserver((list) => {
          const entries = list.getEntries();
          resolve(entries.at(-1)?.startTime ?? 0);
        }).observe({ type: "largest-contentful-paint", buffered: true });
        setTimeout(() => resolve(-1), 5_000);
      }),
  );

test("a status page is public at once, follows its monitor within 10 s, and shows incidents", async ({
  page,
  browser,
}, testInfo) => {
  test.skip(testInfo.project.name !== "light", "one run is enough");
  test.setTimeout(300_000);
  const ws = workspace();
  const slug = `shop-${randomBytes(3).toString("hex")}`;

  /* A monitor that is fine and one whose target always fails, each checked from one region. */
  await createMonitor(page, "Storefront", "/ok");
  const failing = await createMonitor(page, "Payments", "/fail");

  /* The page: both monitors are ticked by default. */
  await page.goto(`/w/${ws}/status-pages`);
  await expect(page.getByRole("heading", { level: 1, name: "Status pages" })).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill("Corner Shop");
  await expect(page.getByLabel("Address")).toHaveValue("corner-shop");
  await page.getByLabel("Address").fill(slug);
  await page.getByRole("button", { name: "Create status page" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Corner Shop", exact: true }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("status-preview")).toContainText("Corner Shop status");
  const editorUrl = page.url();

  /* A visitor who is not signed in. */
  const visitorContext = await browser.newContext();
  const visitor = await visitorContext.newPage();
  try {
    await visitor.goto(`/s/${slug}`);
    await expect(
      visitor.getByRole("heading", { level: 1, name: "Corner Shop status" }),
    ).toBeVisible();
    await expect(visitor.getByText("Payments")).toBeVisible();

    /* Loading budget on a first visit with an empty browser cache (§14). */
    const lcp = await lcpOf(visitor);
    const scriptBytes = await visitor.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .filter((r) => (r as PerformanceResourceTiming).initiatorType === "script")
        .reduce((sum, r) => sum + (r as PerformanceResourceTiming).transferSize, 0),
    );
    testInfo.annotations.push(
      { type: "LCP", description: `${Math.round(lcp)} ms` },
      { type: "script transfer", description: `${Math.round(scriptBytes / 1024)} KB` },
    );
    expect(lcp).toBeGreaterThan(0);
    expect(lcp).toBeLessThan(LCP_BUDGET_MS);
    /*
     * The framework's own runtime is about 130 KB compressed, above the 100 KB the spec aims for
     * (D-088). This guards against the page growing beyond that: it ships no code of its own.
     */
    expect(scriptBytes).toBeGreaterThan(0);
    expect(scriptBytes).toBeLessThan(SCRIPT_GUARD_BYTES);

    /* The outage: once the API calls the monitor down, the public page must say so within 10 s. */
    await page.goto(`/w/${ws}/monitors/${failing}`);
    await page.getByRole("button", { name: "Test now" }).click();
    await expect
      .poll(() => monitorStatus(page, failing), { timeout: 120_000, intervals: [500] })
      .toBe("down");
    const downAt = Date.now();
    await expect(async () => {
      await visitor.reload();
      await expect(
        visitor.getByRole("listitem").filter({ hasText: "Payments" }).getByText("Major outage"),
      ).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 10_000, intervals: [500] });
    const seenAfterMs = Date.now() - downAt;
    testInfo.annotations.push({
      type: "status change visible after",
      description: `${seenAfterMs} ms`,
    });
    expect(seenAfterMs).toBeLessThan(10_000);
    /* Partial while the other service is up; major if it has no result yet. */
    await expect(visitor.getByRole("region", { name: "Current status" })).toContainText(
      /(Partial|Major) outage/,
    );

    /* The visitor subscribes with the page's own form and confirms from the email. */
    const subscriber = uniqueEmail("visitor");
    await visitor.getByLabel("Email address").fill(subscriber);
    await visitor.getByRole("button", { name: "Subscribe" }).click();
    await expect(visitor.getByText("Check your inbox: we sent a link")).toBeVisible();
    expect(new URL(visitor.url()).pathname).toBe(`/s/${slug}`);
    const confirmUrl = new URL(await emailLink(subscriber, "status-confirm"));
    const confirmed = await visitor.request.get(`${confirmUrl.pathname}${confirmUrl.search}`, {
      maxRedirects: 0,
    });
    expect(confirmed.status()).toBe(303);
    expect(confirmed.headers().location).toContain("?subscribe=confirmed");
    await visitor.goto(`/s/${slug}?subscribe=confirmed`);
    await expect(visitor.getByText("You are subscribed.")).toBeVisible();

    /* An incident posted from the editor reaches the public page with its update. */
    await page.goto(editorUrl);
    await expect(page.getByText(subscriber)).toBeVisible();
    await expect(page.getByText("1 of 2000 subscribers.")).toBeVisible();
    await page.getByLabel("Title").fill("Card payments are failing");
    await page.getByLabel("First update").fill("We are investigating failed card payments.");
    await page.getByRole("checkbox", { name: "Payments" }).check();
    await page.getByRole("button", { name: "Publish incident" }).click();
    await expect(page.getByTestId("status-preview")).toContainText("Card payments are failing", {
      timeout: 20_000,
    });
    await expect(async () => {
      await visitor.reload();
      await expect(visitor.getByRole("heading", { name: "Card payments are failing" })).toBeVisible(
        {
          timeout: 1_000,
        },
      );
    }).toPass({ timeout: 10_000, intervals: [500] });
    await expect(visitor.getByText("We are investigating failed card payments.")).toBeVisible();

    await page.getByLabel("Update", { exact: true }).fill("A fix is live; payments work again.");
    await page.getByLabel("New status").selectOption("resolved");
    await page.getByRole("button", { name: "Post update" }).click();
    await expect(async () => {
      await visitor.reload();
      await expect(visitor.getByText("A fix is live; payments work again.")).toBeVisible({
        timeout: 1_000,
      });
    }).toPass({ timeout: 10_000, intervals: [500] });
    await expect(visitor.getByRole("heading", { name: "Past incidents" })).toBeVisible();

    /* The subscriber was emailed, and leaves with the link in the email. */
    const unsubscribeUrl = new URL(await emailField(subscriber, "status-update", "unsubscribeUrl"));
    const left = await visitor.request.post(`${unsubscribeUrl.pathname}${unsubscribeUrl.search}`, {
      form: { "List-Unsubscribe": "One-Click" },
    });
    expect(left.status()).toBe(200);
    await page.reload();
    await expect(page.getByText("0 of 2000 subscribers.")).toBeVisible();

    const results = await new AxeBuilder({ page: visitor })
      .withTags(["wcag2a", "wcag2aa"])
      .analyze();
    expect(results.violations).toEqual([]);

    /* The feeds and the JSON are linked from the page and answer. */
    const rss = await visitor.request.get(`/api/public/status/${slug}/rss`);
    expect(rss.ok()).toBe(true);
    expect(await rss.text()).toContain("Card payments are failing");
    const json = await visitor.request.get(`/api/public/status/${slug}`);
    expect(((await json.json()) as { page: { slug: string } }).page.slug).toBe(slug);
  } finally {
    await visitorContext.close();
  }

  /* By host name: the page's subdomain serves it; a domain nobody verified serves nothing. */
  const bySubdomain = await getWithHost("/", `${slug}.status.watchpost-e2e.test`);
  expect(bySubdomain.status).toBe(200);
  expect(bySubdomain.body).toContain("Corner Shop status");
  expect((await getWithHost("/", "status.someone-else.test")).status).toBe(404);
  expect((await getWithHost("/pricing", `${slug}.status.watchpost-e2e.test`)).status).toBe(404);

  /* The custom domain card says what to point a domain at. */
  await page.goto(editorUrl);
  await page.getByLabel("Domain", { exact: true }).fill("status.corner-shop.test");
  await page
    .locator("form", { has: page.getByLabel("Domain", { exact: true }) })
    .getByRole("button", { name: "Save" })
    .click();
  await expect(page.getByText("Almost there: point the domain at us")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByLabel("Points to")).toHaveValue("pages.watchpost-e2e.test");
  await page.getByRole("button", { name: "Check now" }).click();
  /* What DNS says, or that it couldn't be asked from this machine; never "verified". */
  await expect(
    page.getByText(/No DNS record found for status\.corner-shop\.test|DNS couldn't be checked/),
  ).toBeVisible({ timeout: 20_000 });
  expect((await getWithHost("/", "status.corner-shop.test")).status).toBe(404);

  /* A badge for the failing monitor: the image says "down", and there is Markdown to paste. */
  await page.goto(`/w/${ws}/monitors/${failing}`);
  const markdown = page.getByLabel("Markdown");
  await expect(markdown).toHaveValue(/^\[!\[Payments status\]\(http.*\/status\.svg\)\]\(http/, {
    timeout: 20_000,
  });
  const imageUrl = await page.getByLabel("Image URL").inputValue();
  /* With its own label, so the answer isn't the image cached when the monitor was new. */
  const image = await page.request.get(`${new URL(imageUrl).pathname}?label=Payments`);
  expect(image.status()).toBe(200);
  expect(image.headers()["content-type"]).toContain("image/svg+xml");
  expect(await image.text()).toContain('aria-label="Payments: down"');
  await page.getByLabel("Badge", { exact: true }).selectOption("uptime");
  await expect(markdown).toHaveValue(/uptime\.svg/);

  /* The editor itself is accessible, and an unknown page is a 404. */
  await page.goto(editorUrl);
  await expect(page.getByTestId("status-preview")).toBeVisible();
  const editor = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(editor.violations).toEqual([]);
  const missing = await page.request.get("/s/no-such-page-here");
  expect(missing.status()).toBe(404);
});
