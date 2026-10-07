/*
 * Rendering shared by adapters: the one-line title, the plain-text body, and the building blocks of
 * richer formats (facts, the failure explanation, Markdown, Slack-style attachments).
 */
import type { AlertEvent, RenderedMessage } from "../types/adapter.js";

const SEVERITY = { critical: "Critical", high: "High", low: "Low" } as const;

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
  const days = Math.floor(hours / 24);
  return `${days} d ${hours % 24} h`;
}

/*
 * What an alert is about, in a few words: the monitor, or "4 monitors in Production" when a group's
 * failures go out as one message (§9.6).
 */
export function alertSubject(event: AlertEvent): string {
  if (event.group && event.kind === "triggered") {
    return `${event.group.others.length + 1} monitors in ${event.group.name}`;
  }
  return event.incident.monitorName ?? event.incident.title;
}

export function alertTitle(event: AlertEvent): string {
  const { incident } = event;
  const ref = `#${incident.number} ${incident.title}`;
  switch (event.kind) {
    case "triggered":
      if (event.group) {
        const count = event.group.others.length + 1;
        return `[${SEVERITY[incident.severity]}] ${count} monitors in ${event.group.name} are down`;
      }
      return `[${SEVERITY[incident.severity]}] ${ref}`;
    case "acknowledged":
      return `Acknowledged${event.actor ? ` by ${event.actor}` : ""}: ${ref}`;
    case "resolved":
      return `Resolved after ${formatDuration(incident.durationSeconds)}: ${ref}`;
    case "reminder":
      return `Still open (${formatDuration(incident.durationSeconds)}): ${ref}`;
    case "flapping":
      return `Flapping: ${ref}`;
    case "test":
      return `Test alert from Watchpost`;
  }
}

export function renderPlain(event: AlertEvent): RenderedMessage {
  const { incident } = event;
  if (event.kind === "test") {
    return {
      title: alertTitle(event),
      text: `This is a test alert for ${event.workspace.name}. If you can read it, this channel works.`,
    };
  }
  const lines = [alertTitle(event), ""];
  if (event.group) {
    lines.push(`#${incident.number} ${incident.title}`);
    for (const other of event.group.others) lines.push(`#${other.number} ${other.title}`);
    lines.push("", "The first of them:");
  }
  if (incident.monitorName) lines.push(`Monitor: ${incident.monitorName}`);
  lines.push(`Severity: ${SEVERITY[incident.severity]}`);
  if (incident.causeCode) lines.push(`Cause: ${incident.causeCode}`);
  if (incident.failingRegions.length > 0) {
    lines.push(`Failing regions: ${incident.failingRegions.join(", ")}`);
  }
  if (incident.timing) lines.push(`Timing: ${incident.timing}`);
  lines.push(`Started: ${incident.startedAt}`);
  if (event.explanation) {
    lines.push("", `Likely cause: ${event.explanation.headline}`);
    const first = event.explanation.nextSteps[0];
    if (first) lines.push(`Check first: ${first}`);
  }
  if (event.kind === "flapping") {
    lines.push(
      "",
      "It keeps changing state. Notifications pause until it is stable for 15 minutes.",
    );
  }
  lines.push("", incident.url);
  return { title: alertTitle(event), text: lines.join("\n") };
}

/* Helpers for the richer formats (cards, attachments, Markdown, HTML) built by the adapters. */

export const SEVERITY_LABEL = SEVERITY;

export const STATE_LABEL = {
  triggered: "DOWN",
  reminder: "STILL DOWN",
  flapping: "FLAPPING",
  acknowledged: "ACKNOWLEDGED",
  resolved: "RESOLVED",
  test: "TEST",
} as const;

export const STATE_EMOJI = {
  triggered: "🔴",
  reminder: "🔴",
  flapping: "🟠",
  acknowledged: "🟡",
  resolved: "✅",
  test: "🧪",
} as const;

export const STATE_HEX = {
  triggered: "#e5484d",
  reminder: "#e5484d",
  flapping: "#f5a524",
  acknowledged: "#f5a524",
  resolved: "#30a46c",
  test: "#3e63dd",
} as const;

