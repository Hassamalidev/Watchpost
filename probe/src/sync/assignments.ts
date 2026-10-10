/*
 * Assignment delta sync (PRODUCT.md §7.6): every 15 s, GET /assignments?after=<cursor>. A full snapshot
 * (first sync, or when the server says the cursor is too old) replaces everything the probe knows.
 *
 * Each monitor is read on its own. One this probe can't make sense of (a config saved under rules
 * that have since changed, or a type newer than this probe) is left out and reported; it must never
 * cost the probe every other monitor, which is what failing the whole answer would do.
 */
import { z } from "zod";
import { assignedMonitorSchema, type AssignedMonitor } from "@app/shared";
import type { ProbeClient } from "../transport/client.js";

export interface AssignmentSync {
  syncOnce(): Promise<{ upserts: number; deletes: number; full: boolean; skipped: string[] }>;
  cursor(): number;
  monitors(): AssignedMonitor[];
  get(monitorId: string): AssignedMonitor | undefined;
}

/* The answer's frame; the monitors inside are checked one by one. */
const envelopeSchema = z.object({
  cursor: z.number().int().min(0),
  full: z.boolean(),
  upserts: z.array(z.unknown()),
  deletes: z.array(z.uuid()),
});

const idOf = (value: unknown): string => {
  const id = (value as { id?: unknown } | null)?.id;
  return typeof id === "string" ? id : "(no id)";
};

export function createAssignmentSync(options: {
  client: ProbeClient;
  onUpsert: (monitor: AssignedMonitor) => void;
  onRemove: (monitorId: string) => void;
}): AssignmentSync {
  const known = new Map<string, AssignedMonitor>();
  let cursor = 0;
  let synced = false;

  return {
    async syncOnce() {
      const full = !synced;
      const response = await options.client.request(
        "GET",
        `/assignments?after=${cursor}${full ? "&full=true" : ""}`,
        { schema: envelopeSchema },
      );
      const upserts: AssignedMonitor[] = [];
      const skipped: string[] = [];
      for (const item of response.upserts) {
        const parsed = assignedMonitorSchema.safeParse(item);
        if (parsed.success) upserts.push(parsed.data);
        else skipped.push(idOf(item));
      }
      if (response.full) {
        const keep = new Set(upserts.map((m) => m.id));
        for (const id of [...known.keys()]) {
          if (!keep.has(id)) {
            known.delete(id);
            options.onRemove(id);
          }
        }
      }
      for (const monitor of upserts) {
        const existing = known.get(monitor.id);
        if (existing && existing.configSeq > monitor.configSeq) continue;
        known.set(monitor.id, monitor);
        options.onUpsert(monitor);
      }
      /* A monitor we ran and whose new config we can't read: the old config is no longer right. */
      for (const id of skipped) {
        if (known.delete(id)) options.onRemove(id);
      }
      for (const id of response.deletes) {
        if (known.delete(id)) options.onRemove(id);
      }
      cursor = Math.max(cursor, response.cursor);
      synced = true;
      return {
        upserts: upserts.length,
        deletes: response.deletes.length,
        full: response.full,
        skipped,
      };
    },
    cursor: () => cursor,
    monitors: () => [...known.values()],
    get: (id) => known.get(id),
  };
}
