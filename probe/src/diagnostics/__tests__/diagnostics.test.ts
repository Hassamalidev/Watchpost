/*
 * P8-T04 on the probe: the DNS delegation trace against servers played by the test, the two path
 * tools' output, and what the whole diagnosis says when a target can't be reached or isn't allowed.
 */
import { describe, expect, it, vi } from "vitest";
import { monitorConfigSchema, networkDiagnosticsSchema, type CheckResult } from "@app/shared";
import pino from "pino";
import type { Executor } from "../../executor/executor.js";
import { createAddressPolicy } from "../../net/address-policy.js";
import { createTaskLoop } from "../../tasks/tasks.js";
import type { ProbeClient } from "../../transport/client.js";
import { traceDns, type DnsTransport } from "../dns-trace.js";
import { DNS_TYPE, decodeMessage, encodeQuery } from "../dns-wire.js";
import { runDiagnostics } from "../index.js";
import { parseTracepath, parseTraceroute, tracePath, type RunCommand } from "../traceroute.js";

/* The addresses in these tests are the documentation ranges, which a probe refuses by default. */
const policy = createAddressPolicy({
  allowCidrs: ["203.0.113.0/24", "198.51.100.0/24", "192.0.2.0/24"],
});

/* A DNS name on the wire, uncompressed. */
function wireName(name: string): Buffer {
  const parts = name
    .split(".")
    .filter((label) => label !== "")
    .flatMap((label) => [Buffer.from([label.length]), Buffer.from(label, "ascii")]);
  return Buffer.concat([...parts, Buffer.from([0])]);
}

type Rr = { name: string; type: keyof typeof DNS_TYPE; data: string };
function record(rr: Rr): Buffer {
  const rdata =
    rr.type === "A"
      ? Buffer.from(rr.data.split(".").map(Number))
      : rr.type === "NS" || rr.type === "CNAME"
        ? wireName(rr.data)
        : Buffer.alloc(0);
  const head = Buffer.alloc(10);
  head.writeUInt16BE(DNS_TYPE[rr.type], 0);
  head.writeUInt16BE(1, 2);
  head.writeUInt32BE(300, 4);
  head.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([wireName(rr.name), head, rdata]);
}

/* The answer a server gives to `query`. */
function reply(
  query: Buffer,
  sections: { rcode?: number; answers?: Rr[]; authority?: Rr[]; additional?: Rr[] },
): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(query.readUInt16BE(0), 0);
  header.writeUInt16BE(0x8000 | (sections.rcode ?? 0), 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(sections.answers?.length ?? 0, 6);
  header.writeUInt16BE(sections.authority?.length ?? 0, 8);
  header.writeUInt16BE(sections.additional?.length ?? 0, 10);
  return Buffer.concat([
    header,
    query.subarray(12),
    ...(sections.answers ?? []).map(record),
    ...(sections.authority ?? []).map(record),
    ...(sections.additional ?? []).map(record),
  ]);
}

const ROOT = [{ name: "a.root-servers.net", ip: "198.41.0.4" }];
const toCom = {
  authority: [{ name: "com", type: "NS" as const, data: "a.gtld-servers.net" }],
  additional: [{ name: "a.gtld-servers.net", type: "A" as const, data: "192.5.6.30" }],
};
const toExample = (glue: string | null) => ({
  authority: [{ name: "example.com", type: "NS" as const, data: "ns1.example-dns.net" }],
  additional:
    glue === null ? [] : [{ name: "ns1.example-dns.net", type: "A" as const, data: glue }],
});

/* Servers by address; a missing one never answers. */
const network =
  (servers: Record<string, (query: Buffer) => Buffer>): DnsTransport =>
  async (ip, packet) => {
    const server = servers[ip];
    if (server === undefined) throw new Error("no answer");
    return server(packet);
  };

