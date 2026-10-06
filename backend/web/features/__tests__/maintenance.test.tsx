/* Maintenance windows: the form's body, and how a stored repeat is named. */
import { describe, expect, it } from "vitest";
import {
  repeatOf,
  toWindowBody,
  type WindowForm,
} from "@/features/maintenance/components/maintenance-page";

const form = (patch: Partial<WindowForm> = {}): WindowForm => ({
  name: " Database upgrade ",
  start: "2026-11-03T22:00",
  end: "2026-11-04T00:00",
  timezone: "Europe/Berlin",
  repeat: "weekly",
  allMonitors: true,
  monitorIds: [],
  ...patch,
});

describe("maintenance window form", () => {
  it("builds the API body: trimmed name, ISO times, rule and scope", () => {
    const built = toWindowBody(form());
    if (!("body" in built)) throw new Error("expected a body");
    expect(built.body).toMatchObject({
      name: "Database upgrade",
      timezone: "Europe/Berlin",
      rrule: "FREQ=WEEKLY",
      scope: { all: true },
      suppressAlerts: true,
    });
    expect(Date.parse(built.body.endsAt) - Date.parse(built.body.startsAt)).toBe(2 * 3_600_000);

    const some = toWindowBody(form({ repeat: "none", allMonitors: false, monitorIds: ["m1"] }));
    expect("body" in some && some.body).toMatchObject({
      rrule: null,
      scope: { monitorIds: ["m1"] },
    });
  });

  it("names the field that stops it", () => {
    expect(toWindowBody(form({ name: "  " }))).toEqual({ field: "name" });
    expect(toWindowBody(form({ start: "" }))).toEqual({ field: "start" });
    expect(toWindowBody(form({ end: "2026-11-03T21:00" }))).toEqual({ field: "end" });
    expect(toWindowBody(form({ allMonitors: false }))).toEqual({ field: "monitors" });
  });

  it("names a stored repeat, and shows richer rules as they are", () => {
    expect(repeatOf(null)).toBe("none");
    expect(repeatOf("FREQ=DAILY")).toBe("daily");
    expect(repeatOf("FREQ=WEEKLY;INTERVAL=2;BYDAY=SA,SU")).toBe("custom");
  });
});
