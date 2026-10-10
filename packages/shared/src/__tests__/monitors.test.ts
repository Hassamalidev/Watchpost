import { describe, expect, it } from "vitest";
import {
  MONITOR_TYPES,
  createMonitorSchema,
  effectiveRecoverySuccesses,
  isAcceptedStatus,
  monitorConfigSchema,
  monitorSettingsSchema,
} from "../index.js";

const ID = "0190a3b2-7c1d-7e3f-8a9b-0c1d2e3f4a5b";

describe("monitor configs", () => {
  it("applies HTTP defaults", () => {
    const config = monitorConfigSchema.parse({ type: "http", url: "https://example.com/health" });
    expect(config).toMatchObject({
      type: "http",
      method: "GET",
      headers: [],
      auth: { kind: "none" },
      acceptedStatusCodes: ["200-299"],
      followRedirects: true,
      ignoreTlsErrors: false,
    });
  });

  it("parses one valid config of every Phase 1 type", () => {
    const samples = [
      { type: "http", url: "http://example.com" },
      { type: "keyword", url: "https://example.com", keyword: "Welcome" },
      {
        type: "json_query",
        url: "https://example.com/api",
        expression: "status",
        operator: "==",
        expected: "ok",
      },
      { type: "tcp", host: "db.example.com", port: 5432 },
      { type: "ping", host: "203.0.113.10" },
      { type: "dns", hostname: "example.com", recordType: "MX" },
      { type: "websocket", url: "wss://example.com/socket" },
      { type: "ssl", host: "example.com" },
      { type: "domain", domain: "example.com" },
      {
        type: "heartbeat",
        schedule: { kind: "cron", expression: "*/5 * * * *", timezone: "Asia/Karachi" },
      },
      {
        type: "multistep",
        secrets: [{ name: "password", value: "s3cret" }],
        steps: [
          {
            name: "Sign in",
            url: "https://example.com/login",
            method: "POST",
            body: '{"password":"{{password}}"}',
            extract: [{ name: "token", expression: "token" }],
          },
          {
            name: "Profile",
            url: "https://example.com/me",
            headers: [{ name: "Authorization", value: "Bearer {{token}}" }],
            assertions: [{ expression: "status", operator: "==", expected: "active" }],
          },
        ],
      },
      { type: "redis", host: "10.0.0.20", password: "s3cret" },
      { type: "mqtt", host: "broker.internal", username: "sensor", password: "s3cret" },
      { type: "grpc", host: "api.internal", port: 50_051, tls: false, service: "shop.Checkout" },
    ];
    expect(samples.map((s) => s.type).sort()).toEqual([...MONITOR_TYPES].sort());
    for (const sample of samples) {
      const result = monitorConfigSchema.safeParse(sample);
      expect(result.success, `${sample.type}: ${result.error?.message}`).toBe(true);
    }
  });

  it("rejects bad input with useful paths", () => {
    const cases: Array<[unknown, string]> = [
      [{ type: "http", url: "ftp://example.com" }, "url"],
      [
        { type: "http", url: "https://x.com", acceptedStatusCodes: ["299-200"] },
        "acceptedStatusCodes",
      ],
      [
        { type: "http", url: "https://x.com", headers: [{ name: "bad header", value: "x" }] },
        "headers",
      ],
      [{ type: "tcp", host: "example.com", port: 70_000 }, "port"],
      [{ type: "tcp", host: "not a host!", port: 80 }, "host"],
      [{ type: "websocket", url: "https://example.com" }, "url"],
      [{ type: "heartbeat", schedule: { kind: "cron", expression: "every minute" } }, "schedule"],
      [{ type: "dns", hostname: "example.com", recordType: "PTR" }, "recordType"],
      [{ type: "smtp", host: "x" }, "type"],
      [{ type: "grpc", host: "x", port: 0 }, "port"],
      [{ type: "mqtt", host: "x", clientId: "has space" }, "clientId"],
    ];
    for (const [input, path] of cases) {
      const result = monitorConfigSchema.safeParse(input);
      expect(result.success, JSON.stringify(input)).toBe(false);
      expect(result.error?.issues[0]?.path.join(".")).toContain(path);
    }
  });
});

describe("monitor settings", () => {
  it("applies defaults (5-minute interval, two regions, confirmation from 2 regions)", () => {
    expect(monitorSettingsSchema.parse({ name: "API" })).toMatchObject({
      intervalSeconds: 300,
      timeoutMs: 10_000,
      regions: ["eu-central", "us-east"],
      minFailingRegions: 2,
      severity: "high",
      upsideDown: false,
    });
  });

  it("requires the timeout to be shorter than the interval and regions to be unique", () => {
    expect(
      monitorSettingsSchema.safeParse({ name: "x", intervalSeconds: 15, timeoutMs: 20_000 })
        .success,
    ).toBe(false);
    expect(
      monitorSettingsSchema.safeParse({ name: "x", regions: ["us-east", "us-east"] }).success,
    ).toBe(false);
    expect(monitorSettingsSchema.safeParse({ name: "x", regions: ["mars-1"] }).success).toBe(false);
  });

  it("combines settings and config in createMonitorSchema", () => {
    const parsed = createMonitorSchema.parse({
      settings: { name: "Homepage", groupId: ID },
      config: { type: "http", url: "https://example.com" },
    });
    expect(parsed.settings.groupId).toBe(ID);
    expect(parsed.config.type).toBe("http");
  });
});

describe("helpers", () => {
  it("chooses recovery successes by interval when unset (§6.2)", () => {
    expect(effectiveRecoverySuccesses({ recoverySuccesses: 0, intervalSeconds: 30 })).toBe(2);
    expect(effectiveRecoverySuccesses({ recoverySuccesses: 0, intervalSeconds: 60 })).toBe(2);
    expect(effectiveRecoverySuccesses({ recoverySuccesses: 0, intervalSeconds: 300 })).toBe(1);
    expect(effectiveRecoverySuccesses({ recoverySuccesses: 4, intervalSeconds: 300 })).toBe(4);
  });

  it("matches status codes against single codes and ranges", () => {
    expect(isAcceptedStatus(204, ["200-299"])).toBe(true);
    expect(isAcceptedStatus(301, ["200-299"])).toBe(false);
    expect(isAcceptedStatus(301, ["200-299", "301"])).toBe(true);
    expect(isAcceptedStatus(404, [])).toBe(false);
  });
});
