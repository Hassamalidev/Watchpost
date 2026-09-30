/* Threshold arithmetic and RDAP parsing for P1-T15, without a database. */
import { describe, expect, it } from "vitest";
import type { OutboundHttp, OutboundRequest } from "../../../infra/http/outbound.js";
import { crossedThresholds, daysUntil, expiryPhrase } from "../expiry.thresholds.js";
import { lookupDomain, parseBootstrap, parseDomainRecord } from "../rdap.js";

const NOW = new Date("2026-10-01T12:00:00Z");
const inDays = (days: number, extraHours = 0) =>
  new Date(NOW.getTime() + days * 86_400_000 + extraHours * 3_600_000);
const SSL = [30, 14, 7, 3, 1];

describe("thresholds", () => {
  it("counts whole days left", () => {
    expect(daysUntil(inDays(30, 5), NOW)).toBe(30);
    expect(daysUntil(inDays(0, 5), NOW)).toBe(0);
    expect(daysUntil(inDays(-1), NOW)).toBe(-1);
  });

  it("fires nothing while every threshold is ahead", () => {
    expect(crossedThresholds(inDays(31), NOW, SSL, new Set())).toMatchObject({
      notify: null,
      warning: false,
    });
  });

  it("fires each threshold once", () => {
    expect(crossedThresholds(inDays(30), NOW, SSL, new Set())).toMatchObject({
      notify: 30,
      newlyCrossed: [30],
    });
    expect(crossedThresholds(inDays(29), NOW, SSL, new Set([30]))).toMatchObject({
      notify: null,
      warning: true,
    });
    expect(crossedThresholds(inDays(13), NOW, SSL, new Set([30]))).toMatchObject({
      notify: 14,
      newlyCrossed: [14],
    });
  });

  it("jumping past several thresholds sends one warning for the most urgent", () => {
    expect(crossedThresholds(inDays(5), NOW, SSL, new Set())).toMatchObject({
      notify: 7,
      newlyCrossed: [30, 14, 7],
    });
    expect(crossedThresholds(inDays(-2), NOW, SSL, new Set([30, 14, 7]))).toMatchObject({
      notify: 1,
      newlyCrossed: [3, 1],
    });
  });

  it("phrases the time left", () => {
    expect(expiryPhrase(5)).toBe("expires in 5 days");
    expect(expiryPhrase(1)).toBe("expires in 1 day");
    expect(expiryPhrase(0)).toBe("expires today");
    expect(expiryPhrase(-3)).toBe("has expired");
  });
});

describe("RDAP", () => {
  const bootstrap = parseBootstrap({
    services: [
      [["com", "net"], ["https://rdap.verisign.com/com/v1/"]],
      [["org"], ["http://insecure.example/", "https://rdap.publicinterestregistry.org/rdap/"]],
      [["bad"], "not-a-list"],
    ],
  });
  const record = {
    events: [
      { eventAction: "registration", eventDate: "1995-08-14T04:00:00Z" },
      { eventAction: "expiration", eventDate: "2027-08-13T04:00:00Z" },
    ],
    entities: [
      {
        roles: ["registrar"],
        vcardArray: [
          "vcard",
          [
            ["version", {}, "text", "4.0"],
            ["fn", {}, "text", "RESERVED-IANA"],
          ],
        ],
      },
    ],
  };

  it("maps TLDs to https RDAP servers only", () => {
    expect(bootstrap.get("com")).toEqual(["https://rdap.verisign.com/com/v1/"]);
    expect(bootstrap.get("org")).toEqual(["https://rdap.publicinterestregistry.org/rdap/"]);
    expect(bootstrap.has("bad")).toBe(false);
  });

  it("reads the expiration event and the registrar", () => {
    expect(parseDomainRecord(record)).toEqual({
      expiresAt: new Date("2027-08-13T04:00:00Z"),
      registrar: "RESERVED-IANA",
    });
    expect(parseDomainRecord({ events: [] })).toEqual({ expiresAt: null, registrar: null });
  });

  it("looks domains up at the TLD's registry and reports unsupported TLDs clearly", async () => {
    const requests: OutboundRequest[] = [];
    const http: OutboundHttp = {
      async request(req) {
        requests.push(req);
        if (req.url.endsWith("/missing.com")) return { status: 404, headers: {}, body: "" };
        return { status: 200, headers: {}, body: JSON.stringify(record) };
      },
    };
    expect(await lookupDomain(http, bootstrap, "Example.COM.")).toEqual({
      status: "ok",
      expiresAt: new Date("2027-08-13T04:00:00Z"),
      registrar: "RESERVED-IANA",
    });
    expect(requests[0]?.url).toBe("https://rdap.verisign.com/com/v1/domain/example.com");
    expect(await lookupDomain(http, bootstrap, "missing.com")).toMatchObject({
      status: "error",
      error: expect.stringContaining("registrable domain"),
    });
    expect(await lookupDomain(http, bootstrap, "shop.zz")).toEqual({
      status: "unsupported",
      error: "Domain expiry isn't available for .zz domains: the registry has no RDAP service.",
    });
  });
});