describe("DNS on the wire", () => {
  it("asks without recursion and reads back names, addresses and compression", () => {
    const query = encodeQuery("Shop.Example.com.", DNS_TYPE.A, 0x1234);
    expect(query.readUInt16BE(0)).toBe(0x1234);
    /* Recursion is not asked for: each server speaks only for itself. */
    expect(query.readUInt16BE(2) & 0x0100).toBe(0);
    expect(query.subarray(12).toString("latin1")).toContain("\x04shop\x07example\x03com\x00");

    const message = decodeMessage(
      reply(query, {
        answers: [{ name: "shop.example.com", type: "A", data: "203.0.113.9" }],
        authority: [{ name: "example.com", type: "NS", data: "ns1.example-dns.net" }],
      }),
    );
    expect(message).toMatchObject({
      id: 0x1234,
      rcode: 0,
      answers: [{ name: "shop.example.com", type: "A", data: "203.0.113.9" }],
      authority: [{ name: "example.com", type: "NS", data: "ns1.example-dns.net" }],
    });

    /* An owner name that is a pointer back to the question. */
    const pointer = Buffer.concat([
      reply(query, {}).subarray(0, 6),
      Buffer.from([0, 1, 0, 0, 0, 0]),
      query.subarray(12),
      Buffer.from([0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 198, 51, 100, 7]),
    ]);
    expect(decodeMessage(pointer).answers).toEqual([
      { name: "shop.example.com", type: "A", data: "198.51.100.7" },
    ]);
  });

  it("refuses a packet whose pointers go in circles, and keeps what a cut-off one had", () => {
    const loop = Buffer.concat([Buffer.alloc(12), Buffer.from([0xc0, 12])]);
    loop.writeUInt16BE(1, 4);
    expect(() => decodeMessage(loop)).toThrow(/pointers/);
    const query = encodeQuery("example.com", DNS_TYPE.A, 1);
    const whole = reply(query, {
      answers: [
        { name: "example.com", type: "A", data: "203.0.113.1" },
        { name: "example.com", type: "A", data: "203.0.113.2" },
      ],
    });
    expect(decodeMessage(whole.subarray(0, whole.length - 3)).answers).toHaveLength(1);
  });
});

describe("DNS delegation trace", () => {
  it("follows the referrals from the root to an answer", async () => {
    const trace = await traceDns("shop.example.com", {
      policy,
      roots: ROOT,
      transport: network({
        "198.41.0.4": (q) => reply(q, toCom),
        "192.5.6.30": (q) => reply(q, toExample("203.0.113.53")),
        "203.0.113.53": (q) =>
          reply(q, { answers: [{ name: "shop.example.com", type: "A", data: "203.0.113.9" }] }),
      }),
    });
    expect(trace.name).toBe("shop.example.com");
    expect(trace.steps.map((s) => [s.zone, s.outcome])).toEqual([
      [".", "referral"],
      ["com", "referral"],
      ["example.com", "answer"],
    ]);
    expect(trace.steps[0]).toMatchObject({
      server: "a.root-servers.net (198.41.0.4)",
      detail: "com is served by a.gtld-servers.net",
    });
    expect(trace.steps[2]?.detail).toBe("A 203.0.113.9");
  });

  it("looks up a nameserver the referral gave no address for", async () => {
    const asked: string[] = [];
    const trace = await traceDns("shop.example.com", {
      policy,
      roots: ROOT,
      resolve: async (name) => {
        asked.push(name);
        return ["203.0.113.53"];
      },
      transport: network({
        "198.41.0.4": (q) => reply(q, toCom),
        "192.5.6.30": (q) => reply(q, toExample(null)),
        "203.0.113.53": (q) =>
          reply(q, {
            answers: [{ name: "shop.example.com", type: "CNAME", data: "edge.cdn.net" }],
          }),
      }),
    });
    expect(asked).toEqual(["ns1.example-dns.net"]);
    expect(trace.steps.at(-1)).toMatchObject({ outcome: "answer", detail: "CNAME edge.cdn.net" });
  });

  it("says where the chain breaks: an expired domain, silent nameservers, a broken delegation", async () => {
    const expired = await traceDns("shop.example.com", {
      policy,
      roots: ROOT,
      transport: network({
        "198.41.0.4": (q) => reply(q, toCom),
        "192.5.6.30": (q) => reply(q, { rcode: 3 }),
      }),
    });
    expect(expired.steps.at(-1)).toMatchObject({
      zone: "com",
      outcome: "nxdomain",
      detail: "com says shop.example.com does not exist",
    });

    const silent = await traceDns("shop.example.com", {
      policy,
      roots: ROOT,
      transport: network({
        "198.41.0.4": (q) => reply(q, toCom),
        "192.5.6.30": (q) => reply(q, toExample("203.0.113.53")),
      }),
    });
    expect(silent.steps.at(-1)).toMatchObject({
      zone: "example.com",
      server: "ns1.example-dns.net (203.0.113.53)",
      outcome: "error",
      detail: "no answer",
    });

    const lame = await traceDns("shop.example.com", {
      policy,
      roots: ROOT,
      transport: network({
        "198.41.0.4": (q) => reply(q, toCom),
        "192.5.6.30": (q) => reply(q, toCom),
      }),
    });
    expect(lame.steps.at(-1)).toMatchObject({ zone: "com", outcome: "error" });
    expect(lame.steps.at(-1)?.detail).toContain("broken delegation");
    expect(lame.steps).toHaveLength(2);
  });

  it("never asks a nameserver at an address the probe may not reach", async () => {
    const asked: string[] = [];
    const trace = await traceDns("shop.example.com", {
      policy,
      roots: ROOT,
      transport: async (ip, packet) => {
        asked.push(ip);
        if (ip === "198.41.0.4") return reply(packet, toCom);
        if (ip === "192.5.6.30") return reply(packet, toExample("169.254.169.254"));
        throw new Error("should not be asked");
      },
    });
    expect(asked).toEqual(["198.41.0.4", "192.5.6.30"]);
    expect(trace.steps.at(-1)).toMatchObject({ zone: "example.com", outcome: "error" });
    expect(trace.steps.at(-1)?.detail).toContain("not one we may ask");
  });

  it("ignores an answer to another question", async () => {
    const trace = await traceDns("shop.example.com", {
      policy,
      roots: ROOT,
      transport: async (_ip, packet) => {
        const forged = reply(packet, {
          answers: [{ name: "shop.example.com", type: "A", data: "203.0.113.66" }],
        });
        forged.writeUInt16BE((packet.readUInt16BE(0) + 1) & 0xffff, 0);
        return forged;
      },
    });
    expect(trace.steps).toMatchObject([{ outcome: "error" }]);
  });
});

