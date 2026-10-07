/*
 * What another tool's export becomes here (PRODUCT.md §6.12). Pure functions: each takes the tool's
 * JSON and returns one item per object, either something we can create or a skip with the reason.
 * Nothing is dropped silently: an object we can't read is listed too.
 *
 * - UptimeRobot: the `getMonitors` API response.
 * - Uptime Kuma: its backup file (`monitorList`).
 * - Better Stack: the Uptime API's monitors list, and optionally its heartbeats list.
 * - Opsgenie: schedules (rotations) and escalations, as its REST API returns them.
 */
import type {
  CreateEscalationPolicyInput,
  CreateMonitorInput,
  CreateScheduleInput,
  ImportItemKind,
  ImportSource,
} from "@app/shared";
import { ValidationError } from "../../core/errors.js";

export type PlannedItem = {
  kind: ImportItemKind;
  name: string;
  becomes: string | null;
} & (
  | { action: "skip"; reason: string }
  | { action: "create"; monitor: CreateMonitorInput }
  | { action: "create"; schedule: CreateScheduleInput }
  /* Schedule targets are named; the service swaps the name for the new schedule's ID. */
  | { action: "create"; escalation: CreateEscalationPolicyInput; scheduleNames: string[] }
);

type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const rows = (value: unknown): Row[] => (Array.isArray(value) ? value.filter(isRow) : []);
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
const number = (value: unknown): number | undefined => {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const fail = (message: string) => new ValidationError(message, [{ path: "body.data", message }]);

const every = (seconds: number) =>
  seconds % 3_600 === 0
    ? `every ${seconds / 3_600} h`
    : seconds % 60 === 0
      ? `every ${seconds / 60} min`
      : `every ${seconds} s`;
const interval = (seconds: number | undefined) => clamp(Math.round(seconds ?? 300), 30, 86_400);
const httpUrl = (value: unknown): string | undefined => {
  const url = text(value);
  if (url === undefined) return undefined;
  const full = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  return URL.canParse(full) ? full : undefined;
};
/* A hostname from "host", "host:port" or a URL. */
const hostOf = (value: unknown): string | undefined => {
  const raw = text(value);
  if (raw === undefined) return undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw))
    return URL.canParse(raw) ? new URL(raw).hostname : undefined;
  return raw.replace(/:\d+$/, "");
};
const skip = (kind: ImportItemKind, name: string, reason: string): PlannedItem => ({
  kind,
  name,
  becomes: null,
  action: "skip",
  reason,
});

function monitor(
  name: string,
  seconds: number | undefined,
  config: CreateMonitorInput["config"],
  label: string,
  extra: Partial<CreateMonitorInput["settings"]> = {},
): PlannedItem {
  const intervalSeconds = interval(seconds);
  return {
    kind: "monitor",
    name,
    becomes: config.type === "heartbeat" ? label : `${label} ${every(intervalSeconds)}`,
    action: "create",
    monitor: { settings: { name: name.slice(0, 200), intervalSeconds, ...extra }, config },
  };
}

function heartbeat(name: string, periodSeconds: number | undefined, graceSeconds?: number) {
  const period = clamp(Math.round(periodSeconds ?? 3_600), 30, 31 * 86_400);
  return monitor(
    name,
    undefined,
    {
      type: "heartbeat",
      schedule: { kind: "period", periodSeconds: period },
      ...(graceSeconds === undefined
        ? {}
        : { graceSeconds: clamp(Math.round(graceSeconds), 0, 86_400) }),
    },
    `Heartbeat expected ${every(period)}`,
  );
}

