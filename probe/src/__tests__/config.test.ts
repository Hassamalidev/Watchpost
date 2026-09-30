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