describe("path tracing", () => {
  const TRACEPATH = [
    " 1?: [LOCALHOST]                      pmtu 1500",
    " 1:  192.0.2.1                                             0.531ms ",
    " 1:  192.0.2.1                                             0.426ms ",
    " 2:  no reply",
    " 3:  198.51.100.7                                         12.500ms asymm  4 ",
    " 4:  203.0.113.9                                          85.300ms reached",
    "     Resume: pmtu 1500 hops 4 back 4 ",
  ].join("\n");

  it("reads tracepath", () => {
    expect(parseTracepath(TRACEPATH)).toEqual({
      hops: [
        { hop: 1, ip: "192.0.2.1", rttMs: 0.426 },
        { hop: 2, ip: null, rttMs: null },
        { hop: 3, ip: "198.51.100.7", rttMs: 12.5 },
        { hop: 4, ip: "203.0.113.9", rttMs: 85.3 },
      ],
      reached: true,
    });
  });

  it("reads traceroute, and knows the target was reached by its address", () => {
    const output = [
      "traceroute to 203.0.113.9 (203.0.113.9), 20 hops max, 60 byte packets",
      " 1  192.0.2.1  0.512 ms",
      " 2  *",
      " 3  203.0.113.9  84.1 ms",
    ].join("\n");
    expect(parseTraceroute(output, "203.0.113.9")).toEqual({
      hops: [
        { hop: 1, ip: "192.0.2.1", rttMs: 0.512 },
        { hop: 2, ip: null, rttMs: null },
        { hop: 3, ip: "203.0.113.9", rttMs: 84.1 },
      ],
      reached: true,
    });
    expect(parseTraceroute(" 1  192.0.2.1  0.5 ms\n 2  *\n", "203.0.113.9").reached).toBe(false);
  });

  it("uses tracepath, falls back to traceroute, and says nothing when the machine has neither", async () => {
    const calls: string[] = [];
    const run =
      (have: string[]): RunCommand =>
      async (command, args) => {
        calls.push(`${command} ${args.join(" ")}`);
        if (!have.includes(command)) return undefined;
        return command === "tracepath" ? TRACEPATH : " 1  192.0.2.1  0.5 ms\n 2  *\n 3  *\n 4  *\n";
      };
    expect(await tracePath("203.0.113.9", { run: run(["tracepath"]) })).toMatchObject({
      tool: "tracepath",
      reached: true,
    });
    expect(calls).toEqual(["tracepath -n -m 20 203.0.113.9"]);

    const fallback = await tracePath("203.0.113.9", { run: run(["traceroute"]) });
    /* Hops that never answered are cut down to the first one. */
    expect(fallback).toEqual({
      tool: "traceroute",
      hops: [
        { hop: 1, ip: "192.0.2.1", rttMs: 0.5 },
        { hop: 2, ip: null, rttMs: null },
      ],
      reached: false,
    });
    expect(await tracePath("203.0.113.9", { run: run([]) })).toBeUndefined();
    /* Only an address is ever handed to a command. */
    calls.length = 0;
    expect(await tracePath("example.com; rm -rf /", { run: run(["tracepath"]) })).toBeUndefined();
    expect(calls).toEqual([]);
  });
});

