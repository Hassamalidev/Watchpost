/*
 * Runs a user-supplied regular expression in a worker thread with a time limit, so a pattern with
 * catastrophic backtracking can't freeze the probe's event loop (keyword and JSON "matches" checks).
 */
import { Worker } from "node:worker_threads";

const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
try {
  const re = new RegExp(workerData.pattern, workerData.flags);
  parentPort.postMessage({ matched: re.test(workerData.text) });
} catch (err) {
  parentPort.postMessage({ error: String(err && err.message || err) });
}`;

export class RegexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegexError";
  }
}

export async function safeRegexTest(
  pattern: string,
  text: string,
  options: { caseSensitive?: boolean; timeoutMs?: number } = {},
): Promise<boolean> {
  const flags = options.caseSensitive ? "" : "i";
  try {
    new RegExp(pattern, flags);
  } catch (err) {
    throw new RegexError(`invalid regular expression: ${(err as Error).message}`);
  }
  const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { pattern, flags, text } });
  const timeoutMs = options.timeoutMs ?? 1_000;
  try {
    return await new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new RegexError(`regular expression took longer than ${timeoutMs} ms`));
      }, timeoutMs);
      worker.once("message", (msg: { matched?: boolean; error?: string }) => {
        clearTimeout(timer);
        if (msg.error !== undefined) reject(new RegexError(msg.error));
        else resolve(Boolean(msg.matched));
      });
      worker.once("error", (err) => {
        clearTimeout(timer);
        reject(new RegexError(err.message));
      });
    });
  } finally {
    await worker.terminate();
  }
}