/* UptimeRobot monitor types: 1 HTTP(s), 2 keyword, 3 ping, 4 port, 5 heartbeat. */
export function mapUptimeRobot(data: unknown): PlannedItem[] {
  const list = isRow(data) ? rows(data.monitors) : rows(data);
  if (list.length === 0)
    throw fail('This isn\'t a UptimeRobot getMonitors response: there is no "monitors" list.');
  return list.map((m) => {
    const name = text(m.friendly_name) ?? text(m.url) ?? `Monitor ${String(m.id ?? "")}`;
    const seconds = number(m.interval);
    const type = number(m.type);
    if (type === 1 || type === 2) {
      const url = httpUrl(m.url);
      if (url === undefined) return skip("monitor", name, "Its URL can't be read.");
      if (type === 1) return monitor(name, seconds, { type: "http", url }, "HTTP check");
      const keyword = text(m.keyword_value);
      if (keyword === undefined)
        return skip("monitor", name, "The keyword is missing from the export.");
      /* keyword_type 1 alerts when the keyword exists, 2 when it is missing. */
      return monitor(
        name,
        seconds,
        {
          type: "keyword",
          url,
          keyword: keyword.slice(0, 1_024),
          mode: number(m.keyword_type) === 1 ? "not_contains" : "contains",
        },
        "Keyword check",
      );
    }
    if (type === 3) {
      const host = hostOf(m.url);
      return host === undefined
        ? skip("monitor", name, "Its host can't be read.")
        : monitor(name, seconds, { type: "ping", host }, "Ping check");
    }
    if (type === 4) {
      const host = hostOf(m.url);
      const port = number(m.port);
      return host === undefined || port === undefined
        ? skip("monitor", name, "Its host or port is missing from the export.")
        : monitor(name, seconds, { type: "tcp", host, port }, `Port ${port} check`);
    }
    if (type === 5) return heartbeat(name, seconds);
    return skip(
      "monitor",
      name,
      `UptimeRobot monitor type ${String(m.type)} has no counterpart here.`,
    );
  });
}

const KUMA_LATER =
  "This check runs inside your network; it arrives with private probes (a later release).";

export function mapUptimeKuma(data: unknown): PlannedItem[] {
  const list = isRow(data) ? rows(data.monitorList) : [];
  if (list.length === 0)
    throw fail('This isn\'t an Uptime Kuma backup: there is no "monitorList".');
  return list.map((m) => {
    const name = text(m.name) ?? `Monitor ${String(m.id ?? "")}`;
    const seconds = number(m.interval);
    const type = text(m.type) ?? "";
    const upsideDown = m.upsideDown === true ? { upsideDown: true } : {};
    if (type === "http" || type === "keyword") {
      const url = httpUrl(m.url);
      if (url === undefined) return skip("monitor", name, "Its URL can't be read.");
      if (type === "http")
        return monitor(name, seconds, { type: "http", url }, "HTTP check", upsideDown);
      const keyword = text(m.keyword);
      if (keyword === undefined)
        return skip("monitor", name, "The keyword is missing from the backup.");
      return monitor(
        name,
        seconds,
        {
          type: "keyword",
          url,
          keyword: keyword.slice(0, 1_024),
          mode: m.invertKeyword === true ? "not_contains" : "contains",
        },
        "Keyword check",
        upsideDown,
      );
    }
    if (type === "ping") {
      const host = hostOf(m.hostname);
      return host === undefined
        ? skip("monitor", name, "Its hostname is missing from the backup.")
        : monitor(name, seconds, { type: "ping", host }, "Ping check", upsideDown);
    }
    if (type === "port") {
      const host = hostOf(m.hostname);
      const port = number(m.port);
      return host === undefined || port === undefined
        ? skip("monitor", name, "Its hostname or port is missing from the backup.")
        : monitor(name, seconds, { type: "tcp", host, port }, `Port ${port} check`, upsideDown);
    }
    if (type === "dns") {
      const hostname = hostOf(m.hostname);
      const recordType = (text(m.dns_resolve_type) ?? "A").toUpperCase();
      const known = ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SOA", "CAA"] as const;
      const record = known.find((k) => k === recordType);
      return hostname === undefined || record === undefined
        ? skip("monitor", name, `DNS record type ${recordType} isn't supported.`)
        : monitor(
            name,
            seconds,
            { type: "dns", hostname, recordType: record },
            `DNS ${record} check`,
          );
    }
    if (type === "push") return heartbeat(name, seconds);
    if (type === "group")
      return skip("monitor", name, "Groups aren't imported; add the monitors to a group here.");
    if (
      [
        "docker",
        "mqtt",
        "sqlserver",
        "postgres",
        "mysql",
        "mongodb",
        "redis",
        "radius",
        "steam",
        "gamedig",
        "grpc-keyword",
        "kafka-producer",
        "tailscale-ping",
      ].includes(type)
    ) {
      return skip("monitor", name, KUMA_LATER);
    }
    return skip(
      "monitor",
      name,
      `Uptime Kuma monitor type "${type || "unknown"}" has no counterpart here.`,
    );
  });
}

