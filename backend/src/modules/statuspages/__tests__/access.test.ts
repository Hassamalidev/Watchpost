import { describe, expect, it } from "vitest";
import {
  ACCESS_PASS_SECONDS,
  accessCookieName,
  hashPagePassword,
  ipAllowed,
  issueAccessPass,
  normalizeAllowedIp,
  parseCookies,
  validAccessPass,
  verifyPagePassword,
} from "../access.js";

const SECRET = "a-secret-for-tests-only";
const now = new Date("2026-10-09T12:00:00Z");

describe("page passwords", () => {
  it("verifies the password it hashed and no other, with a new salt each time", async () => {
    const first = await hashPagePassword("open sesame");
    const second = await hashPagePassword("open sesame");
    expect(first).not.toBe(second);
    expect(first).not.toContain("open sesame");
    expect(await verifyPagePassword("open sesame", first)).toBe(true);
    expect(await verifyPagePassword("open sesame ", first)).toBe(false);
    expect(await verifyPagePassword("open sesame", "not-a-hash")).toBe(false);
  });
});

describe("access passes", () => {
  const page = { id: "0199c0de-0000-7000-8000-000000000001", passwordHash: "scrypt$a$b" };

  it("holds for a month, for this page and this password only", () => {
    const pass = issueAccessPass(SECRET, page, now);
    expect(validAccessPass(SECRET, page, pass, now)).toBe(true);
    const almost = new Date(now.getTime() + (ACCESS_PASS_SECONDS - 1) * 1000);
    expect(validAccessPass(SECRET, page, pass, almost)).toBe(true);
    const after = new Date(now.getTime() + ACCESS_PASS_SECONDS * 1000);
    expect(validAccessPass(SECRET, page, pass, after)).toBe(false);
    expect(validAccessPass(SECRET, { ...page, passwordHash: "scrypt$a$c" }, pass, now)).toBe(false);
    expect(validAccessPass(SECRET, { ...page, id: "another" }, pass, now)).toBe(false);
    expect(validAccessPass("another-secret", page, pass, now)).toBe(false);
  });

  it("can't be given a later end by hand", () => {
    const [expires = "", signature = ""] = issueAccessPass(SECRET, page, now).split(".");
    expect(validAccessPass(SECRET, page, `${Number(expires) + 86_400}.${signature}`, now)).toBe(
      false,
    );
    expect(validAccessPass(SECRET, page, "", now)).toBe(false);
    expect(validAccessPass(SECRET, page, "x.y.z", now)).toBe(false);
  });

  it("is carried in a cookie named after the page", () => {
    expect(accessCookieName(page.id)).toBe("wp_sp_0199c0de000070008000000000000001");
    expect(parseCookies("a=1; wp_sp_x=12.ab_c-d; empty=")).toEqual({
      a: "1",
      wp_sp_x: "12.ab_c-d",
      empty: "",
    });
    expect(parseCookies(undefined)).toEqual({});
  });
});

describe("allowed networks", () => {
  it("accepts addresses and CIDR networks, IPv4 and IPv6", () => {
    expect(normalizeAllowedIp(" 203.0.113.7 ")).toBe("203.0.113.7");
    expect(normalizeAllowedIp("203.0.113.0/24")).toBe("203.0.113.0/24");
    expect(normalizeAllowedIp("2001:DB8::/32")).toBe("2001:db8::/32");
    expect(normalizeAllowedIp("203.0.113.0/33")).toBeUndefined();
    expect(normalizeAllowedIp("999.0.113.0")).toBeUndefined();
    expect(normalizeAllowedIp("example.com")).toBeUndefined();
    expect(normalizeAllowedIp("203.0.113.0/24/1")).toBeUndefined();
  });

  it("lets in only what is listed", () => {
    const allowed = ["203.0.113.0/24", "198.51.100.7", "2001:db8::/32"];
    expect(ipAllowed("203.0.113.200", allowed)).toBe(true);
    expect(ipAllowed("203.0.114.1", allowed)).toBe(false);
    expect(ipAllowed("198.51.100.7", allowed)).toBe(true);
    expect(ipAllowed("198.51.100.8", allowed)).toBe(false);
    expect(ipAllowed("2001:db8:1::5", allowed)).toBe(true);
    expect(ipAllowed("2001:db9::5", allowed)).toBe(false);
    /* An IPv4 visitor seen through an IPv6 socket. */
    expect(ipAllowed("::ffff:203.0.113.9", allowed)).toBe(true);
    expect(ipAllowed("not an address", allowed)).toBe(false);
    expect(ipAllowed("203.0.113.9", [])).toBe(false);
  });
});
