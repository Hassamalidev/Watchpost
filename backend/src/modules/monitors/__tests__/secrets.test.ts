import { describe, expect, it } from "vitest";
import { monitorConfigSchema } from "@app/shared";
import {
  MASKED,
  applySecrets,
  extractSecrets,
  hasUnresolvedMask,
  isSecretHeader,
} from "../types/secrets.js";

const http = monitorConfigSchema.parse({
  type: "http",
  url: "https://api.example.com/health",
  auth: { kind: "basic", username: "ops", password: "s3cret" },
  headers: [
    { name: "Authorization", value: "Bearer abc" },
    { name: "X-Api-Key", value: "key-123" },
    { name: "Accept", value: "application/json" },
  ],
});

describe("monitor secrets", () => {
  it("recognizes auth-like headers", () => {
    for (const name of ["Authorization", "cookie", "X-Api-Key", "X-Auth-Token", "client-secret"]) {
      expect(isSecretHeader(name), name).toBe(true);
    }
    expect(isSecretHeader("Accept")).toBe(false);
    expect(isSecretHeader("User-Agent")).toBe(false);
  });

  it("masks secrets in the stored config and returns them separately", () => {
    const { config, secrets } = extractSecrets(http);
    const text = JSON.stringify(config);
    for (const secret of ["s3cret", "Bearer abc", "key-123"]) expect(text).not.toContain(secret);
    expect(text).toContain("application/json");
    expect(secrets).toEqual({
      authPassword: "s3cret",
      headers: { authorization: "Bearer abc", "x-api-key": "key-123" },
    });
  });

  it("restores secrets for masked values and keeps newly typed ones", () => {
    const { config, secrets } = extractSecrets(http);
    expect(applySecrets(config, secrets)).toEqual(http);

    const edited = structuredClone(config);
    if (edited.type === "http" && edited.auth.kind === "basic")
      edited.auth.password = "new-password";
    const merged = applySecrets(edited, secrets);
    expect(merged.type === "http" && merged.auth.kind === "basic" && merged.auth.password).toBe(
      "new-password",
    );
  });

  it("returns null secrets for configs without any", () => {
    const tcp = monitorConfigSchema.parse({ type: "tcp", host: "db.example.com", port: 5432 });
    expect(extractSecrets(tcp).secrets).toBeNull();
  });

  it("detects masks that have no stored secret", () => {
    const bearer = monitorConfigSchema.parse({
      type: "http",
      url: "https://x.example.com",
      auth: { kind: "bearer", token: MASKED },
    });
    expect(hasUnresolvedMask(applySecrets(bearer, null))).toBe(true);
    expect(hasUnresolvedMask(http)).toBe(false);
  });
});

describe("multi-step secrets", () => {
  const multistep = monitorConfigSchema.parse({
    type: "multistep",
    secrets: [
      { name: "password", value: "hunter2-pass" },
      { name: "apiKey", value: "key-abc-123" },
    ],
    steps: [
      {
        name: "Sign in",
        url: "https://api.example.com/login",
        method: "POST",
        headers: [{ name: "X-Api-Key", value: "{{apiKey}}" }],
        body: '{"password":"{{password}}"}',
      },
    ],
  });

  it("masks the named secrets and nothing else, and puts them back", () => {
    const { config, secrets } = extractSecrets(multistep);
    const text = JSON.stringify(config);
    expect(text).not.toContain("hunter2-pass");
    expect(text).not.toContain("key-abc-123");
    /* The references stay readable: they say where a secret is used, not what it is. */
    expect(text).toContain("{{apiKey}}");
    expect(secrets).toEqual({ variables: { password: "hunter2-pass", apiKey: "key-abc-123" } });
    expect(hasUnresolvedMask(config)).toBe(true);
    expect(applySecrets(config, secrets)).toEqual(multistep);
    expect(hasUnresolvedMask(applySecrets(config, secrets))).toBe(false);
  });

  it("leaves a mask in place for a secret it has no value for", () => {
    const { config } = extractSecrets(multistep);
    const partial = applySecrets(config, { variables: { password: "hunter2-pass" } });
    expect(hasUnresolvedMask(partial)).toBe(true);
  });
});
