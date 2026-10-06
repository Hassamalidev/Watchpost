/*
 * Cloudflare R2 through its S3-compatible API. Per Cloudflare's AWS SDK v3 example (checked
 * 2026-10-05): endpoint https://<account>.r2.cloudflarestorage.com and region "auto" (required by the
 * SDK, not used by R2). Path-style addressing keeps the bucket out of the host name. The SDK's
 * default of adding a CRC32 checksum to every request is limited to where a checksum is required;
 * this has not been run against a real bucket yet (P2-T04b). The bucket stays private; lifetimes
 * (30 days for evidence) are a lifecycle rule on the bucket, not code.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { assertObjectKey, type ObjectStore } from "./index.js";

export interface R2Options {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /* Another S3-compatible endpoint (tests, MinIO); defaults to the account's R2 endpoint. */
  endpoint?: string | undefined;
}

const REQUEST_TIMEOUT_MS = 5_000;

export function createR2ObjectStore(options: R2Options): ObjectStore {
  const client = new S3Client({
    region: "auto",
    endpoint: options.endpoint ?? `https://${options.accountId}.r2.cloudflarestorage.com`,
    forcePathStyle: true,
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    maxAttempts: 2,
  });
  const within = () => ({ abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

  return {
    kind: "r2",
    async put(key, body, putOptions) {
      assertObjectKey(key);
      await client.send(
        new PutObjectCommand({
          Bucket: options.bucket,
          Key: key,
          Body: typeof body === "string" ? Buffer.from(body) : body,
          ContentType: putOptions?.contentType ?? "application/octet-stream",
        }),
        within(),
      );
    },
    async get(key) {
      assertObjectKey(key);
      try {
        const res = await client.send(
          new GetObjectCommand({ Bucket: options.bucket, Key: key }),
          within(),
        );
        if (res.Body === undefined) return undefined;
        return Buffer.from(await res.Body.transformToByteArray());
      } catch (err) {
        if (
          err instanceof S3ServiceException &&
          (err.name === "NoSuchKey" || err.$metadata.httpStatusCode === 404)
        ) {
          return undefined;
        }
        throw err;
      }
    },
    async delete(key) {
      assertObjectKey(key);
      await client.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: key }), within());
    },
  };
}
