import { describe, expect, it } from "vitest";
import { ConfigError, parseEnv } from "../env.js";

const valid = {
  WEB_ORIGIN: "http://localhost:3000",
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
};

describe("parseEnv", () => {
  it("parses a valid environment and applies defaults", () => {
    const env = parseEnv(valid);
    expect(env.NODE_ENV).toBe("development");
    expect(env.API_PORT).toBe(4000);
    expect(env.LOG_LEVEL).toBe("info");
  });

  it("coerces numbers", () => {
    expect(parseEnv({ ...valid, API_PORT: "8080" }).API_PORT).toBe(8080);
  });

  it("lists every missing variable by name", () => {
    const error = (() => {
      try {
        parseEnv({});
      } catch (err) {
        return err;
      }
      throw new Error("expected parseEnv to throw");
    })();
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as ConfigError).message;
    expect(message).toContain("WEB_ORIGIN: is required");
    expect(message).toContain("DATABASE_URL: is required");
    expect(message).toContain("REDIS_URL: is required");
  });

  it("treats empty strings as missing", () => {
    expect(() => parseEnv({ ...valid, DATABASE_URL: "" })).toThrow(/DATABASE_URL: is required/);
  });

  it("explains invalid values", () => {
    expect(() => parseEnv({ ...valid, REDIS_URL: "http://nope" })).toThrow(
      /REDIS_URL: must be a redis:\/\/ or rediss:\/\/ URL/,
    );
    expect(() => parseEnv({ ...valid, API_PORT: "99999" })).toThrow(/API_PORT/);
    expect(() => parseEnv({ ...valid, NODE_ENV: "staging" })).toThrow(/NODE_ENV/);
  });
});
