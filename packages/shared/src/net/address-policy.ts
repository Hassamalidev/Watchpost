/*
 * Which IP addresses we may connect to (PRODUCT.md §9.1 step 1): probes for checks, the API for
 * outbound webhooks and chat APIs. Only public unicast addresses by default; IPv4 embedded in IPv6
 * (mapped, compatible, NAT64, 6to4) is checked as IPv4, and Teredo is refused outright. Private
 * probes skip only the private-range rule (§9.1 step 6).
 */
import ipaddr from "ipaddr.js";

type Cidr = [ipaddr.IPv4 | ipaddr.IPv6, number];

const parseCidrs = (list: readonly string[]): Cidr[] => list.map((c) => ipaddr.parseCIDR(c));

/* Never reachable from any probe: unspecified, multicast, reserved and broadcast space. */
const ALWAYS_BLOCKED = parseCidrs([
  "0.0.0.0/8",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "::/128",
  "ff00::/8",
]);

/* Blocked for managed probes; private probes may reach these (their whole purpose). */
const PRIVATE_OR_SPECIAL = parseCidrs([
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
  "2001:db8::/32",
  "100::/64",
  /* Local-use NAT64 prefix; the well-known 64:ff9b::/96 is unwrapped instead. */
  "64:ff9b:1::/48",
]);

const TEREDO = ipaddr.parseCIDR("2001::/32");
const NAT64 = ipaddr.parseCIDR("64:ff9b::/96");
const SIX_TO_FOUR = ipaddr.parseCIDR("2002::/16");
const IPV4_COMPATIBLE = ipaddr.parseCIDR("::/96");

export interface AddressPolicy {
  /* Null when allowed, otherwise the reason it is blocked. */
  check(ip: string): string | null;
  /* Hostnames that are always refused (our own infrastructure). */
  isDeniedHost(hostname: string): boolean;
}

function inAny(address: ipaddr.IPv4 | ipaddr.IPv6, ranges: readonly Cidr[]): Cidr | undefined {
  return ranges.find(
    ([range, bits]) => address.kind() === range.kind() && address.match(range, bits),
  );
}

/* The IPv4 address an IPv6 address carries, if it is one of the embedding formats. */
export function embeddedIPv4(address: ipaddr.IPv6): ipaddr.IPv4 | undefined {
  if (address.isIPv4MappedAddress()) return address.toIPv4Address();
  const bytes = address.toByteArray();
  const last4 = (from: number) => new ipaddr.IPv4(bytes.slice(from, from + 4));
  if (address.match(NAT64[0] as ipaddr.IPv6, NAT64[1])) return last4(12);
  if (address.match(SIX_TO_FOUR[0] as ipaddr.IPv6, SIX_TO_FOUR[1])) return last4(2);
  /* Deprecated IPv4-compatible form (::a.b.c.d); ::1 and :: are judged as IPv6 themselves. */
  if (
    address.match(IPV4_COMPATIBLE[0] as ipaddr.IPv6, IPV4_COMPATIBLE[1]) &&
    (bytes[12] ?? 0) !== 0
  ) {
    return last4(12);
  }
  return undefined;
}

export function createAddressPolicy(
  options: {
    allowPrivate?: boolean;
    /* Extra ranges to allow (for example a local test target); checked before everything else. */
    allowCidrs?: readonly string[];
    /* Extra ranges to refuse (for example our own servers). */
    denyCidrs?: readonly string[];
    denyHosts?: readonly string[];
  } = {},
): AddressPolicy {
  const allow = parseCidrs(options.allowCidrs ?? []);
  const deny = parseCidrs(options.denyCidrs ?? []);
  const deniedHosts = new Set(
    (options.denyHosts ?? []).map((h) => h.toLowerCase().replace(/\.$/, "")),
  );

  function checkParsed(address: ipaddr.IPv4 | ipaddr.IPv6): string | null {
    if (inAny(address, allow)) return null;
    const denied = inAny(address, deny);
    if (denied) return `address ${address.toString()} is on the deny list`;
    if (address.kind() === "ipv6") {
      const v6 = address as ipaddr.IPv6;
      if (v6.match(TEREDO[0] as ipaddr.IPv6, TEREDO[1])) return "Teredo addresses are not allowed";
      const v4 = embeddedIPv4(v6);
      if (v4) return checkParsed(v4);
    }
    const always = inAny(address, ALWAYS_BLOCKED);
    if (always)
      return `${address.toString()} is in the reserved range ${always[0].toString()}/${always[1]}`;
    if (!options.allowPrivate) {
      const special = inAny(address, PRIVATE_OR_SPECIAL);
      if (special) {
        return `${address.toString()} is in the private or reserved range ${special[0].toString()}/${special[1]}`;
      }
    }
    return null;
  }

  return {
    check(ip) {
      if (!ipaddr.isValid(ip)) return `"${ip}" is not an IP address`;
      return checkParsed(ipaddr.parse(ip));
    },
    isDeniedHost(hostname) {
      return deniedHosts.has(hostname.toLowerCase().replace(/\.$/, ""));
    },
  };
}
