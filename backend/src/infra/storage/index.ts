/*
 * Private object storage (PRODUCT.md §7.2: failure evidence, later screenshots, report PDFs, import
 * uploads). `ObjectStore` is what the product talks to. Production uses Cloudflare R2 (r2.ts);
 * development falls back to a folder on disk, and tests use memory. Nothing here is ever public:
 * objects are read back only through the API, which checks the workspace first.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

export interface ObjectStore {
  /* Which implementation this is, for logs and the health page. */
  readonly kind: "r2" | "file" | "memory";
  put(key: string, body: string | Buffer, options?: { contentType?: string }): Promise<void>;
  /* Undefined when there is no such object (never stored, or past its lifetime). */
  get(key: string): Promise<Buffer | undefined>;
  delete(key: string): Promise<void>;
}

/* Keys are paths we build ourselves; anything else is a bug, so it fails loudly. */
const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

export function assertObjectKey(key: string): void {
  if (key.length > 512 || !KEY.test(key) || key.includes("..")) {
    throw new Error(`Invalid object key "${key.slice(0, 80)}"`);
  }
}

export function createMemoryObjectStore(): ObjectStore & { objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  return {
    kind: "memory",
    objects,
    async put(key, body) {
      assertObjectKey(key);
      objects.set(key, Buffer.from(body));
    },
    async get(key) {
      assertObjectKey(key);
      return objects.get(key);
    },
    async delete(key) {
      assertObjectKey(key);
      objects.delete(key);
    },
  };
}

/* Objects as files under `root`. For development on one machine; there is no lifecycle rule. */
export function createFileObjectStore(root: string): ObjectStore {
  const base = resolve(root);
  const pathOf = (key: string) => {
    assertObjectKey(key);
    const path = resolve(base, ...key.split("/"));
    /* The key pattern already rules this out; the check stays as the last line of defence. */
    if (!path.startsWith(base + sep)) throw new Error(`Object key "${key}" leaves the store`);
    return path;
  };
  return {
    kind: "file",
    async put(key, body) {
      const path = pathOf(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
    },
    async get(key) {
      try {
        return await readFile(pathOf(key));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw err;
      }
    },
    async delete(key) {
      await rm(pathOf(key), { force: true });
    },
  };
}
