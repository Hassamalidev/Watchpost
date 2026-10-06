/*
 * Check scheduler (PRODUCT.md §7.6): each monitor runs on its own timer with a stable offset
 * hash(monitorId, region) mod interval, so load spreads evenly and a restart keeps the same rhythm.
 * A monitor whose previous run is still going is skipped for that slot. Entries are versioned by
 * configSeq, so updates and removals simply make old heap entries stale.
 */
import { createHash } from "node:crypto";
import type { AssignedMonitor } from "@app/shared";
import { MinHeap } from "./min-heap.js";

export function stableOffsetMs(monitorId: string, region: string, intervalMs: number): number {
  const digest = createHash("sha256").update(`${monitorId}:${region}`).digest();
  return digest.readUInt32BE(0) % intervalMs;
}

/* The first slot at or after `nowMs` for this interval and offset. */
export function nextSlotMs(nowMs: number, intervalMs: number, offsetMs: number): number {
  const base = Math.floor(nowMs / intervalMs) * intervalMs + offsetMs;
  return base >= nowMs ? base : base + intervalMs;
}

interface Entry {
  monitor: AssignedMonitor;
  version: number;
}

export interface Scheduler {
  upsert(monitor: AssignedMonitor): void;
  remove(monitorId: string): void;
  /* Returns monitors due at `nowMs` (and reschedules them); skips ones still running. */
  due(nowMs: number): AssignedMonitor[];
  markRunning(monitorId: string): void;
  markDone(monitorId: string): void;
  nextDueMs(): number | undefined;
  size(): number;
}

export function createScheduler(options: {
  region: string;
  now: () => number;
  /* Test hook: scales every interval (0.01 turns 15 s into 150 ms). */
  timeScale?: number;
}): Scheduler {
  const scale = options.timeScale ?? 1;
  const heap = new MinHeap<{ id: string; version: number }>();
  const entries = new Map<string, Entry>();
  const running = new Set<string>();
  let versionCounter = 0;

  const intervalMs = (m: AssignedMonitor) =>
    Math.max(1, Math.round(m.intervalSeconds * 1_000 * scale));

  function schedule(entry: Entry, fromMs: number): void {
    const interval = intervalMs(entry.monitor);
    const at = nextSlotMs(
      fromMs,
      interval,
      stableOffsetMs(entry.monitor.id, options.region, interval),
    );
    heap.push(at, { id: entry.monitor.id, version: entry.version });
  }

  return {
    upsert(monitor) {
      const existing = entries.get(monitor.id);
      if (existing && existing.monitor.configSeq > monitor.configSeq) return;
      const entry = { monitor, version: ++versionCounter };
      entries.set(monitor.id, entry);
      schedule(entry, options.now());
    },
    remove(monitorId) {
      entries.delete(monitorId);
    },
    due(nowMs) {
      const out: AssignedMonitor[] = [];
      while ((heap.peekKey() ?? Number.POSITIVE_INFINITY) <= nowMs) {
        const top = heap.pop();
        if (top === undefined) break;
        const entry = entries.get(top.value.id);
        if (entry === undefined || entry.version !== top.value.version) continue;
        schedule(entry, top.key + 1);
        if (running.has(entry.monitor.id)) continue;
        out.push(entry.monitor);
      }
      return out;
    },
    markRunning: (id) => void running.add(id),
    markDone: (id) => void running.delete(id),
    nextDueMs: () => heap.peekKey(),
    size: () => entries.size,
  };
}
