/* P1-T06 AC: every blocked range, IPv6 forms, IPv4-mapped, NAT64 and other embeddings (§9.1 step 1). */
import { describe, expect, it } from "vitest";
import { createAddressPolicy } from "../address-policy.js";

const managed = createAddressPolicy();
const blocked = (ip: string) => managed.check(ip) !== null;

describe("managed probes", () => {
  it.each([
    ["0.0.0.0/8", "0.0.0.1"],
    ["10/8", "10.1.2.3"],
    ["100.64/10", "100.64.0.1"],
    ["100.64/10 end", "100.127.255.254"],
    ["127/8", "127.0.0.1"],
    ["127/8 other", "127.255.0.9"],
    ["169.254/16 (cloud metadata)", "169.254.169.254"],
    ["172.16/12", "172.16.5.4"],
    ["172.16/12 end", "172.31.255.254"],
    ["192.0.0/24", "192.0.0.1"],
    ["192.0.2/24", "192.0.2.10"],
    ["192.168/16", "192.168.1.1"],
    ["198.18/15", "198.18.0.1"],
    ["198.18/15 end", "198.19.255.1"],
    ["198.51.100/24", "198.51.100.5"],
    ["203.0.113/24", "203.0.113.9"],
    ["224/4 multicast", "224.0.0.1"],
    ["224/4 multicast end", "239.255.255.250"],
    ["240/4 reserved", "240.0.0.1"],
    ["broadcast", "255.255.255.255"],
  ])("blocks IPv4 %s (%s)", (_range, ip) => {
    expect(blocked(ip)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "172.32.0.1",
    "100.128.0.1",
    "198.20.0.1",
    "11.0.0.1",
  ])("allows public IPv4 %s", (ip) => {
    expect(managed.check(ip)).toBeNull();
  });

  it.each([
    ["unspecified", "::"],
    ["loopback", "::1"],
    ["ULA fc00::/7", "fc00::1"],
    ["ULA fd", "fd12:3456::1"],
    ["link-local", "fe80::1"],
    ["multicast", "ff02::1"],
    ["documentation", "2001:db8::1"],
    ["discard-only 100::/64", "100::1"],
    ["local-use NAT64", "64:ff9b:1::1"],
    ["Teredo", "2001:0:4136:e378::1"],
  ])("blocks IPv6 %s (%s)", (_name, ip) => {
    expect(blocked(ip)).toBe(true);
  });

  it.each(["2606:4700:4700::1111", "2001:4860:4860::8888"])("allows public IPv6 %s", (ip) => {
    expect(managed.check(ip)).toBeNull();
  });

  it.each([
    ["IPv4-mapped loopback", "::ffff:127.0.0.1"],
    ["IPv4-mapped hex", "::ffff:7f00:1"],
    ["IPv4-mapped private", "::ffff:10.0.0.1"],
    ["IPv4-mapped metadata", "::ffff:169.254.169.254"],
    ["NAT64 loopback", "64:ff9b::7f00:1"],
    ["NAT64 private", "64:ff9b::a00:1"],
    ["NAT64 dotted", "64:ff9b::192.168.0.1"],
    ["6to4 loopback", "2002:7f00:1::"],
    ["IPv4-compatible loopback", "::127.0.0.1"],
  ])("checks embedded IPv4 as IPv4: %s (%s)", (_name, ip) => {
    expect(blocked(ip)).toBe(true);
  });

  it.each(["::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1"])(
    "allows embedded public IPv4 %s",
    (ip) => {
      expect(managed.check(ip)).toBeNull();
    },
  );

  it("normalizes odd IPv4 notations through the URL parser before checking", () => {
    for (const url of [
      "http://0x7f000001/",
      "http://2130706433/",
      "http://0177.0.0.1/",
      "http://127.1/",
    ]) {
      const host = new URL(url).hostname;
      expect(host, url).toBe("127.0.0.1");
      expect(blocked(host)).toBe(true);
    }
  });

  it("refuses non-IPs, denied hosts and deny ranges", () => {
    expect(managed.check("not-an-ip")).not.toBeNull();
    const policy = createAddressPolicy({
      denyHosts: ["app.example.com."],
      denyCidrs: ["8.8.8.0/24"],
    });
    expect(policy.isDeniedHost("APP.example.com")).toBe(true);
    expect(policy.isDeniedHost("example.com")).toBe(false);
    expect(policy.check("8.8.8.8")).not.toBeNull();
  });
});

describe("private probes", () => {
  const priv = createAddressPolicy({ allowPrivate: true });

  it.each([
    "10.0.0.1",
    "172.16.0.9",
    "192.168.1.1",
    "127.0.0.1",
    "100.64.1.1",
    "fd00::1",
    "::1",
    "::ffff:10.0.0.1",
  ])("may reach private address %s", (ip) => {
    expect(priv.check(ip)).toBeNull();
  });

  it.each([
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "240.1.1.1",
    "::",
    "ff02::1",
    "2001:0:4136:e378::1",
  ])("still can't reach %s", (ip) => {
    expect(priv.check(ip)).not.toBeNull();
  });

  it("allowCidrs opens a specific range for managed probes (for example a local test target)", () => {
    const policy = createAddressPolicy({ allowCidrs: ["127.0.0.1/32"] });
    expect(policy.check("127.0.0.1")).toBeNull();
    expect(policy.check("127.0.0.2")).not.toBeNull();
  });
});
