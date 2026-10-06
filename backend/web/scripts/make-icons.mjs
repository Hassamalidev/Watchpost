/*
 * Draws the app icons for the install manifest (public/icons/*.png) with nothing but zlib: a dark
 * square with a white ring and a green centre, like a radar blip. Run it again if the icon changes:
 * `node scripts/make-icons.mjs`. The maskable icon keeps the drawing inside the safe zone.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buffer) => {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const check = Buffer.alloc(4);
  check.writeUInt32BE(crc(body));
  return Buffer.concat([length, body, check]);
};

const DARK = [20, 20, 20];
const WHITE = [255, 255, 255];
const GREEN = [34, 197, 94];
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
/* 1 inside the shape, 0 outside, a soft pixel at the edge. */
const edge = (distance, radius) => Math.min(1, Math.max(0, radius - distance + 0.5));

function icon(size, scale) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  const centre = (size - 1) / 2;
  const unit = size * scale;
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x += 1) {
      const d = Math.hypot(x - centre, y - centre);
      const ring = edge(d, unit * 0.36) * (1 - edge(d, unit * 0.28));
      const dot = edge(d, unit * 0.13);
      const color = mix(mix(DARK, WHITE, ring), GREEN, dot);
      raw.set(color, row + 1 + x * 3);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const out = new URL("../public/icons/", import.meta.url);
mkdirSync(out, { recursive: true });
writeFileSync(new URL("icon-192.png", out), icon(192, 1));
writeFileSync(new URL("icon-512.png", out), icon(512, 1));
/* Maskable: launchers crop to a circle or a squircle, so the drawing is smaller. */
writeFileSync(new URL("icon-maskable-512.png", out), icon(512, 0.72));
writeFileSync(new URL("apple-touch-icon.png", out), icon(180, 0.9));
process.stdout.write("icons written to public/icons\n");