/* The incident's facts as label/value pairs, in the order every channel shows them. */
export function alertFacts(event: AlertEvent): Array<{ label: string; value: string }> {
  const { incident } = event;
  if (event.kind === "test") return [];
  return [
    ...(event.group
      ? [
          {
            label: "Down",
            value: [
              `#${incident.number} ${incident.monitorName ?? incident.title}`,
              ...event.group.others.map((o) => `#${o.number} ${o.monitorName ?? o.title}`),
            ].join(", "),
          },
        ]
      : incident.monitorName
        ? [{ label: "Monitor", value: incident.monitorName }]
        : []),
    { label: "Severity", value: SEVERITY[incident.severity] },
    ...(incident.causeCode ? [{ label: "Cause", value: incident.causeCode }] : []),
    ...(incident.failingRegions.length > 0
      ? [{ label: "Failing regions", value: incident.failingRegions.join(", ") }]
      : []),
    ...(incident.timing ? [{ label: "Timing", value: incident.timing }] : []),
    { label: "Started", value: incident.startedAt },
    ...(event.actor ? [{ label: "By", value: event.actor }] : []),
  ];
}

/*
 * A short plain body for notifications that show the title on their own and open the incident when
 * tapped (push services): where it fails and why, without the title or the link.
 */
export function plainDetails(event: AlertEvent, message: RenderedMessage): string {
  if (event.kind === "test") return message.text;
  const { incident } = event;
  const lines = [
    ...(incident.failingRegions.length > 0
      ? [`Failing regions: ${incident.failingRegions.join(", ")}`]
      : []),
    ...(incident.causeCode ? [`Cause: ${incident.causeCode}`] : []),
    ...(incident.timing ? [`Timing: ${incident.timing}`] : []),
    ...explanationLines(event),
  ];
  return lines.length > 0 ? lines.join("\n") : `#${incident.number} ${incident.title}`;
}

/* The failure explainer's two lines, when the event has an explanation. */
export function explanationLines(event: AlertEvent): string[] {
  if (!event.explanation) return [];
  const first = event.explanation.nextSteps[0];
  return [
    `Likely cause: ${event.explanation.headline}`,
    ...(first ? [`Check first: ${first}`] : []),
  ];
}

/* Cuts text to `max` characters, ending with an ellipsis when something was cut. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/* Cuts text to `maxBytes` of UTF-8 without splitting a character. */
export function truncateBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let out = "";
  let size = 0;
  for (const char of text) {
    const bytes = Buffer.byteLength(char);
    if (size + bytes > maxBytes - 3) break;
    out += char;
    size += bytes;
  }
  return `${out}…`;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/*
 * A Markdown body for tools that render it (Zulip, Gotify, Mattermost): facts as a list, the likely
 * cause, and a link to the incident. `title` is left to the caller, which often has a title field.
 */
export function renderMarkdownBody(event: AlertEvent, message: RenderedMessage): string {
  if (event.kind === "test") return message.text;
  const lines = alertFacts(event).map((f) => `- **${f.label}:** ${f.value}`);
  const why = explanationLines(event);
  if (why.length > 0) lines.push("", ...why.map((l) => l.replace(/^([^:]+):/, "**$1:**")));
  if (event.kind === "flapping") {
    lines.push(
      "",
      "It keeps changing state. Notifications pause until it is stable for 15 minutes.",
    );
  }
  lines.push("", `[Open incident](${event.incident.url})`);
  return lines.join("\n");
}

/*
 * Slack-style attachments, the format Mattermost and Rocket.Chat incoming webhooks both accept: a
 * colored bar, a title linking to the incident and the facts as short fields.
 */
export function slackStyleAttachment(event: AlertEvent, message: RenderedMessage) {
  const heading = `${STATE_EMOJI[event.kind]} ${STATE_LABEL[event.kind]}`;
  if (event.kind === "test") {
    return { fallback: message.title, color: STATE_HEX.test, title: heading, text: message.text };
  }
  return {
    fallback: message.title,
    color: STATE_HEX[event.kind],
    title: `${heading} · ${message.title}`,
    title_link: event.incident.url,
    text: explanationLines(event).join("\n"),
    fields: alertFacts(event).map((f) => ({ title: f.label, value: f.value, short: true })),
  };
}
