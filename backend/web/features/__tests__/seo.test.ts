/*
 * What search engines are told: the sitemap lists the public pages under the site's address, robots
 * keeps crawlers out of the app, and the landing page's structured data matches the page.
 */
import { describe, expect, it } from "vitest";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { COMPETITORS } from "@/features/marketing/competitors";
import { DOCS_PAGES } from "@/features/marketing/content/docs";
import { absoluteUrl, landingJsonLd, serializeJsonLd, siteUrl } from "@/lib/site";

describe("site address", () => {
  it("uses the configured origin without a trailing slash, or the local one", () => {
    expect(siteUrl("https://uptimewatch.test/")).toBe("https://uptimewatch.test");
    expect(siteUrl("")).toBe("http://localhost:3000");
    expect(absoluteUrl("/", "https://uptimewatch.test")).toBe("https://uptimewatch.test");
    expect(absoluteUrl("/pricing", "https://uptimewatch.test")).toBe(
      "https://uptimewatch.test/pricing",
    );
  });
});

describe("sitemap and robots", () => {
  it("lists the landing page, pricing, every comparison and every guide, and no legal draft", () => {
    const urls = sitemap().map((entry) => entry.url);
    expect(urls[0]).toBe(siteUrl());
    expect(urls).toContain(absoluteUrl("/pricing"));
    for (const competitor of COMPETITORS) {
      expect(urls).toContain(absoluteUrl(`/compare/${competitor.slug}`));
    }
    for (const page of DOCS_PAGES) expect(urls).toContain(absoluteUrl(`/docs/${page.slug}`));
    expect(urls.some((url) => url.includes("/legal/") || url.includes("/w/"))).toBe(false);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("keeps crawlers out of the app and the API and points to the sitemap", () => {
    const file = robots();
    expect(file.sitemap).toBe(absoluteUrl("/sitemap.xml"));
    expect(file.rules).toMatchObject({ userAgent: "*", allow: "/" });
    expect(file.rules).toHaveProperty("disallow", expect.arrayContaining(["/api/", "/w/"]));
  });
});

describe("landing page structured data", () => {
  const data = landingJsonLd({
    origin: "https://uptimewatch.test",
    faq: [{ question: "Is it free?", answer: "Yes </script><b>" }],
    offers: [
      { name: "Free", price: 0 },
      { name: "Pro", price: 29 },
    ],
    features: ["Website monitoring"],
  });
  const byType = (type: string) => data["@graph"].find((node) => node["@type"] === type);

  it("describes the product with its plans and no ratings", () => {
    expect(byType("SoftwareApplication")).toMatchObject({
      name: "UptimeWatch",
      url: "https://uptimewatch.test",
      offers: { lowPrice: 0, highPrice: 29, offerCount: 2, priceCurrency: "USD" },
    });
    expect(JSON.stringify(data)).not.toMatch(/aggregateRating|review/i);
  });

  it("carries the questions and cannot close its script tag", () => {
    expect(byType("FAQPage")).toMatchObject({
      mainEntity: [{ "@type": "Question", name: "Is it free?" }],
    });
    const text = serializeJsonLd(data);
    expect(text).not.toContain("<");
    expect(JSON.parse(text)).toEqual(data);
  });
});