export function mapBetterStack(data: unknown): PlannedItem[] {
  const monitors = isRow(data)
    ? rows(isRow(data.monitors) ? data.monitors.data : data.data)
    : rows(data);
  const heartbeats = isRow(data) && isRow(data.heartbeats) ? rows(data.heartbeats.data) : [];
  if (monitors.length === 0 && heartbeats.length === 0) {
    throw fail('This isn\'t a Better Stack monitors list: there is no "data" list.');
  }
  const mapped = monitors.map((entry) => {
    const a = isRow(entry.attributes) ? entry.attributes : entry;
    const name = text(a.pronounceable_name) ?? text(a.url) ?? `Monitor ${String(entry.id ?? "")}`;
    const seconds = number(a.check_frequency);
    const type = text(a.monitor_type) ?? "";
    if (
      type === "status" ||
      type === "expected_status_code" ||
      type === "keyword" ||
      type === "keyword_absence"
    ) {
      const url = httpUrl(a.url);
      if (url === undefined) return skip("monitor", name, "Its URL can't be read.");
      if (type === "status" || type === "expected_status_code") {
        return monitor(name, seconds, { type: "http", url }, "HTTP check");
      }
      const keyword = text(a.required_keyword);
      if (keyword === undefined)
        return skip("monitor", name, "The keyword is missing from the export.");
      return monitor(
        name,
        seconds,
        {
          type: "keyword",
          url,
          keyword: keyword.slice(0, 1_024),
          mode: type === "keyword_absence" ? "not_contains" : "contains",
        },
        "Keyword check",
      );
    }
    if (type === "ping") {
      const host = hostOf(a.url);
      return host === undefined
        ? skip("monitor", name, "Its host can't be read.")
        : monitor(name, seconds, { type: "ping", host }, "Ping check");
    }
    if (type === "tcp") {
      const host = hostOf(a.url);
      const port = number(a.port);
      return host === undefined || port === undefined
        ? skip("monitor", name, "Its host or port is missing from the export.")
        : monitor(name, seconds, { type: "tcp", host, port }, `Port ${port} check`);
    }
    if (type === "dns") {
      const hostname = hostOf(a.url);
      return hostname === undefined
        ? skip("monitor", name, "Its hostname can't be read.")
        : monitor(name, seconds, { type: "dns", hostname, recordType: "A" }, "DNS A check");
    }
    if (type === "playwright")
      return skip("monitor", name, "Browser checks arrive in a later release.");
    return skip(
      "monitor",
      name,
      `Better Stack monitor type "${type || "unknown"}" has no counterpart here.`,
    );
  });
  const beats = heartbeats.map((entry) => {
    const a = isRow(entry.attributes) ? entry.attributes : entry;
    return heartbeat(
      text(a.name) ?? `Heartbeat ${String(entry.id ?? "")}`,
      number(a.period),
      number(a.grace),
    );
  });
  return [...mapped, ...beats];
}

