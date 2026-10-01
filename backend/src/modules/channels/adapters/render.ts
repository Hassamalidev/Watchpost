/* Plain-text rendering shared by adapters that have no richer format (email, SMS-length titles). */
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

export function alertTitle(event: AlertEvent): string {
  const { incident } = event;
  const ref = `#${incident.number} ${incident.title}`;
  switch (event.kind) {
    case "triggered":
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
  if (incident.monitorName) lines.push(`Monitor: ${incident.monitorName}`);
  lines.push(`Severity: ${SEVERITY[incident.severity]}`);
  if (incident.causeCode) lines.push(`Cause: ${incident.causeCode}`);
  if (incident.failingRegions.length > 0) {
    lines.push(`Failing regions: ${incident.failingRegions.join(", ")}`);
  }
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
