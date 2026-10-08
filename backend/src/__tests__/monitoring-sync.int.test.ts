/*
 * P6-T03a end to end: the sync tool as it is shipped (the committed bundle, tools/sync/action)
 * runs as its own process against the real API on a local port. It creates the file's monitors,
 * finds nothing to do the second time, updates in place, prunes on request, and never touches a
 * monitor it doesn't manage.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import type TestAgent from "supertest/lib/agent.js";
import { WEB_ORIGIN, buildContainerApp, signUpVerified } from "./helpers/container-app.js";

const BUNDLE = fileURLToPath(new URL("../../../tools/sync/action/index.mjs", import.meta.url));
const ctx = buildContainerApp({ authRateLimit: false });
const run = randomBytes(4).toString("hex");
let owner: TestAgent;
let ws = "";
let server: Server;
let origin = "";
let dir = "";
let apiKey = "";

const FILE = `
version: 1
monitors:
  - key: shop
    name: Shop
    config: { type: tcp, host: shop.example.com, port: 443 }
    settings: { intervalSeconds: 300, tags: [production] }
  - key: shop-db
    name: Shop database
    config: { type: tcp, host: db.example.com, port: 5432 }
    paused: true
`;

/* Runs the bundle like a person or a CI job would, and collects what it prints. */
async function sync(args: string[], text: string, key = apiKey) {
  const file = join(dir, "monitoring.yml");
  await writeFile(file, text, "utf8");
  return new Promise<{ code: number | null; out: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [BUNDLE, ...args, "--file", file], {
      env: { ...process.env, MONITORING_API_KEY: key, MONITORING_URL: origin },
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out }));
  });
}

interface Listed {
  id: string;
  name: string;
  tags: string[];
  paused: boolean;
  intervalSeconds: number;
}
const monitors = async () =>
  (
    (await owner.get(`/api/w/${ws}/monitors?limit=200`).set("Origin", WEB_ORIGIN)).body
      .data as Listed[]
  ).sort((a, b) => a.name.localeCompare(b.name));

beforeAll(async () => {
  owner = request.agent(ctx.app);
  await signUpVerified(ctx, owner, `sync-${run}@example.com`);
  const created = await owner
    .post("/api/auth/organization/create")
    .set("Origin", WEB_ORIGIN)
    .send({ name: "Sync Co", slug: `sync-${run}` });
  expect(created.status, created.text).toBe(200);
  ws = created.body.id as string;
  const key = await owner
    .post(`/api/w/${ws}/api-keys`)
    .set("Origin", WEB_ORIGIN)
    .send({ name: "sync", scopes: ["monitors:write"] });
  expect(key.status, key.text).toBe(201);
  apiKey = key.body.key as string;

  /* One monitor made by hand, which the sync must leave alone. */
  await owner
    .post(`/api/w/${ws}/monitors`)
    .set("Origin", WEB_ORIGIN)
    .send({
      settings: { name: "Made by hand" },
      config: { type: "tcp", host: "example.com", port: 443 },
    });
  server = await new Promise<Server>((resolve) => {
    const listening = ctx.app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await mkdtemp(join(tmpdir(), "monitoring-sync-"));
}, 120_000);

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
  await ctx.container.close();
});

describe("monitoring sync against the API", () => {
  it("plans without changing anything", async () => {
    const plan = await sync(["plan", "--detailed-exitcode"], FILE);
    expect(plan.out).toContain("Workspace: Sync Co");
    expect(plan.out).toContain("+ shop (Shop)");
    expect(plan.out).toContain("Plan: 2 to create, 0 to update, 0 to delete, 0 unchanged.");
    expect(plan.code).toBe(2);
    expect((await monitors()).map((m) => m.name)).toEqual(["Made by hand"]);
  }, 60_000);

  it("applies the file, and a second run finds nothing to do", async () => {
    const applied = await sync(["apply"], FILE);
    expect(applied.out).toContain("Done.");
    expect(applied.code, applied.out).toBe(0);
    const list = await monitors();
    expect(list.map((m) => [m.name, m.paused])).toEqual([
      ["Made by hand", false],
      ["Shop", false],
      ["Shop database", true],
    ]);
    const shop = list[1];
    expect(shop?.intervalSeconds).toBe(300);
    expect(shop?.tags).toEqual(
      expect.arrayContaining([
        "production",
        "sync:key=shop",
        expect.stringMatching(/^sync:rev=[0-9a-f]{16}$/),
      ]),
    );

    const again = await sync(["apply"], FILE);
    expect(again.out).toContain("0 to create, 0 to update, 0 to delete, 2 unchanged.");
    expect(again.code).toBe(0);
    expect(await monitors()).toHaveLength(3);
  }, 60_000);

  it("updates in place, prunes on request and leaves other monitors alone", async () => {
    const before = await monitors();
    const shopId = before.find((m) => m.name === "Shop")?.id;
    const changed = FILE.replace("name: Shop\n", "name: Web shop\n").replace(
      "intervalSeconds: 300",
      "intervalSeconds: 600",
    );
    /* The same file without its second monitor. */
    const less = changed.slice(0, changed.indexOf("  - key: shop-db"));

    const kept = await sync(["apply"], less);
    expect(kept.out).toContain("~ shop (Web shop)");
    expect(kept.code, kept.out).toBe(0);
    let list = await monitors();
    expect(list.map((m) => m.name)).toEqual(["Made by hand", "Shop database", "Web shop"]);
    expect(list.find((m) => m.id === shopId)).toMatchObject({
      name: "Web shop",
      intervalSeconds: 600,
    });

    const pruned = await sync(["apply", "--prune"], less);
    expect(pruned.out).toContain("- shop-db (Shop database)");
    expect(pruned.code, pruned.out).toBe(0);
    list = await monitors();
    expect(list.map((m) => m.name)).toEqual(["Made by hand", "Web shop"]);
    expect(list[0]?.tags).toEqual([]);
  }, 60_000);

  it("says what the API refused and exits 1", async () => {
    const bad = FILE.replace("port: 5432", "port: 99999999");
    const result = await sync(["apply"], bad);
    expect(result.code).toBe(1);
    expect(result.out).toContain("! shop-db: POST /monitors answered 400");
    expect(result.out).toContain("refused");

    const wrongKey = await sync(["plan"], FILE, "wp_nope");
    expect(wrongKey.code).toBe(1);
    expect(wrongKey.out).toContain("GET /me answered 401");
  }, 60_000);
});
