import { describe, expect, it } from "vitest";
import { ConfigError, parseEnv } from "../env.js";
import { toAppConfig } from "../index.js";

const KEY_A = Buffer.alloc(32, 1).toString("base64");
const KEY_B = Buffer.alloc(32, 2).toString("base64");

const valid = {
  WEB_ORIGIN: "http://localhost:3000",
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  TOKEN_ENC_KEY: KEY_A,
  BETTER_AUTH_SECRET: "s".repeat(32),
  BETTER_AUTH_URL: "http://localhost:4000",
};

describe("auth and email settings", () => {
  it("requires a long auth secret and a base URL", () => {
    expect(() => parseEnv({ ...valid, BETTER_AUTH_SECRET: "short" })).toThrow(
      /BETTER_AUTH_SECRET: must be at least 32 characters/,
    );
    expect(() => parseEnv({ ...valid, BETTER_AUTH_URL: undefined })).toThrow(
      /BETTER_AUTH_URL: is required/,
    );
  });

  it("requires Turnstile in production only", () => {
    expect(() => parseEnv({ ...valid, NODE_ENV: "production" })).toThrow(
      /TURNSTILE_SECRET_KEY: is required in production/,
    );
    expect(parseEnv({ ...valid, NODE_ENV: "development" }).TURNSTILE_SECRET_KEY).toBeUndefined();
    expect(() =>
      parseEnv({ ...valid, NODE_ENV: "production", TURNSTILE_SECRET_KEY: "0x4AAA" }),
    ).not.toThrow();
  });

  it("defaults email to the console transport; resend needs its API key", () => {
    expect(toAppConfig(parseEnv(valid)).email.transport).toBe("console");
    expect(() => parseEnv({ ...valid, EMAIL_TRANSPORT: "resend" })).toThrow(
      /RESEND_API_KEY: is required when EMAIL_TRANSPORT is "resend"/,
    );
    expect(
      toAppConfig(parseEnv({ ...valid, EMAIL_TRANSPORT: "resend", RESEND_API_KEY: "re_x" })).email,
    ).toMatchObject({ transport: "resend", resendApiKey: "re_x" });
  });
});

describe("encryption keys", () => {
  it("requires a 32-byte base64 key", () => {
    expect(() => parseEnv({ ...valid, TOKEN_ENC_KEY: undefined })).toThrow(
      /TOKEN_ENC_KEY: is required/,
    );
    expect(() =>
      parseEnv({ ...valid, TOKEN_ENC_KEY: Buffer.alloc(16).toString("base64") }),
    ).toThrow(/TOKEN_ENC_KEY: must be 32 random bytes/);
  });

  it("builds the key set from the active key and previous keys", () => {
    const config = toAppConfig(
      parseEnv({ ...valid, TOKEN_ENC_KEY_ID: "k2", TOKEN_ENC_PREVIOUS_KEYS: `k1:${KEY_B}` }),
    );
    expect(config.encryption.activeKeyId).toBe("k2");
    expect(Object.keys(config.encryption.keys).sort()).toEqual(["k1", "k2"]);
    expect(config.encryption.keys.k1?.equals(Buffer.from(KEY_B, "base64"))).toBe(true);
  });

  it("rejects malformed previous keys", () => {
    expect(() => parseEnv({ ...valid, TOKEN_ENC_PREVIOUS_KEYS: "k1-no-key" })).toThrow(
      /TOKEN_ENC_PREVIOUS_KEYS/,
    );
    expect(() => parseEnv({ ...valid, TOKEN_ENC_PREVIOUS_KEYS: "k1:short" })).toThrow(
      /TOKEN_ENC_PREVIOUS_KEYS/,
    );
  });
});

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