describe("a diagnosis", () => {
  const http = (url: string) => monitorConfigSchema.parse({ type: "http", url });

  it("traces the path and the name, and fits what the API accepts", async () => {
    const result = await runDiagnostics(http("https://shop.example.com/health"), {
      policy,
      resolver: async () => [{ address: "203.0.113.9", family: 4 }],
      run: async () => " 1:  192.0.2.1   0.4ms \n 2:  203.0.113.9   9.1ms reached\n",
      transport: network({
        "198.41.0.4": (q) =>
          reply(q, { answers: [{ name: "shop.example.com", type: "A", data: "203.0.113.9" }] }),
      }),
    });
    expect(result).toMatchObject({
      host: "shop.example.com",
      address: "203.0.113.9",
      traceroute: { tool: "tracepath", reached: true },
      dnsTrace: { name: "shop.example.com" },
      notes: [],
    });
    expect(networkDiagnosticsSchema.safeParse(result).success).toBe(true);
  });

  it("still traces the name when it doesn't resolve, and says there is no path to trace", async () => {
    const run = vi.fn();
    const result = await runDiagnostics(http("https://gone.example.com/"), {
      policy,
      resolver: async () => {
        throw Object.assign(new Error("getaddrinfo ENOTFOUND gone.example.com"), {
          code: "ENOTFOUND",
        });
      },
      run,
      transport: network({ "198.41.0.4": (q) => reply(q, { rcode: 3 }) }),
    });
    expect(run).not.toHaveBeenCalled();
    expect(result).toMatchObject({ address: null, traceroute: null });
    expect(result?.dnsTrace?.steps.at(-1)?.outcome).toBe("nxdomain");
    expect(result?.notes[0]).toContain("did not resolve");
  });

  it("traces nothing for a target the probe may not reach", async () => {
    const run = vi.fn();
    const transport = vi.fn();
    const result = await runDiagnostics(http("http://internal.example.com/"), {
      policy,
      resolver: async () => [{ address: "10.0.0.5", family: 4 }],
      run,
      transport,
    });
    expect(run).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    expect(result).toMatchObject({ address: null, traceroute: null, dnsTrace: null });
    expect(result?.notes[0]).toContain("may not reach");
  });

  it("traces the path only for an address, and nothing for a heartbeat", async () => {
    const tcp = await runDiagnostics(
      monitorConfigSchema.parse({ type: "tcp", host: "203.0.113.9", port: 443 }),
      { policy, run: async () => undefined },
    );
    expect(tcp).toMatchObject({ host: "203.0.113.9", dnsTrace: null, traceroute: null });
    expect(tcp?.notes).toEqual(["This probe has no path-tracing tool installed."]);
    expect(
      await runDiagnostics(
        monitorConfigSchema.parse({
          type: "heartbeat",
          schedule: { kind: "period", periodSeconds: 60 },
        }),
        { policy },
      ),
    ).toBeUndefined();
  });
});

describe("the task loop", () => {
  it("says it runs diagnostics, runs them for a diagnose task and posts the result", async () => {
    const monitor = {
      id: "0199c0de-0000-7000-8000-000000000001",
      workspaceId: "0199c0de-0000-7000-8000-0000000000ff",
      configSeq: 1,
      intervalSeconds: 60,
      timeoutMs: 5_000,
      config: monitorConfigSchema.parse({ type: "http", url: "https://shop.example.com/" }),
    };
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    let polls = 0;
    const client = {
      request: async (method: string, path: string, options: { body?: unknown }) => {
        requests.push({
          method,
          path,
          ...(options.body === undefined ? {} : { body: options.body }),
        });
        if (method === "GET") {
          polls += 1;
          if (polls > 1) return new Promise(() => undefined);
          return {
            tasks: [
              {
                id: "0199c0de-0000-7000-8000-0000000000aa",
                kind: "diagnose",
                monitor,
                deadline: new Date(Date.now() + 60_000).toISOString(),
              },
            ],
          };
        }
        return { recorded: true };
      },
    } as unknown as ProbeClient;
    const ran = vi.fn();
    const executor = { run: ran } as unknown as Executor;
    const found = {
      host: "shop.example.com",
      address: null,
      traceroute: null,
      dnsTrace: null,
      notes: [],
      tookMs: 5,
    };
    const loop = createTaskLoop({
      client,
      executor,
      report: (_result: CheckResult) => undefined,
      policy,
      diagnose: async () => found,
      logger: pino({ level: "silent" }),
      waitSeconds: 0,
    });
    loop.start();
    await vi.waitFor(() => expect(requests.some((r) => r.method === "POST")).toBe(true));
    await loop.stop();
    expect(requests[0]).toEqual({
      method: "GET",
      path: "/tasks?wait=0&kinds=verify,test,diagnose",
    });
    expect(requests.find((r) => r.method === "POST")).toEqual({
      method: "POST",
      path: "/diagnostics",
      body: { taskId: "0199c0de-0000-7000-8000-0000000000aa", diagnostics: found },
    });
    /* A diagnose task is not a check: the executor never sees it. */
    expect(ran).not.toHaveBeenCalled();
  });
});
