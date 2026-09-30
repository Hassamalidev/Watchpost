/*
 * Result buffer (PRODUCT.md §7.6): holds unsent results while the API is unreachable, drops those
 * older than the max age, and (private probes) mirrors itself to a JSON Lines file so a restart
 * loses nothing. Results carry their own IDs, so re-sending after a crash is harmless.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { CheckResult } from "@app/shared";

export interface BufferedResult {
  result: CheckResult;
  queuedAt: number;
}

export interface ResultBuffer {
  push(result: CheckResult): void;
  /* Up to `max` oldest results, without removing them. */
  peek(max: number): BufferedResult[];
  /* Removes delivered results by ID. */
  ack(ids: ReadonlySet<string>): void;
  /* Drops results older than maxAgeMs; returns how many were dropped. */
  expire(nowMs: number): number;
  size(): number;
}

export function createResultBuffer(options: {
  maxAgeMs: number;
  now?: () => number;
  /* Directory for the on-disk mirror (private probes). */
  dir?: string | undefined;
}): ResultBuffer {
  const now = options.now ?? Date.now;
  let items: BufferedResult[] = [];
  const file = options.dir ? path.join(options.dir, "results-buffer.jsonl") : undefined;

  if (file !== undefined) {
    mkdirSync(path.dirname(file), { recursive: true });
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (line.trim() === "") continue;
        try {
          items.push(JSON.parse(line) as BufferedResult);
        } catch {
          /* A torn last line after a crash is skipped. */
        }
      }
    }
  }

  const rewrite = () => {
    if (file === undefined) return;
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, items.map((i) => JSON.stringify(i)).join("\n") + (items.length ? "\n" : ""));
    renameSync(tmp, file);
  };

  return {
    push(result) {
      const item = { result, queuedAt: now() };
      items.push(item);
      if (file !== undefined) appendFileSync(file, `${JSON.stringify(item)}\n`);
    },
    peek(max) {
      return items.slice(0, max);
    },
    ack(ids) {
      if (ids.size === 0) return;
      items = items.filter((i) => !ids.has(i.result.id));
      rewrite();
    },
    expire(nowMs) {
      const before = items.length;
      items = items.filter((i) => nowMs - i.queuedAt <= options.maxAgeMs);
      const dropped = before - items.length;
      if (dropped > 0) rewrite();
      return dropped;
    },
    size: () => items.length,
  };
}
