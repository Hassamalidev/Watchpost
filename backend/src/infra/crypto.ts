/*
 * AES-256-GCM encryption for third-party tokens, monitor secrets and probe secrets (PRODUCT.md §12).
 * Format: `v1.<keyId>.<iv>.<ciphertext>.<tag>` (base64url parts). The key ID makes rotation possible:
 * new values use the active key, old values still decrypt with a previous key until re-encrypted.
 * Optional associated data (AAD) binds a ciphertext to its owner (for example "channel:<id>"),
 * so a value copied to another row fails to decrypt.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecryptionError";
  }
}

export interface TokenCipherKeys {
  activeKeyId: string;
  /* Every key that may still be needed to decrypt, including the active one. */
  keys: Record<string, Buffer>;
}

export interface TokenCipher {
  encrypt(plaintext: string, aad?: string): string;
  decrypt(token: string, aad?: string): string;
  keyIdOf(token: string): string;
  /* True when the value was encrypted with a key other than the active one. */
  needsRotation(token: string): boolean;
  rotate(token: string, aad?: string): string;
}

export function parseKey(base64: string): Buffer {
  const key = Buffer.from(base64, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(`Encryption keys must be ${KEY_BYTES} bytes (base64), got ${key.length}`);
  }
  return key;
}

export function generateKey(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}

export function createTokenCipher({ activeKeyId, keys }: TokenCipherKeys): TokenCipher {
  for (const [id, key] of Object.entries(keys)) {
    if (!KEY_ID_PATTERN.test(id)) throw new Error(`Invalid key ID "${id}"`);
    if (key.length !== KEY_BYTES) throw new Error(`Key "${id}" must be ${KEY_BYTES} bytes`);
  }
  const activeKey = keys[activeKeyId];
  if (activeKey === undefined) throw new Error(`Active key "${activeKeyId}" is not in the key set`);

  function split(token: string) {
    const parts = token.split(".");
    if (parts.length !== 5 || parts[0] !== VERSION) {
      throw new DecryptionError("Not an encrypted value (unexpected format)");
    }
    const [, keyId, iv, ciphertext, tag] = parts as [string, string, string, string, string];
    return { keyId, iv, ciphertext, tag };
  }

  const cipher: TokenCipher = {
    encrypt(plaintext, aad) {
      const iv = randomBytes(IV_BYTES);
      const c = createCipheriv(ALGORITHM, activeKey, iv, { authTagLength: TAG_BYTES });
      if (aad !== undefined) c.setAAD(Buffer.from(aad, "utf8"));
      const ciphertext = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
      return [
        VERSION,
        activeKeyId,
        iv.toString("base64url"),
        ciphertext.toString("base64url"),
        c.getAuthTag().toString("base64url"),
      ].join(".");
    },

    decrypt(token, aad) {
      const { keyId, iv, ciphertext, tag } = split(token);
      const key = keys[keyId];
      if (key === undefined) throw new DecryptionError(`Unknown encryption key "${keyId}"`);
      try {
        const d = createDecipheriv(ALGORITHM, key, Buffer.from(iv, "base64url"), {
          authTagLength: TAG_BYTES,
        });
        if (aad !== undefined) d.setAAD(Buffer.from(aad, "utf8"));
        d.setAuthTag(Buffer.from(tag, "base64url"));
        return Buffer.concat([d.update(Buffer.from(ciphertext, "base64url")), d.final()]).toString(
          "utf8",
        );
      } catch {
        throw new DecryptionError("Decryption failed (wrong key, tampered value or wrong context)");
      }
    },

    keyIdOf(token) {
      return split(token).keyId;
    },

    needsRotation(token) {
      return split(token).keyId !== activeKeyId;
    },

    rotate(token, aad) {
      return cipher.needsRotation(token) ? cipher.encrypt(cipher.decrypt(token, aad), aad) : token;
    },
  };
  return cipher;
}
