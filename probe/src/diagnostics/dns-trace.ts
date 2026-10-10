/*
 * A DNS delegation trace (PRODUCT.md P8-T04): the name is asked for at a root server, then at the
 * servers each answer points to, until one answers or the chain breaks. It shows where a name
 * stops resolving: at the registry (expired domain), at the nameservers (down or misconfigured),
 * or nowhere (the fault is elsewhere). Our own queries, not the machine's resolver, so a cache
 * can't hide the break.
 */
import dgram from "node:dgram";
import dns from "node:dns/promises";
import { randomInt } from "node:crypto";
import type { AddressPolicy, DnsTrace } from "@app/shared";
import { DNS_TYPE, decodeMessage, encodeQuery, type DnsMessage } from "./dns-wire.js";

type Step = DnsTrace["steps"][number];
interface Server {
  name: string;
  ip: string;
}

/* Three of the thirteen roots, run by different operators. */
export const ROOT_SERVERS: Server[] = [
  { name: "a.root-servers.net", ip: "198.41.0.4" },
  { name: "k.root-servers.net", ip: "193.0.14.129" },
  { name: "f.root-servers.net", ip: "192.5.5.241" },
];

const MAX_DEPTH = 10;
const SERVERS_PER_STEP = 2;

export type DnsTransport = (ip: string, packet: Buffer, timeoutMs: number) => Promise<Buffer>;

export const udpTransport: DnsTransport = (ip, packet, timeoutMs) =>
  new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("no answer"));
    }, timeoutMs);
    socket.once("error", (err) => {
      clearTimeout(timer);
      socket.close();
      reject(err);
    });
    socket.on("message", (message, from) => {
      /* Only the server we asked may answer. */
      if (from.address !== ip) return;
      clearTimeout(timer);
      socket.close();
      resolve(message);
    });
    socket.send(packet, 53, ip);
  });

const isUnder = (name: string, zone: string) =>
  zone === "" || name === zone || name.endsWith(`.${zone}`);

export async function traceDns(
  hostname: string,
  options: {
    policy: AddressPolicy;
    transport?: DnsTransport;
    roots?: Server[];
    /* Finds the address of a nameserver the referral gave no address for. */
    resolve?: (name: string) => Promise<string[]>;
    queryTimeoutMs?: number;
    deadlineMs?: number;
    now?: () => number;
  },
): Promise<DnsTrace> {
  const transport = options.transport ?? udpTransport;
  const resolve = options.resolve ?? ((name: string) => dns.resolve4(name));
  const now = options.now ?? Date.now;
  const queryTimeoutMs = options.queryTimeoutMs ?? 1_500;
  const deadline = now() + (options.deadlineMs ?? 8_000);
  const name = hostname.replace(/\.$/, "").toLowerCase();
  const steps: Step[] = [];
  let servers = options.roots ?? ROOT_SERVERS;
  let zone = "";

  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const zoneLabel = zone === "" ? "." : zone;
    let answer: DnsMessage | undefined;
    let asked: Server | undefined;
    let ms = 0;
    let problem = "none of its nameservers has a usable address";
    for (const server of servers.slice(0, SERVERS_PER_STEP)) {
      if (now() >= deadline) {
        problem = "the trace ran out of time";
        break;
      }
      asked = server;
      const blocked = options.policy.check(server.ip);
      if (blocked !== null) {
        problem = `its address is not one we may ask (${blocked})`;
        continue;
      }
      const started = now();
      const id = randomInt(0, 0xffff);
      try {
        const reply = decodeMessage(
          await transport(server.ip, encodeQuery(name, DNS_TYPE.A, id), queryTimeoutMs),
        );
        ms = now() - started;
        if (reply.id !== id) {
          problem = "the answer did not match the question";
          continue;
        }
        answer = reply;
        break;
      } catch (err) {
        ms = now() - started;
        problem = (err as Error).message || "no answer";
      }
    }
    const server = asked === undefined ? "(none)" : `${asked.name} (${asked.ip})`;
    if (answer === undefined) {
      steps.push({ zone: zoneLabel, server, ms, outcome: "error", detail: problem });
      break;
    }
    if (answer.rcode === 3) {
      steps.push({
        zone: zoneLabel,
        server,
        ms,
        outcome: "nxdomain",
        detail: `${zoneLabel === "." ? "The root" : zoneLabel} says ${name} does not exist`,
      });
      break;
    }
    if (answer.rcode !== 0) {
      steps.push({
        zone: zoneLabel,
        server,
        ms,
        outcome: "error",
        detail: `the server answered with error code ${answer.rcode}`,
      });
      break;
    }
    const direct = answer.answers.filter((r) => r.type === "A" || r.type === "CNAME");
    if (direct.length > 0) {
      steps.push({
        zone: zoneLabel,
        server,
        ms,
        outcome: "answer",
        detail: direct
          .slice(0, 6)
          .map((r) => `${r.type} ${r.data}`)
          .join(", "),
      });
      break;
    }
    const referral = answer.authority.filter((r) => r.type === "NS");
    if (referral.length === 0) {
      steps.push({
        zone: zoneLabel,
        server,
        ms,
        outcome: "no_data",
        detail: `${name} exists but has no A record here`,
      });
      break;
    }
    const nextZone = referral[0]?.name ?? "";
    if (!isUnder(name, nextZone) || nextZone === zone || nextZone.length <= zone.length) {
      steps.push({
        zone: zoneLabel,
        server,
        ms,
        outcome: "error",
        detail: `it refers to ${nextZone || "."}, which leads nowhere (a broken delegation)`,
      });
      break;
    }
    const names = [...new Set(referral.map((r) => r.data))];
    steps.push({
      zone: zoneLabel,
      server,
      ms,
      outcome: "referral",
      detail: `${nextZone} is served by ${names.slice(0, 4).join(", ")}`,
    });
    /* Addresses that came with the referral; for the rest, ask the resolver for the first few. */
    const next: Server[] = [];
    for (const ns of names) {
      const glue = answer.additional.find((r) => r.type === "A" && r.name === ns);
      if (glue !== undefined) next.push({ name: ns, ip: glue.data });
    }
    for (const ns of names) {
      if (next.length >= SERVERS_PER_STEP || now() >= deadline) break;
      if (next.some((s) => s.name === ns)) continue;
      try {
        const [ip] = await resolve(ns);
        if (ip !== undefined) next.push({ name: ns, ip });
      } catch {
        /* A nameserver whose own name doesn't resolve; the step after this one says so. */
      }
    }
    servers = next;
    zone = nextZone;
  }
  return { name, steps };
}
