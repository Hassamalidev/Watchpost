import { describe, expect, it } from "vitest";
import { DecryptionError, createTokenCipher, generateKey, parseKey } from "../crypto.js";

const k1 = parseKey(generateKey());
const k2 = parseKey(generateKey());

describe("token cipher (AES-256-GCM)", () => {
  const cipher = createTokenCipher({ activeKeyId: "k1", keys: { k1 } });

  it("round-trips text, including unicode and empty strings", () => {
    for (const value of ["xoxb-slack-token", "päss wörd ✓", ""]) {
      expect(cipher.decrypt(cipher.encrypt(value))).toBe(value);
    }
  });

  it("uses a fresh IV, so the same plaintext encrypts differently", () => {
    expect(cipher.encrypt("same")).not.toBe(cipher.encrypt("same"));
  });

  it("embeds the key ID and never contains the plaintext", () => {
    const token = cipher.encrypt("super-secret-value");
    expect(token.startsWith("v1.k1.")).toBe(true);
    expect(token).not.toContain("super-secret-value");
    expect(cipher.keyIdOf(token)).toBe("k1");
  });

  it("detects tampering", () => {
    const token = cipher.encrypt("hello");
    const parts = token.split(".");
    const ct = Buffer.from(parts[3] ?? "", "base64url");
    ct[0] = (ct[0] ?? 0) ^ 0xff;
    parts[3] = ct.toString("base64url");
    expect(() => cipher.decrypt(parts.join("."))).toThrow(DecryptionError);
  });

  it("binds values to their context with associated data", () => {
    const token = cipher.encrypt("bot-token", "channel:A");
    expect(cipher.decrypt(token, "channel:A")).toBe("bot-token");
    expect(() => cipher.decrypt(token, "channel:B")).toThrow(DecryptionError);
    expect(() => cipher.decrypt(token)).toThrow(DecryptionError);
  });

  it("rejects malformed values and unknown keys", () => {
    expect(() => cipher.decrypt("plaintext")).toThrow(DecryptionError);
    const other = createTokenCipher({ activeKeyId: "k9", keys: { k9: k2 } });
    expect(() => cipher.decrypt(other.encrypt("x"))).toThrow(/Unknown encryption key "k9"/);
  });

  it("refuses bad key sets", () => {
    expect(() => createTokenCipher({ activeKeyId: "k1", keys: {} })).toThrow(/Active key/);
    expect(() => createTokenCipher({ activeKeyId: "k1", keys: { k1: Buffer.alloc(16) } })).toThrow(
      /32 bytes/,
    );
    expect(() => parseKey(Buffer.alloc(31).toString("base64"))).toThrow(/32 bytes/);
  });
});

describe("key rotation", () => {
  const before = createTokenCipher({ activeKeyId: "k1", keys: { k1 } });
  const after = createTokenCipher({ activeKeyId: "k2", keys: { k1, k2 } });

  it("decrypts values written with the previous key", () => {
    const old = before.encrypt("legacy", "probe:1");
    expect(after.decrypt(old, "probe:1")).toBe("legacy");
    expect(after.needsRotation(old)).toBe(true);
  });

  it("re-encrypts old values with the active key and leaves current ones alone", () => {
    const old = before.encrypt("legacy", "probe:1");
    const rotated = after.rotate(old, "probe:1");
    expect(after.keyIdOf(rotated)).toBe("k2");
    expect(after.needsRotation(rotated)).toBe(false);
    expect(after.decrypt(rotated, "probe:1")).toBe("legacy");
    expect(after.rotate(rotated, "probe:1")).toBe(rotated);
  });

  it("once the old key is removed, only rotated values still decrypt", () => {
    const old = before.encrypt("legacy");
    const rotated = after.rotate(old);
    const retired = createTokenCipher({ activeKeyId: "k2", keys: { k2 } });
    expect(retired.decrypt(rotated)).toBe("legacy");
    expect(() => retired.decrypt(old)).toThrow(/Unknown encryption key "k1"/);
  });
});