/* Opsgenie people are named by email; `memberByEmail` finds the member here, if there is one. */
export function mapOpsgenie(
  data: unknown,
  memberByEmail: (email: string) => string | undefined,
): PlannedItem[] {
  const schedules = isRow(data) ? rows(data.schedules) : [];
  const escalations = isRow(data) ? rows(data.escalations) : [];
  if (schedules.length === 0 && escalations.length === 0) {
    throw fail('This isn\'t an Opsgenie export: there are no "schedules" or "escalations".');
  }
  const items: PlannedItem[] = [];
  for (const s of schedules) {
    const name = text(s.name) ?? `Schedule ${String(s.id ?? "")}`;
    const missing = new Set<string>();
    const layers: CreateScheduleInput["layers"] = [];
    for (const r of rows(s.rotations)) {
      const participants: string[] = [];
      for (const p of rows(r.participants)) {
        const email = (text(p.username) ?? "").toLowerCase();
        const userId = text(p.type) === "user" ? memberByEmail(email) : undefined;
        if (userId === undefined) missing.add(email || `a ${text(p.type) ?? "participant"}`);
        else participants.push(userId);
      }
      const startsAt = text(r.startDate);
      if (participants.length === 0 || startsAt === undefined || Number.isNaN(Date.parse(startsAt)))
        continue;
      const length = clamp(Math.round(number(r.length) ?? 1), 1, 672);
      const type = text(r.type) ?? "weekly";
      const exact = length === 1 && (type === "daily" || type === "weekly");
      layers.push({
        name: (text(r.name) ?? `Rotation ${layers.length + 1}`).slice(0, 60),
        rotation: exact ? type : "custom",
        ...(exact
          ? {}
          : {
              shiftHours: clamp(
                length * (type === "hourly" ? 1 : type === "daily" ? 24 : 168),
                1,
                672,
              ),
            }),
        startsAt: new Date(startsAt).toISOString(),
        participants,
        restrictions: [],
      });
    }
    if (layers.length === 0) {
      items.push(
        skip(
          "schedule",
          name,
          missing.size > 0
            ? `Nobody on it is a member here yet: invite ${[...missing].join(", ")} first.`
            : "It has no rotation with people and a start date.",
        ),
      );
      continue;
    }
    items.push({
      kind: "schedule",
      name,
      becomes:
        `${layers.length} rotation${layers.length === 1 ? "" : "s"}` +
        (missing.size > 0 ? `, without ${[...missing].join(", ")} (not a member here)` : ""),
      action: "create",
      schedule: {
        name: name.slice(0, 80),
        timezone: text(s.timezone) ?? "UTC",
        layers: layers.slice(0, 5),
      },
    });
  }
  const importedSchedules = new Set(
    items.filter((i) => i.kind === "schedule" && i.action === "create").map((i) => i.name),
  );
  for (const e of escalations) {
    const name = text(e.name) ?? `Escalation ${String(e.id ?? "")}`;
    const steps: CreateEscalationPolicyInput["steps"] = [];
    const scheduleNames: string[] = [];
    const dropped: string[] = [];
    let previous = 0;
    for (const rule of rows(e.rules)) {
      const recipient = isRow(rule.recipient) ? rule.recipient : {};
      const after = clamp(
        Math.round(number(isRow(rule.delay) ? rule.delay.timeAmount : 0) ?? 0),
        0,
        1_440,
      );
      const type = text(recipient.type);
      let target: CreateEscalationPolicyInput["steps"][number]["targets"][number] | undefined;
      if (type === "user") {
        const email = (text(recipient.username) ?? "").toLowerCase();
        const userId = memberByEmail(email);
        if (userId === undefined) dropped.push(email || "a user");
        else target = { type: "user", id: userId };
      } else if (type === "schedule") {
        const schedule = text(recipient.name) ?? "";
        if (importedSchedules.has(schedule)) {
          /* The placeholder ID is replaced with the new schedule's when it exists. */
          target = { type: "schedule", id: "00000000-0000-7000-8000-000000000000" };
          scheduleNames.push(schedule);
        } else dropped.push(`schedule ${schedule || "(unnamed)"}`);
      } else dropped.push(`a ${type ?? "recipient"}`);
      if (target === undefined) continue;
      /* Opsgenie counts each rule's delay from the start; ours counts from the step before. */
      steps.push({ delayMinutes: Math.max(0, after - previous), targets: [target] });
      if (target.type !== "schedule") scheduleNames.push("");
      previous = after;
    }
    if (steps.length === 0) {
      items.push(
        skip(
          "escalation",
          name,
          dropped.length > 0
            ? `None of its recipients exists here: ${dropped.join(", ")}.`
            : "It has no rules.",
        ),
      );
      continue;
    }
    const repeat = clamp(Math.round(number(isRow(e.repeat) ? e.repeat.count : 0) ?? 0), 0, 9);
    items.push({
      kind: "escalation",
      name,
      becomes:
        `${steps.length} step${steps.length === 1 ? "" : "s"}` +
        (dropped.length > 0 ? `, without ${dropped.join(", ")}` : ""),
      action: "create",
      escalation: { name: name.slice(0, 80), repeat, steps: steps.slice(0, 10) },
      scheduleNames,
    });
  }
  return items;
}

export function mapImport(
  source: ImportSource,
  data: unknown,
  memberByEmail: (email: string) => string | undefined,
): PlannedItem[] {
  switch (source) {
    case "uptimerobot":
      return mapUptimeRobot(data);
    case "uptime_kuma":
      return mapUptimeKuma(data);
    case "better_stack":
      return mapBetterStack(data);
    case "opsgenie":
      return mapOpsgenie(data, memberByEmail);
  }
}
