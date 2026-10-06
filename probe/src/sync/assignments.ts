/*
 * Assignment delta sync (PRODUCT.md §7.6): every 15 s, GET /assignments?after=<cursor>. A full snapshot
 * (first sync, or when the server says the cursor is too old) replaces everything the probe knows.
 */
import { assignmentsResponseSchema, type AssignedMonitor } from "@app/shared";
import type { ProbeClient } from "../transport/client.js";

export interface AssignmentSync {
  syncOnce(): Promise<{ upserts: number; deletes: number; full: boolean }>;
  cursor(): number;
  monitors(): AssignedMonitor[];
  get(monitorId: string): AssignedMonitor | undefined;
}

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
        { schema: assignmentsResponseSchema },
      );
      if (response.full) {
        const keep = new Set(response.upserts.map((m) => m.id));
        for (const id of [...known.keys()]) {
          if (!keep.has(id)) {
            known.delete(id);
            options.onRemove(id);
          }
        }
      }
      for (const monitor of response.upserts) {
        const existing = known.get(monitor.id);
        if (existing && existing.configSeq > monitor.configSeq) continue;
        known.set(monitor.id, monitor);
        options.onUpsert(monitor);
      }
      for (const id of response.deletes) {
        if (known.delete(id)) options.onRemove(id);
      }
      cursor = Math.max(cursor, response.cursor);
      synced = true;
      return {
        upserts: response.upserts.length,
        deletes: response.deletes.length,
        full: response.full,
      };
    },
    cursor: () => cursor,
    monitors: () => [...known.values()],
    get: (id) => known.get(id),
  };
}
