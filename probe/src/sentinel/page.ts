/*
 * Our own status page (PRODUCT.md §13): served by the sentinel, off the core server, so it is up
 * when we are not. One static HTML document from what the sentinel last saw: no scripts, no outside
 * files. It shows target names, never their URLs or internal error text.
 */
import type { SentinelState } from "./watch.js";

export interface PageEvent {
  at: number;
  text: string;
}

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const utc = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

export function renderStatusPage(input: {
  title: string;
  targets: readonly string[];
  state: SentinelState;
  events: readonly PageEvent[];
  checkedAt: number | null;
}): string {
  const down = input.targets.filter((name) => input.state[name]?.down === true);
  const banner =
    input.checkedAt === null
      ? "Checking…"
      : down.length === 0
        ? "All systems operational"
        : down.length === input.targets.length
          ? "Major outage"
          : "Partial outage";
  const rows = input.targets
    .map((name) => {
      const target = input.state[name];
      const status =
        target === undefined
          ? "Checking…"
          : target.down
            ? `Down${target.downSince === null ? "" : ` since ${utc(target.downSince)}`}`
            : "Operational";
      const mark = target?.down === true ? "✕" : target === undefined ? "…" : "✓";
      return `<li><span>${escapeHtml(name)}</span><span class="${target?.down === true ? "down" : "up"}">${mark} ${escapeHtml(status)}</span></li>`;
    })
    .join("");
  const events =
    input.events.length === 0
      ? "<p>No incidents recorded since this page started.</p>"
      : `<ol>${input.events
          .map((e) => `<li><time>${utc(e.at)}</time> ${escapeHtml(e.text)}</li>`)
          .join("")}</ol>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>${escapeHtml(input.title)}</title>
<style>
:root{color-scheme:light dark}
body{font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;line-height:1.5;color:#171717;background:#fff}
h1{font-size:1.5rem}h2{font-size:1.1rem;margin-top:2rem}
.banner{border:1px solid #d4d4d4;border-radius:.5rem;padding:1rem;font-size:1.1rem;font-weight:600}
ul,ol{list-style:none;padding:0}
ul li{display:flex;justify-content:space-between;gap:1rem;padding:.6rem 0;border-bottom:1px solid #e5e5e5}
ol li{padding:.3rem 0}time{color:#525252;margin-right:.5rem}
.up{color:#15803d}.down{color:#b91c1c}footer{margin-top:2rem;color:#525252;font-size:.9rem}
@media(prefers-color-scheme:dark){body{color:#f2f2f2;background:#141414}.banner{border-color:#333}ul li{border-color:#333}time,footer{color:#b5b5b5}.up{color:#86efac}.down{color:#fca5a5}}
</style>
</head>
<body>
<h1>${escapeHtml(input.title)}</h1>
<p class="banner">${banner}</p>
<h2>Services</h2>
<ul>${rows}</ul>
<h2>Recent events</h2>
${events}
<footer>${input.checkedAt === null ? "Not checked yet." : `Last checked ${utc(input.checkedAt)}.`} Checked from outside our own servers.</footer>
</body>
</html>
`;
}
