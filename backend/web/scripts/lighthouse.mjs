/*
 * Lighthouse accessibility gate (P0-T06 AC: score >= 95 in light and dark).
 * Needs a running production server: `pnpm build && pnpm start`, then `pnpm lighthouse`.
 * Dark mode uses Chrome's --force-dark-mode, which sets prefers-color-scheme: dark.
 */
import lighthouse from "lighthouse";
import * as chromeLauncher from "chrome-launcher";

const BASE_URL = process.env.LIGHTHOUSE_BASE_URL ?? "http://127.0.0.1:3000";
const MIN_SCORE = 0.95;
const PATHS = ["/", "/w/demo/overview"];
const MODES = [
  { name: "light", flags: [] },
  { name: "dark", flags: ["--force-dark-mode"] },
];

let failed = false;

for (const mode of MODES) {
  const chrome = await chromeLauncher.launch({
    chromeFlags: ["--headless=new", "--no-sandbox", ...mode.flags],
  });
  try {
    for (const path of PATHS) {
      const result = await lighthouse(`${BASE_URL}${path}`, {
        port: chrome.port,
        onlyCategories: ["accessibility"],
        output: "json",
        logLevel: "error",
      });
      const score = result?.lhr.categories.accessibility.score ?? 0;
      const ok = score >= MIN_SCORE;
      failed ||= !ok;
      process.stdout.write(
        `${ok ? "PASS" : "FAIL"} ${mode.name.padEnd(5)} ${path} accessibility ${Math.round(score * 100)}\n`,
      );
      if (!ok) {
        const audits = Object.values(result?.lhr.audits ?? {}).filter(
          (a) => a.score !== null && a.score < 1 && a.scoreDisplayMode === "binary",
        );
        for (const audit of audits) process.stdout.write(`  - ${audit.id}: ${audit.title}\n`);
      }
    }
  } finally {
    await chrome.kill();
  }
}

process.exit(failed ? 1 : 0);
