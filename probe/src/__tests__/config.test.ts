import { describe, expect, it } from "vitest";
import { ProbeConfigError, loadProbeConfig } from "../config.js";

const valid = {
  API_URL: "https://app.example.com/",
  PROBE_ID: "0190a3b2-7c1d-7e3f-8a9b-0c1d2e3f4a5b",
  PROBE_SECRET: "x".repeat(40),
  PROBE_REGION: "eu-central",
};

describe("probe config", () => {
  it("applies defaults and trims the API URL", () => {
    expect(loadProbeConfig(valid)).toMatchObject({
      apiUrl: "https://app.example.com",
      mode: "managed",
      concurrency: 200,
      bufferMaxAgeMs: 600_000,
      bufferDir: undefined,
    });
  });

  it("always denies the API's own host and parses allow lists", () => {
    const config = loadProbeConfig({
      ...valid,
      PROBE_DENY_HOSTS: "db.internal, admin.example.com",
      PROBE_ALLOW_CIDRS: "172.18.0.0/16",
    });
    expect(config.denyHosts).toEqual(["db.internal", "admin.example.com", "app.example.com"]);
    expect(config.allowCidrs).toEqual(["172.18.0.0/16"]);
  });

  it("a private probe needs only the address and its token", () => {
    const id = "0199c1a0-4a11-7d52-8c0e-7b9f3e2a1d05";
    const config = loadProbeConfig({
      API_URL: "https://app.example.com/",
      PROBE_TOKEN: `wpp_${id}.${"s".repeat(43)}`,
    });
    expect(config).toMatchObject({
      apiUrl: "https://app.example.com",
      probeId: id,
      secret: "s".repeat(43),
      mode: "private",
      /* Its own location, named after it. */
      region: `private:${id}`,
      bufferDir: "/var/lib/watchpost-probe",
    });
    expect(() =>
      loadProbeConfig({ API_URL: "https://app.example.com", PROBE_TOKEN: "not-a-token" }),
    ).toThrow(/PROBE_TOKEN: is not a probe token/);
    expect(() => loadProbeConfig({ API_URL: "https://app.example.com" })).toThrow(
      /PROBE_ID: is required \(or set PROBE_TOKEN\)/,
    );
  });

  it("gives private probes a disk buffer", () => {
    expect(loadProbeConfig({ ...valid, PROBE_MODE: "private" }).bufferDir).toBe(
      "/var/lib/watchpost-probe",
    );
  });

  it("names every missing or invalid variable", () => {
    const error = (() => {
      try {
        loadProbeConfig({ PROBE_REGION: "mars" });
      } catch (err) {
        return err as Error;
      }
      throw new Error("expected an error");
    })();
    expect(error).toBeInstanceOf(ProbeConfigError);
    expect(error.message).toContain("API_URL: is required");
    expect(error.message).toContain("PROBE_SECRET: is required");
    expect(error.message).toContain("PROBE_REGION: Invalid option");
  });
});
