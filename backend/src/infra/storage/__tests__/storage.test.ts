/*
 * Object storage: the memory and folder stores behave alike, keys can't escape, and the R2 store
 * sends signed path-style S3 requests (checked against a small local S3 look-alike; a real bucket is
 * P2-T04b).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertObjectKey,
  createFileObjectStore,
  createMemoryObjectStore,
  type ObjectStore,
} from "../index.js";
import { createR2ObjectStore } from "../r2.js";

let dir: string;
let server: http.Server;
let endpoint: string;
const requests: Array<{ method: string; url: string; authorization: string; type: string }> = [];
const bucket = new Map<string, Buffer>();

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "watchpost-objects-"));
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const url = req.url ?? "";
      requests.push({
        method: req.method ?? "",
        url,
        authorization: req.headers.authorization ?? "",
        type: req.headers["content-type"] ?? "",
      });
      const key = url.split("?")[0] ?? "";
      if (req.method === "PUT") {
        bucket.set(key, Buffer.concat(chunks));
        res.writeHead(200, { etag: '"test"' }).end();
      } else if (req.method === "GET") {
        const body = bucket.get(key);
        if (body === undefined) {
          res
            .writeHead(404, { "content-type": "application/xml" })
            .end("<Error><Code>NoSuchKey</Code><Message>no such key</Message></Error>");
        } else {
          res.writeHead(200, { "content-length": String(body.length) }).end(body);
        }
      } else if (req.method === "DELETE") {
        bucket.delete(key);
        res.writeHead(204).end();
      } else {
        res.writeHead(405).end();
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await new Promise((resolve) => server.close(resolve));
});

/* Built inside each test: the folder and the endpoint exist only after beforeAll. */
const stores = (): Array<[string, ObjectStore]> => [
  ["memory", createMemoryObjectStore()],
  ["file", createFileObjectStore(dir)],
  [
    "r2",
    createR2ObjectStore({
      accountId: "account",
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
      bucket: "watchpost-test",
      endpoint,
    }),
  ],
];

describe("object stores", () => {
  for (const name of ["memory", "file", "r2"]) {
    it(`${name}: stores, reads back, overwrites and deletes`, async () => {
      const store = stores().find(([kind]) => kind === name)?.[1];
      if (store === undefined) throw new Error(`no ${name} store`);
      const key = `evidence/ws-1/2026-10-05/${name}.json`;
      expect(await store.get(key)).toBeUndefined();
      await store.put(key, JSON.stringify({ a: 1 }), { contentType: "application/json" });
      expect((await store.get(key))?.toString("utf8")).toBe('{"a":1}');
      await store.put(key, Buffer.from("second"));
      expect((await store.get(key))?.toString("utf8")).toBe("second");
      await store.delete(key);
      expect(await store.get(key)).toBeUndefined();
      /* Deleting what isn't there is not an error. */
      await store.delete(key);
      expect(store.kind).toBe(name);
    });
  }

  it("refuses keys that could leave the store", async () => {
    for (const key of [
      "../secrets",
      "evidence/../../etc/passwd",
      "/absolute",
      "a//b",
      "a\\b",
      "",
    ]) {
      expect(() => assertObjectKey(key), key).toThrow(/Invalid object key/);
      await expect(createFileObjectStore(dir).put(key, "x")).rejects.toThrow(/Invalid object key/);
    }
    expect(() => assertObjectKey("evidence/0199-ab/2026-10-05/0199-cd.json")).not.toThrow();
  });

  it("R2: signed, path-style requests to the configured bucket", async () => {
    const store = createR2ObjectStore({
      accountId: "account",
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-key",
      bucket: "watchpost-test",
      endpoint,
    });
    requests.length = 0;
    await store.put("evidence/ws-1/2026-10-05/shape.json", "{}", {
      contentType: "application/json",
    });
    const [put] = requests;
    expect(put).toMatchObject({
      method: "PUT",
      type: "application/json",
    });
    expect(put?.url.split("?")[0]).toBe("/watchpost-test/evidence/ws-1/2026-10-05/shape.json");
    expect(put?.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=test-access-key\/\d{8}\/auto\/s3\//,
    );
  });
});
