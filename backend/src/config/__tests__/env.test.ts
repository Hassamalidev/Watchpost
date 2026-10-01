import { describe, expect, it } from "vitest";
import { ConfigError, parseEnv } from "../env.js";
import { toAppConfig } from "../index.js";
import { createPriceCatalog } from "../plans.js";

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

describe("upstream funding settings", () => {
  it("defaults to AI on with a $5 monthly cap for unpaid workspaces", () => {
    expect(toAppConfig(parseEnv(valid)).funding).toEqual({
      aiEnabled: true,
      unfundedAiCapMicros: 5_000_000,
      opsEmail: undefined,
    });
  });

  it("reads the kill switch, a zero cap and the ops address", () => {
    const config = toAppConfig(
      parseEnv({
        ...valid,
        AI_ENABLED: "false",
        UNFUNDED_AI_MONTHLY_CAP_USD: "0",
        OPS_EMAIL: "ops@example.com",
      }),
    );
    expect(config.funding).toEqual({
      aiEnabled: false,
      unfundedAiCapMicros: 0,
      opsEmail: "ops@example.com",
    });
    expect(() => parseEnv({ ...valid, AI_ENABLED: "yes" })).toThrow(/AI_ENABLED/);
    expect(() => parseEnv({ ...valid, UNFUNDED_AI_MONTHLY_CAP_USD: "-1" })).toThrow(
      /UNFUNDED_AI_MONTHLY_CAP_USD/,
    );
  });

  it("needs both Twilio credentials or none", () => {
    expect(toAppConfig(parseEnv(valid)).twilio).toBeUndefined();
    expect(() => parseEnv({ ...valid, TWILIO_ACCOUNT_SID: `AC${"0".repeat(32)}` })).toThrow(
      /TWILIO_AUTH_TOKEN: is required when Twilio is configured/,
    );
    expect(
      toAppConfig(
        parseEnv({
          ...valid,
          TWILIO_ACCOUNT_SID: `AC${"0".repeat(32)}`,
          TWILIO_AUTH_TOKEN: "0123456789abcdef0123456789abcdef",
        }),
      ).twilio,
    ).toEqual({
      accountSid: `AC${"0".repeat(32)}`,
      authToken: "0123456789abcdef0123456789abcdef",
    });
  });
});

describe("Paddle settings", () => {
  it("leaves billing off without keys and keeps empty price variables unset", () => {
    const config = toAppConfig(parseEnv({ ...valid, PADDLE_PRICE_PRO_MONTHLY: "" }));
    expect(config.paddle).toBeUndefined();
    expect(config.prices.plans.pro).toEqual({ month: undefined, year: undefined });
  });

  it("needs the API key and the webhook secret together", () => {
    expect(() => parseEnv({ ...valid, PADDLE_API_KEY: "pdl_sdbx_apikey_0123456789" })).toThrow(
      /PADDLE_WEBHOOK_SECRET: is required when Paddle is configured/,
    );
  });

  it("maps price variables to plans, credit packs and add-ons", () => {
    const config = toAppConfig(
      parseEnv({
        ...valid,
        PADDLE_ENV: "production",
        PADDLE_API_KEY: "pdl_live_apikey_0123456789",
        PADDLE_WEBHOOK_SECRET: "pdl_ntfset_0123456789",
        NEXT_PUBLIC_PADDLE_CLIENT_TOKEN: "live_0123456789abcdef",
        PADDLE_DISCOUNT_FOUNDING: "dsc_01founding",
        PADDLE_PRICE_PRO_MONTHLY: "pri_01promonth",
        PADDLE_PRICE_CREDITS_500: "pri_01credits500",
        PADDLE_PRICE_EXTRA_PROBE: "pri_01probe",
      }),
    );
    expect(config.paddle).toMatchObject({
      environment: "production",
      clientToken: "live_0123456789abcdef",
      foundingDiscountId: "dsc_01founding",
    });
    expect(config.prices.plans.pro.month).toBe("pri_01promonth");
    expect(config.prices.credits[500]).toBe("pri_01credits500");
    expect(config.prices.addons.extraProbe).toBe("pri_01probe");
    const catalog = createPriceCatalog(config.prices);
    expect(catalog.lookup("pri_01promonth")).toEqual({
      kind: "plan",
      plan: "pro",
      interval: "month",
    });
    expect(catalog.lookup("pri_01credits500")).toEqual({ kind: "credits", credits: 500 });
    expect(catalog.lookup("pri_01probe")).toEqual({ kind: "addon", addon: "extraProbe" });
    expect(catalog.lookup("pri_unknown")).toBeUndefined();
    expect(catalog.planPrice("starter", "year")).toBeUndefined();
  });

  it("rejects IDs that aren't Paddle prices", () => {
    expect(() => parseEnv({ ...valid, PADDLE_PRICE_PRO_MONTHLY: "prod_123" })).toThrow(
      /PADDLE_PRICE_PRO_MONTHLY/,
    );
  });
});
