/*
 * What to change so the workspace matches the file. Pure: the file and the workspace's monitors in,
 * a list of actions out.
 *
 * A managed monitor carries two tags: `sync:key=<key>` says which entry of the file it is, and
 * `sync:rev=<hash>` says which version of that entry was applied last. An entry whose hash differs
 * from the tag is applied again. A change made by hand in the app doesn't change the tag, so it
 * stays until the entry changes in the file (or `--force` applies every entry again). Monitors
 * without a key tag are never touched.
 */
import { createHash } from "node:crypto";
import { TAG_PREFIX, keyTag, revTag, type FileSpec, type MonitorSpec } from "./spec.js";

/* A monitor as the API returns it; only what planning needs. */
export interface RemoteMonitor {
  id: string;
  name: string;
  tags: string[];
  paused: boolean;
}

export interface MonitorBody {
  settings: Record<string, unknown>;
  config: Record<string, unknown>;
}

export type Action =
  | { kind: "create"; key: string; name: string; body: MonitorBody; paused: boolean }
  | {
      kind: "update";
      key: string;
      name: string;
      id: string;
      body: MonitorBody;
      /* Undefined when the paused state is already right. */
      paused: boolean | undefined;
    }
  | { kind: "delete"; key: string; name: string; id: string }
  | { kind: "unchanged"; key: string; name: string; id: string };

/* The same text for the same content, whatever order the keys were written in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function revisionOf(monitor: MonitorSpec): string {
  return createHash("sha256").update(canonical(monitor)).digest("hex").slice(0, 16);
}

const tagValue = (tags: readonly string[], name: string) =>
  tags
    .find((tag) => tag.startsWith(`${TAG_PREFIX}${name}=`))
    ?.slice(TAG_PREFIX.length + name.length + 1);

function bodyOf(monitor: MonitorSpec): MonitorBody {
  return {
    settings: {
      ...monitor.settings,
      name: monitor.name,
      tags: [...(monitor.settings.tags ?? []), keyTag(monitor.key), revTag(revisionOf(monitor))],
    },
    config: monitor.config,
  };
}

export function planSync(
  file: FileSpec,
  remote: readonly RemoteMonitor[],
  options: { prune: boolean; force: boolean },
): Action[] {
  const managed = new Map<string, RemoteMonitor>();
  for (const monitor of remote) {
    const key = tagValue(monitor.tags, "key");
    /* Two monitors with one key (a copy made in the app): the first is ours, the other is left. */
    if (key !== undefined && !managed.has(key)) managed.set(key, monitor);
  }

  const actions: Action[] = [];
  for (const monitor of file.monitors) {
    const existing = managed.get(monitor.key);
    managed.delete(monitor.key);
    if (existing === undefined) {
      actions.push({
        kind: "create",
        key: monitor.key,
        name: monitor.name,
        body: bodyOf(monitor),
        paused: monitor.paused,
      });
      continue;
    }
    const current = tagValue(existing.tags, "rev") === revisionOf(monitor);
    const pausedRight = existing.paused === monitor.paused;
    if (current && pausedRight && !options.force) {
      actions.push({ kind: "unchanged", key: monitor.key, name: monitor.name, id: existing.id });
      continue;
    }
    actions.push({
      kind: "update",
      key: monitor.key,
      name: monitor.name,
      id: existing.id,
      body: bodyOf(monitor),
      paused: pausedRight ? undefined : monitor.paused,
    });
  }
  /* What is left carries a key that is no longer in the file. */
  if (options.prune) {
    for (const [key, monitor] of managed) {
      actions.push({ kind: "delete", key, name: monitor.name, id: monitor.id });
    }
  }
  return actions;
}

export function summarize(actions: readonly Action[]): Record<Action["kind"], number> {
  const counts = { create: 0, update: 0, delete: 0, unchanged: 0 };
  for (const action of actions) counts[action.kind] += 1;
  return counts;
}
