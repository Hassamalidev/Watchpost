/*
 * Minimal UDP DNS server for DNS check tests: answers A, TXT and MX from a table, and can reply
 * SERVFAIL, NXDOMAIN, an empty NOERROR, or nothing at all (timeout).
 */
import dgram from "node:dgram";
import { once } from "node:events";

type Zone = Record<
  string,
  | { A?: string[]; TXT?: string[]; MX?: Array<[number, string]> }
  | "servfail"
  | "nxdomain"
  | "empty"
  | "silent"
>;

const TYPE = { A: 1, MX: 15, TXT: 16 } as const;

function encodeName(name: string): Buffer {
  const parts = name.replace(/\.$/, "").split(".");
  return Buffer.concat([
    ...parts.map((p) => Buffer.concat([Buffer.from([p.length]), Buffer.from(p, "ascii")])),
    Buffer.from([0]),
  ]);
}

function readName(msg: Buffer, offset: number): { name: string; end: number } {
  const labels: string[] = [];
  let i = offset;
  while ((msg[i] ?? 0) !== 0) {
    const len = msg[i] ?? 0;
    labels.push(msg.subarray(i + 1, i + 1 + len).toString("ascii"));
    i += len + 1;
  }
  return { name: labels.join(".").toLowerCase(), end: i + 1 };
}

function rr(type: number, rdata: Buffer): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0xc00c, 0);
  header.writeUInt16BE(type, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt32BE(60, 6);
  header.writeUInt16BE(rdata.length, 10);
  return Buffer.concat([header, rdata]);
}

function answersFor(entry: Exclude<Zone[string], string>, qtype: number): Buffer[] {
  if (qtype === TYPE.A) {
    return (entry.A ?? []).map((ip) => rr(TYPE.A, Buffer.from(ip.split(".").map(Number))));
  }
  if (qtype === TYPE.TXT) {
    return (entry.TXT ?? []).map((t) =>
      rr(TYPE.TXT, Buffer.concat([Buffer.from([t.length]), Buffer.from(t)])),
    );
  }
  if (qtype === TYPE.MX) {
    return (entry.MX ?? []).map(([prio, host]) => {
      const p = Buffer.alloc(2);
      p.writeUInt16BE(prio);
      return rr(TYPE.MX, Buffer.concat([p, encodeName(host)]));
    });
  }
  return [];
}

export async function startDnsServer(
  zone: Zone,
): Promise<{ port: number; close(): Promise<void> }> {
  const socket = dgram.createSocket("udp4");
  socket.on("message", (msg, remote) => {
    const id = msg.readUInt16BE(0);
    const { name, end } = readName(msg, 12);
    const qtype = msg.readUInt16BE(end);
    const question = msg.subarray(12, end + 4);
    const entry = zone[name] ?? "nxdomain";
    if (entry === "silent") return;

    let rcode = 0;
    let answers: Buffer[] = [];
    if (entry === "servfail") rcode = 2;
    else if (entry === "nxdomain") rcode = 3;
    else if (entry !== "empty") answers = answersFor(entry, qtype);

    const header = Buffer.alloc(12);
    header.writeUInt16BE(id, 0);
    header.writeUInt16BE(0x8180 | rcode, 2);
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(answers.length, 6);
    socket.send(Buffer.concat([header, question, ...answers]), remote.port, remote.address);
  });
  socket.bind(0, "127.0.0.1");
  await once(socket, "listening");
  return {
    port: socket.address().port,
    close: () => new Promise((r) => socket.close(() => r())),
  };
}
