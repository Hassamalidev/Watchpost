/*
 * The monitoring file ("monitoring as code", PRODUCT.md §6.13): the monitors a workspace should
 * have, written in YAML or JSON and kept in a repository. Each monitor has a `key` that never
 * changes; it is how a monitor in the file is matched to one in the workspace, so a monitor can be
 * renamed in the file without being deleted and made again.
 *
 * The file is checked by hand here, not with a schema library: this tool is shipped as one bundled
 * file, and the API checks `config` and `settings` in full anyway.
 */
import { parse as parseYaml } from "yaml";

/* Tags the tool puts on the monitors it manages. People's own tags can't start with this. */
export const TAG_PREFIX = "sync:";
export const keyTag = (key: string) => `${TAG_PREFIX}key=${key}`;
export const revTag = (rev: string) => `${TAG_PREFIX}rev=${rev}`;

const MAX_MONITORS = 1_000;
/* The API allows 20 tags; two are ours. */
const MAX_TAGS = 18;
const KEY = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export interface MonitorSpec {
  key: string;
  name: string;
  /* What to check: `type` and the fields that type needs, as in the API. */
  config: Record<string, unknown> & { type: string };
  /* Interval, regions, tags and alerting options, as in the API; all optional. */
  settings: Record<string, unknown> & { tags?: string[] };
  paused: boolean;
}

export interface FileSpec {
  version: 1;
  monitors: MonitorSpec[];
}

export class SpecError extends Error {
  constructor(readonly problems: string[]) {
    super(`The monitoring file is invalid:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "SpecError";
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function readMonitor(raw: unknown, at: string, problems: string[]): MonitorSpec | undefined {
  if (!isObject(raw)) {
    problems.push(`${at}: must be a monitor with key, name and config`);
    return undefined;
  }
  const before = problems.length;
  for (const field of Object.keys(raw)) {
    if (!["key", "name", "config", "settings", "paused"].includes(field)) {
      problems.push(`${at}.${field}: is not a field of a monitor`);
    }
  }
  const { key, name, config, paused } = raw;
  const settings = raw.settings ?? {};
  if (typeof key !== "string" || !KEY.test(key)) {
    problems.push(`${at}.key: lower-case letters, digits, - and _, up to 40`);
  }
  if (typeof name !== "string" || name.trim() === "" || name.length > 200) {
    problems.push(`${at}.name: 1 to 200 characters`);
  }
  if (!isObject(config) || typeof config.type !== "string" || config.type === "") {
    problems.push(`${at}.config: needs a type`);
  }
  if (!isObject(settings)) {
    problems.push(`${at}.settings: must be a list of settings`);
  } else {
    if ("name" in settings) {
      problems.push(`${at}.settings: put the name next to the key, not in settings`);
    }
    const tags = settings.tags;
    if (tags !== undefined) {
      if (
        !Array.isArray(tags) ||
        tags.some((tag) => typeof tag !== "string" || tag.trim() === "")
      ) {
        problems.push(`${at}.settings.tags: must be a list of words`);
      } else if (tags.length > MAX_TAGS) {
        problems.push(`${at}.settings.tags: at most ${MAX_TAGS}`);
      } else if (tags.some((tag: string) => tag.startsWith(TAG_PREFIX))) {
        problems.push(`${at}.settings.tags: tags can't start with "${TAG_PREFIX}"`);
      }
    }
  }
  if (paused !== undefined && typeof paused !== "boolean") {
    problems.push(`${at}.paused: true or false`);
  }
  if (problems.length > before) return undefined;
  return {
    key: key as string,
    name: (name as string).trim(),
    config: config as MonitorSpec["config"],
    settings: settings as MonitorSpec["settings"],
    paused: paused === true,
  };
}

/* YAML is a superset of JSON, so one parser reads both. */
export function parseSpec(text: string): FileSpec {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new SpecError([err instanceof Error ? err.message : String(err)]);
  }
  const problems: string[] = [];
  if (!isObject(raw)) throw new SpecError(["file: must have version and monitors"]);
  if (raw.version !== 1) problems.push("version: must be 1");
  for (const field of Object.keys(raw)) {
    if (field !== "version" && field !== "monitors")
      problems.push(`${field}: is not a field of the file`);
  }
  const monitors: MonitorSpec[] = [];
  if (!Array.isArray(raw.monitors)) {
    problems.push("monitors: must be a list");
  } else if (raw.monitors.length > MAX_MONITORS) {
    problems.push(`monitors: at most ${MAX_MONITORS}`);
  } else {
    const seen = new Set<string>();
    raw.monitors.forEach((entry: unknown, index: number) => {
      const monitor = readMonitor(entry, `monitors.${index}`, problems);
      if (monitor === undefined) return;
      if (seen.has(monitor.key))
        problems.push(`monitors.${index}.key: "${monitor.key}" is used twice`);
      seen.add(monitor.key);
      monitors.push(monitor);
    });
  }
  if (problems.length > 0) throw new SpecError(problems);
  return { version: 1, monitors };
}
