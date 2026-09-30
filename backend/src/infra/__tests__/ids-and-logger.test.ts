import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import { isUuidV7, newId } from "../ids.js";
import { createLogger } from "../logger.js";

describe("UUIDv7 IDs", () => {
  it("creates valid, unique, time-ordered IDs", () => {
    const ids = Array.from({ length: 1_000 }, () => newId());
    expect(ids.every(isUuidV7)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });

  it("rejects other UUID versions and junk", () => {
    expect(isUuidV7("0f8fad5b-d9cb-469f-a165-70867728950e")).toBe(false);
    expect(isUuidV7("not-a-uuid")).toBe(false);
  });
});

describe("logger redaction", () => {
  function capture() {
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk, _enc, done) {
        lines.push(String(chunk));
        done();
      },
    });
    return { lines, logger: createLogger({ level: "info", destination }) };
  }

  it("redacts secrets, auth headers and cookies", () => {
    const { lines, logger } = capture();
    logger.info(
      {
        req: { headers: { authorization: "Bearer abc123", cookie: "session=xyz" } },
        user: { email: "a@example.com", password: "hunter2" },
        channel: { token: "xoxb-1", secret: "s3cr3t" },
        monitor: { headers: { "x-api-key": "key-123" } },
      },
      "test",
    );
    const out = lines.join("");
    for (const secret of ["abc123", "session=xyz", "hunter2", "xoxb-1", "s3cr3t", "key-123"]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain("[redacted]");
    expect(out).toContain("a@example.com");
  });

  it("tags every line with the service name", () => {
    const { lines, logger } = capture();
    logger.info("hello");
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ service: "api", msg: "hello" });
  });
});
