/*
 * Private status pages (PRODUCT.md §6.6): the page's password, the pass a visitor carries once
 * they have entered it, and the list of networks a page may be limited to. No state: a pass is
 * signed with the server's secret and the page's current password hash, so changing the password
 * ends every pass.
 */
import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { BlockList, isIP } from "node:net";

const KEY_LENGTH = 32;
/* A visitor enters the password once a month per browser. */
export const ACCESS_PASS_SECONDS = 30 * 86_400;

export const accessCookieName = (pageId: string) => `wp_sp_${pageId.replace(/-/g, "")}`;

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, (err, key) => {
      if (err === null) resolve(key);
      else reject(err);
    });
  });
}

export async function hashPagePassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPagePassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, key] = stored.split("$");
  if (scheme !== "scrypt" || salt === undefined || key === undefined) return false;
  const expected = Buffer.from(key, "base64url");
  const given = await derive(password, Buffer.from(salt, "base64url"));
  return expected.length === given.length && timingSafeEqual(expected, given);
}

const sign = (secret: string, pageId: string, expires: number, passwordHash: string) =>
  createHmac("sha256", secret)
    .update(`status-page-access\n${pageId}\n${expires}\n${passwordHash}`)
    .digest("base64url");

export function issueAccessPass(
  secret: string,
  page: { id: string; passwordHash: string },
  now: Date,
): string {
  const expires = Math.floor(now.getTime() / 1000) + ACCESS_PASS_SECONDS;
  return `${expires}.${sign(secret, page.id, expires, page.passwordHash)}`;
}

export function validAccessPass(
  secret: string,
  page: { id: string; passwordHash: string },
  pass: string,
  now: Date,
): boolean {
  const [expiresText, signature, ...rest] = pass.split(".");
  if (expiresText === undefined || signature === undefined || rest.length > 0) return false;
  const expires = Number(expiresText);
  if (!Number.isSafeInteger(expires) || expires * 1000 <= now.getTime()) return false;
  const expected = Buffer.from(sign(secret, page.id, expires, page.passwordHash));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/* "::ffff:203.0.113.7" is the IPv4 address 203.0.113.7 seen through an IPv6 socket. */
const plainAddress = (ip: string) => {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip.trim());
  return mapped?.[1] ?? ip.trim();
};

/* An address or CIDR network in the form we store, or undefined when it is neither. */
export function normalizeAllowedIp(entry: string): string | undefined {
  const [address = "", prefixText, ...rest] = entry.trim().toLowerCase().split("/");
  const family = isIP(address);
  if (family === 0 || rest.length > 0) return undefined;
  if (prefixText === undefined) return address;
  if (!/^\d{1,3}$/.test(prefixText)) return undefined;
  const prefix = Number(prefixText);
  if (prefix > (family === 4 ? 32 : 128)) return undefined;
  return `${address}/${prefix}`;
}

export function ipAllowed(ip: string, allowed: string[]): boolean {
  const address = plainAddress(ip);
  const family = isIP(address);
  if (family === 0) return false;
  const list = new BlockList();
  for (const entry of allowed) {
    const [net = "", prefix] = entry.split("/");
    const netFamily = isIP(net);
    if (netFamily === 0) continue;
    const type = netFamily === 4 ? "ipv4" : "ipv6";
    if (prefix === undefined) list.addAddress(net, type);
    else list.addSubnet(net, Number(prefix), type);
  }
  return list.check(address, family === 4 ? "ipv4" : "ipv6");
}

/* The cookies of a request, by name. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    cookies[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return cookies;
}
