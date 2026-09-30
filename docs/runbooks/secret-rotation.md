# Runbook: rotate the token encryption key

Channel tokens, monitor auth headers and probe secrets are encrypted with AES-256-GCM (`backend/src/infra/crypto.ts`). Each stored value starts with `v1.<keyId>.`, so old and new keys can coexist during a rotation.

## When

- Scheduled rotation (yearly), or
- Immediately if `TOKEN_ENC_KEY` may have leaked (then also rotate the third-party tokens themselves).

## Steps

1. Generate a new key:
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
2. In the production env, move the current key to the previous-keys list and install the new one:
   ```
   TOKEN_ENC_PREVIOUS_KEYS=k1:<old base64 key>
   TOKEN_ENC_KEY=<new base64 key>
   TOKEN_ENC_KEY_ID=k2
   ```
   Key IDs are 1–32 letters, digits, `-` or `_`, and must never be reused.
3. Deploy. New writes use `k2`; reads of `k1` values still work.
4. Re-encrypt old values: every module that stores encrypted values runs its re-encryption job, which calls `cipher.rotate(value, aad)` for rows where `cipher.needsRotation(value)` is true. (The jobs arrive with the modules that own encrypted columns; until then, there is nothing to re-encrypt.)
5. Confirm no value still uses the old key ID (for example `select count(*) from channels where config_enc like 'v1.k1.%'`).
6. Remove the old entry from `TOKEN_ENC_PREVIOUS_KEYS` and deploy again. Values still on `k1` would now fail with `Unknown encryption key "k1"`, so do step 5 first.

## If a value fails to decrypt

`DecryptionError` means a wrong or missing key, a tampered value, or the wrong context (associated data such as `channel:<id>`). Don't retry blindly: check the key ID in the value against the configured keys.
