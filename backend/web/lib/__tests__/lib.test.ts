/* The API client maps problem JSON to ApiError; formatting helpers are stable. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, errorMessage, wsPath } from "../api";
import { formatDuration, formatPercent, relativeTime } from "../format";

afterEach(() => {
  vi.unstubAllGlobals();
});

function respond(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status })),
  );
}

describe("api client", () => {
  it("returns JSON and sends cookies", async () => {
    respond(200, { ok: true });
    await expect(api("/api/x")).resolves.toEqual({ ok: true });
    expect(vi.mocked(fetch).mock.calls[0]?.[1]).toMatchObject({ credentials: "include" });
  });

  it("turns problem responses into ApiError with field errors", async () => {
    respond(400, {
      code: "validation_failed",
      detail: "The request is invalid.",
      errors: [{ path: "settings.name", message: "Required" }],
    });
    const error = await api("/api/x", { method: "POST", body: {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 400,
      code: "validation_failed",
      message: "The request is invalid.",
      fieldErrors: [{ path: "settings.name", message: "Required" }],
    });
    expect(errorMessage(error)).toBe("The request is invalid.");
  });

  it("handles empty responses", async () => {
    respond(204, undefined);
    await expect(api("/api/x", { method: "DELETE" })).resolves.toBeUndefined();
  });

  it("builds workspace paths", () => {
    expect(wsPath("abc", "/monitors")).toBe("/api/w/abc/monitors");
  });
});

describe("formatting", () => {
  it("formats durations", () => {
    expect(formatDuration(42)).toBe("42s");
    expect(formatDuration(125)).toBe("2m 5s");
    expect(formatDuration(3_725)).toBe("1h 2m");
    expect(formatDuration(90_000)).toBe("1d 1h");
  });

  it("formats relative times and percents", () => {
    const now = Date.parse("2026-10-01T12:00:00Z");
    expect(relativeTime("2026-10-01T11:58:00Z", now)).toBe("2 minutes ago");
    expect(relativeTime(null, now)).toBe("—");
    expect(formatPercent(100)).toBe("100%");
    expect(formatPercent(99.95)).toBe("99.950%");
    expect(formatPercent(null)).toBe("—");
  });
});
