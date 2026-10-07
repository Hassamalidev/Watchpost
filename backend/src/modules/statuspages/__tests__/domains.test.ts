/* Does a customer's domain point at us? Table-driven, with DNS answers written out. */
import { describe, expect, it } from "vitest";
import type { DnsLookup } from "../../../infra/dns.js";
import { checkDomain, isSameOrSubdomain } from "../domains.js";

const TARGET = "pages.watchpost.test";

function dns(records: {
  cname?: Record<string, string[]>;
  a?: Record<string, string[]>;
  fail?: boolean;
}): DnsLookup {
  return {
    async cname(host) {
      if (records.fail) throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
      return records.cname?.[host] ?? [];
    },
    async a(host) {
      if (records.fail) throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
      return records.a?.[host] ?? [];
    },
  };
}

describe("checkDomain", () => {
  it("passes when the CNAME points at our target, directly or through a chain", async () => {
    expect(
      await checkDomain(dns({ cname: { "status.acme.io": [TARGET] } }), "status.acme.io", TARGET),
    ).toEqual({ ok: true });
    expect(
      await checkDomain(
        dns({ cname: { "status.acme.io": ["alias.acme.io"], "alias.acme.io": [TARGET] } }),
        "status.acme.io",
        TARGET,
      ),
    ).toEqual({ ok: true });
  });

  it("passes when the CNAME is hidden but the addresses are ours", async () => {
    const lookup = dns({
      a: { "acme.io": ["203.0.113.7"], [TARGET]: ["203.0.113.7", "203.0.113.8"] },
    });
    expect(await checkDomain(lookup, "acme.io", TARGET)).toEqual({ ok: true });
  });

  it("says where the domain points when that is somewhere else", async () => {
    const result = await checkDomain(
      dns({
        cname: { "status.acme.io": ["acme.statuspage.example"] },
        a: { "status.acme.io": ["198.51.100.1"], [TARGET]: ["203.0.113.7"] },
      }),
      "status.acme.io",
      TARGET,
    );
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      reason: expect.stringContaining(
        "points to acme.statuspage.example, not to pages.watchpost.test",
      ),
    });
  });

  it("tells an A record from no record at all", async () => {
    const wrongA = await checkDomain(
      dns({ a: { "status.acme.io": ["198.51.100.1"], [TARGET]: ["203.0.113.7"] } }),
      "status.acme.io",
      TARGET,
    );
    expect(wrongA).toMatchObject({ ok: false, reason: expect.stringContaining("A record") });
    const none = await checkDomain(
      dns({ a: { [TARGET]: ["203.0.113.7"] } }),
      "status.acme.io",
      TARGET,
    );
    expect(none).toMatchObject({
      ok: false,
      reason: expect.stringContaining("No DNS record found"),
    });
  });

  it("concludes nothing when DNS can't be asked", async () => {
    const result = await checkDomain(dns({ fail: true }), "status.acme.io", TARGET);
    expect(result.ok).toBeNull();
  });

  it("stops following a CNAME loop", async () => {
    const result = await checkDomain(
      dns({ cname: { "a.acme.io": ["b.acme.io"], "b.acme.io": ["a.acme.io"] } }),
      "a.acme.io",
      TARGET,
    );
    expect(result.ok).toBe(false);
  });
});

describe("isSameOrSubdomain", () => {
  it("matches the domain and names under it, not look-alikes", () => {
    expect(isSameOrSubdomain("status.acme.io", "status.acme.io")).toBe(true);
    expect(isSameOrSubdomain("x.status.acme.io", "status.acme.io")).toBe(true);
    expect(isSameOrSubdomain("evilstatus.acme.io", "status.acme.io")).toBe(false);
  });
});
