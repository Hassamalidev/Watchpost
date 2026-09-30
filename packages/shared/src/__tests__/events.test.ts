import { describe, expect, it } from "vitest";
import { EVENT_SCHEMAS, EVENT_TYPES, isEventType } from "../index.js";

const ID = "0190a3b2-7c1d-7e3f-8a9b-0c1d2e3f4a5b";

describe("event catalog", () => {
  it("names events domain.past_tense and versions every schema", () => {
    for (const type of EVENT_TYPES) {
      expect(type).toMatch(/^[a-z_]+\.[a-z_]+$/);
      expect(EVENT_SCHEMAS[type].version).toBeGreaterThanOrEqual(1);
    }
  });

  it("validates payloads", () => {
    const schema = EVENT_SCHEMAS["incident.triggered"].schema;
    expect(
      schema.safeParse({ incidentId: ID, number: 482, severity: "critical", title: "API down" })
        .success,
    ).toBe(true);
    expect(
      schema.safeParse({ incidentId: "nope", number: 0, severity: "x", title: 1 }).success,
    ).toBe(false);
  });

  it("recognizes event types", () => {
    expect(isEventType("incident.triggered")).toBe(true);
    expect(isEventType("incident.exploded")).toBe(false);
    expect(isEventType("toString")).toBe(false);
  });
});
