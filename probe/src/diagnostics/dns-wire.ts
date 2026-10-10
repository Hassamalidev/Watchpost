/*
 * The little of the DNS wire format a delegation trace needs (RFC 1035): one question out, and the
 * answer, authority and additional records back. Names may be compressed; pointers are followed
 * with a limit, so a crafted packet can't loop.
 */
export const DNS_TYPE = { A: 1, NS: 2, CNAME: 5, SOA: 6, AAAA: 28 } as const;
const TYPE_NAME: Record<number, string> = { 1: "A", 2: "NS", 5: "CNAME", 6: "SOA", 28: "AAAA" };

export interface DnsRecord {
  name: string;
  type: string;
  /* An address for A and AAAA, a name for NS and CNAME, empty for anything else. */
  data: string;
}

export interface DnsMessage {
  id: number;
  rcode: number;
  truncated: boolean;
  authoritative: boolean;
  answers: DnsRecord[];
  authority: DnsRecord[];
  additional: DnsRecord[];
}

const withoutDot = (name: string) => name.replace(/\.$/, "").toLowerCase();

/* A query without recursion desired: we ask each server only for what it knows itself. */
export function encodeQuery(name: string, type: number, id: number): Buffer {
  const labels = withoutDot(name)
    .split(".")
    .filter((label) => label !== "");
  const parts: Buffer[] = [];
  for (const label of labels) {
    const bytes = Buffer.from(label, "ascii");
    if (bytes.length === 0 || bytes.length > 63) throw new Error(`bad DNS label in ${name}`);
    parts.push(Buffer.from([bytes.length]), bytes);
  }
  const question = Buffer.concat([...parts, Buffer.from([0, 0, type & 0xff, 0, 1])]);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id & 0xffff, 0);
  header.writeUInt16BE(0x0000, 2);
  header.writeUInt16BE(1, 4);
  return Buffer.concat([header, question]);
}

function readName(buf: Buffer, start: number): { name: string; next: number } {
  const labels: string[] = [];
  let at = start;
  let next = -1;
  for (let jumps = 0; jumps < 32;) {
    const length = buf[at];
    if (length === undefined) throw new Error("DNS name runs past the packet");
    if (length === 0) {
      if (next < 0) next = at + 1;
      return { name: labels.join(".").toLowerCase(), next };
    }
    if ((length & 0xc0) === 0xc0) {
      const low = buf[at + 1];
      if (low === undefined) throw new Error("DNS pointer runs past the packet");
      if (next < 0) next = at + 2;
      at = ((length & 0x3f) << 8) | low;
      jumps += 1;
      continue;
    }
    labels.push(buf.subarray(at + 1, at + 1 + length).toString("ascii"));
    at += 1 + length;
    if (labels.length > 127) break;
  }
  throw new Error("DNS name has too many pointers");
}

function ipv6(bytes: Buffer): string {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(bytes.readUInt16BE(i).toString(16));
  return groups.join(":");
}

export function decodeMessage(buf: Buffer): DnsMessage {
  if (buf.length < 12) throw new Error("DNS answer is too short");
  const flags = buf.readUInt16BE(2);
  const counts = [
    buf.readUInt16BE(4),
    buf.readUInt16BE(6),
    buf.readUInt16BE(8),
    buf.readUInt16BE(10),
  ];
  let at = 12;
  for (let i = 0; i < (counts[0] ?? 0); i += 1) at = readName(buf, at).next + 4;
  const sections: DnsRecord[][] = [[], [], []];
  for (let section = 0; section < 3; section += 1) {
    for (let i = 0; i < (counts[section + 1] ?? 0); i += 1) {
      /* A truncated answer may stop mid-record: keep what was whole. */
      if (at >= buf.length) break;
      const owner = readName(buf, at);
      at = owner.next;
      if (at + 10 > buf.length) break;
      const type = buf.readUInt16BE(at);
      const length = buf.readUInt16BE(at + 8);
      const data = at + 10;
      at = data + length;
      if (at > buf.length) break;
      let value = "";
      if (type === DNS_TYPE.A && length === 4) value = [...buf.subarray(data, at)].join(".");
      else if (type === DNS_TYPE.AAAA && length === 16) value = ipv6(buf.subarray(data, at));
      else if (type === DNS_TYPE.NS || type === DNS_TYPE.CNAME) value = readName(buf, data).name;
      sections[section]?.push({
        name: owner.name,
        type: TYPE_NAME[type] ?? `TYPE${type}`,
        data: value,
      });
    }
  }
  return {
    id: buf.readUInt16BE(0),
    rcode: flags & 0x0f,
    truncated: (flags & 0x0200) !== 0,
    authoritative: (flags & 0x0400) !== 0,
    answers: sections[0] ?? [],
    authority: sections[1] ?? [],
    additional: sections[2] ?? [],
  };
}
