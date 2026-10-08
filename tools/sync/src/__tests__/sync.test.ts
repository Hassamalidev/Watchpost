/*
 * The sync against a stand-in for the public API that behaves as /api/v1 does where it matters
 * here: pages of monitors, settings merged on PATCH, an Idempotency-Key that replays a create, a
 * rate limit, and refusals as problem documents.
 */
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { BUNDLE, bundleOptions } from "../../build.mjs";
import { createClient, type Fetch } from "../client.js";
import { main } from "../main.js";
import { planSync, revisionOf, type RemoteMonitor } from "../plan.js";
import { runSync } from "../run.js";
import { SpecError, parseSpec } from "../spec.js";

interface Stored extends RemoteMonitor {
  config: Record<string, unknown>;
  settings: Record<string, unknown>;
}

function fakeApi(options: { scopes?: string[]; pageSize?: number } = {}) {
  const monitors = new Map<string, Stored>();
  const replies = new Map<string, Stored>();
  const calls: string[] = [];
  let next = 1;
  let limitOnce = false;
  const json = (status: number, body?: unknown, headers: Record<string, string> = {}) => ({
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  });
  const view = (m: Stored) => ({ id: m.id, name: m.name, tags: m.tags, paused: m.paused });

  const fetch: Fetch = async (url, init) => {
    const path = url.replace("https://app.example.com/api/v1", "");
    calls.push(`${init.method} ${path}`);
    if (init.headers.authorization !== "Bearer wp_test") {
      return json(401, { status: 401, code: "unauthorized", detail: "Send a valid API key." });
    }
    if (limitOnce) {
      limitOnce = false;
      return json(429, { status: 429, code: "rate_limited" }, { "retry-after": "2" });
    }
    const body = init.body === undefined ? undefined : (JSON.parse(init.body) as Stored);
    if (init.method === "GET" && path === "/me") {
      return json(200, {
        workspaceName: "Acme",
        scopes: options.scopes ?? ["monitors:write"],
      });
    }
    if (init.method === "GET" && path.startsWith("/monitors?")) {
      const size = options.pageSize ?? 200;
      const all = [...monitors.values()];
      const cursor = new URL(url).searchParams.get("cursor");
      const start = cursor === null ? 0 : all.findIndex((m) => m.id === cursor) + 1;
      const page = all.slice(start, start + size);
      return json(200, {
        data: page.map(view),
        nextCursor: start + size < all.length ? (page.at(-1)?.id ?? null) : null,
      });
    }
    if (init.method === "POST" && path === "/monitors" && body !== undefined) {
      const key = init.headers["idempotency-key"] ?? "";
      const before = replies.get(key);
      if (before !== undefined) return json(201, view(before));
      if (body.config.type === "nonsense") {
        return json(400, {
          status: 400,
          code: "validation_failed",
          detail: "The request is invalid.",
          errors: [{ path: "body.config.type", message: "Invalid input" }],
        });
      }
      const made: Stored = {
        id: `m${next++}`,
        name: body.settings.name as string,
        tags: body.settings.tags as string[],
        paused: false,
        config: body.config,
        settings: body.settings,
      };
      monitors.set(made.id, made);
      replies.set(key, made);
      return json(201, view(made));
    }
    const [, id, action] = /^\/monitors\/([^/]+)(?:\/(pause|resume))?$/.exec(path) ?? [];
    const found = id === undefined ? undefined : monitors.get(id);
    if (found === undefined)
      return json(404, { status: 404, code: "not_found", detail: "Not found." });
    if (init.method === "POST" && action !== undefined) {
      found.paused = action === "pause";
      return json(200, view(found));
    }
    if (init.method === "PATCH" && body !== undefined) {
      found.settings = { ...found.settings, ...body.settings };
      found.config = { ...found.config, ...body.config };
      found.name = found.settings.name as string;
      found.tags = found.settings.tags as string[];
      return json(200, view(found));
    }
    if (init.method === "DELETE") {
      monitors.delete(found.id);
      return json(204);
    }
    return json(404, { status: 404, code: "not_found" });
  };
  return {
    fetch,
    monitors,
    calls,
    limitNext: () => {
      limitOnce = true;
    },
    /* A monitor someone made in the app, outside the file. */
    addByHand(name: string, tags: string[] = []) {
      const made: Stored = {
        id: `m${next++}`,
        name,
        tags,
        paused: false,
        config: {},
        settings: {},
      };
      monitors.set(made.id, made);
      return made;
    },
  };
}

const FILE = `
version: 1
monitors:
  - key: shop
    name: Shop
    config: { type: http, url: https://shop.example.com }
    settings: { intervalSeconds: 60, tags: [production] }
  - key: shop-db
    name: Shop database
    config: { type: tcp, host: db.example.com, port: 5432 }
    paused: true
`;

const client = (api: ReturnType<typeof fakeApi>, waits: number[] = []) =>
  createClient({
    baseUrl: "https://app.example.com/",
    apiKey: "wp_test",
    fetch: api.fetch,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
const run = (
  api: ReturnType<typeof fakeApi>,
  text: string,
  mode: "plan" | "apply",
  flags: { prune?: boolean; force?: boolean } = {},
) => {
  const lines: string[] = [];
  return runSync(
    text,
    client(api),
    { mode, prune: flags.prune ?? false, force: flags.force ?? false },
    (line) => lines.push(line),
  ).then((result) => ({ ...result, lines }));
};

describe("the monitoring file", () => {
  it("reads YAML and JSON alike", () => {
    const fromYaml = parseSpec(FILE);
    expect(fromYaml.monitors.map((m) => [m.key, m.paused])).toEqual([
      ["shop", false],
      ["shop-db", true],
    ]);
    expect(parseSpec(JSON.stringify(fromYaml))).toEqual(fromYaml);
  });

  it("says what is wrong with a file, and where", () => {
    const problems = (text: string) => {
      try {
        parseSpec(text);
        return [];
      } catch (err) {
        if (!(err instanceof SpecError)) throw err;
        return err.problems;
      }
    };
    expect(problems("version: 2\nmonitors: []")[0]).toMatch(/^version: /);
    expect(
      problems(
        "version: 1\nmonitors:\n  - { key: a, name: A, config: { type: http } }\n  - { key: a, name: B, config: { type: http } }",
      ),
    ).toEqual(['monitors.1.key: "a" is used twice']);
    expect(
      problems("version: 1\nmonitors:\n  - { key: Bad Key, name: A, config: { type: http } }")[0],
    ).toMatch(/^monitors\.0\.key: /);
    expect(
      problems(
        "version: 1\nmonitors:\n  - { key: a, name: A, config: { type: http }, settings: { tags: ['sync:key=b'] } }",
      )[0],
    ).toContain(`tags can't start with "sync:"`);
    expect(
      problems(
        "version: 1\nmonitors:\n  - { key: a, name: A, config: { type: http }, settings: { name: B } }",
      )[0],
    ).toContain("put the name next to the key");
    expect(problems("version: 1\nmonitors: [")[0]).toBeDefined();
  });
});

describe("planning", () => {
  it("an entry's revision depends on its content, not on how it is written", () => {
    const [a] = parseSpec(
      "version: 1\nmonitors:\n  - { key: a, name: A, config: { type: http, url: 'https://a.example' }, settings: { intervalSeconds: 60 } }",
    ).monitors;
    const [b] = parseSpec(
      "version: 1\nmonitors:\n  - settings: { intervalSeconds: 60 }\n    config: { url: 'https://a.example', type: http }\n    name: A\n    key: a",
    ).monitors;
    const [c] = parseSpec(
      "version: 1\nmonitors:\n  - { key: a, name: A, config: { type: http, url: 'https://a.example' }, settings: { intervalSeconds: 30 } }",
    ).monitors;
    if (!a || !b || !c) throw new Error("missing");
    expect(revisionOf(a)).toBe(revisionOf(b));
    expect(revisionOf(a)).not.toBe(revisionOf(c));
  });

  it("leaves monitors it doesn't manage alone, with or without prune", () => {
    const file = parseSpec(FILE);
    const remote: RemoteMonitor[] = [
      { id: "x", name: "Made by hand", tags: ["production"], paused: false },
      { id: "y", name: "Old one", tags: ["sync:key=gone", "sync:rev=1"], paused: false },
    ];
    const kinds = (prune: boolean) =>
      planSync(file, remote, { prune, force: false }).map((a) => `${a.kind} ${a.key}`);
    expect(kinds(false)).toEqual(["create shop", "create shop-db"]);
    expect(kinds(true)).toEqual(["create shop", "create shop-db", "delete gone"]);
  });
});

describe("a run", () => {
  it("plans without changing anything, then applies, then finds nothing to do", async () => {
    const api = fakeApi();
    const byHand = api.addByHand("Made by hand");
    const plan = await run(api, FILE, "plan");
    expect(plan.counts).toEqual({ create: 2, update: 0, delete: 0, unchanged: 0 });
    expect(plan.lines).toEqual([
      "Workspace: Acme",
      "  + shop (Shop)",
      "  + shop-db (Shop database)",
      "Plan: 2 to create, 0 to update, 0 to delete, 0 unchanged.",
    ]);
    expect(api.monitors.size).toBe(1);
    expect(api.calls.every((call) => call.startsWith("GET "))).toBe(true);

    const applied = await run(api, FILE, "apply");
    expect(applied.failures).toEqual([]);
    expect(applied.lines.at(-1)).toBe("Done.");
    const stored = [...api.monitors.values()];
    expect(stored.map((m) => [m.name, m.paused])).toEqual([
      ["Made by hand", false],
      ["Shop", false],
      ["Shop database", true],
    ]);
    const shop = stored[1];
    expect(shop?.tags).toEqual([
      "production",
      "sync:key=shop",
      expect.stringMatching(/^sync:rev=[0-9a-f]{16}$/),
    ]);
    expect(shop?.settings.intervalSeconds).toBe(60);
    expect(shop?.config).toEqual({ type: "http", url: "https://shop.example.com" });

    const again = await run(api, FILE, "apply");
    expect(again.counts).toEqual({ create: 0, update: 0, delete: 0, unchanged: 2 });
    expect(api.monitors.get(byHand.id)?.name).toBe("Made by hand");
  });

  it("updates in place when an entry changes, also its name, and pauses to match", async () => {
    const api = fakeApi();
    await run(api, FILE, "apply");
    const id = [...api.monitors.values()].find((m) => m.name === "Shop")?.id ?? "";
    const changed = FILE.replace("name: Shop\n", "name: Web shop\n").replace(
      "paused: true",
      "paused: false",
    );
    const result = await run(api, changed, "apply");
    expect(result.counts).toEqual({ create: 0, update: 2, delete: 0, unchanged: 0 });
    expect(result.lines).toContain("  ~ shop (Web shop)");
    expect(api.monitors.get(id)).toMatchObject({ name: "Web shop", paused: false });
    expect([...api.monitors.values()].map((m) => m.paused)).toEqual([false, false]);
    expect(api.monitors.size).toBe(2);
  });

  it("deletes what left the file only when asked to prune", async () => {
    const api = fakeApi();
    await run(api, FILE, "apply");
    const byHand = api.addByHand("Made by hand");
    const less = FILE.slice(0, FILE.indexOf("  - key: shop-db"));
    const kept = await run(api, less, "apply");
    expect(kept.counts).toEqual({ create: 0, update: 0, delete: 0, unchanged: 1 });
    expect(api.monitors.size).toBe(3);
    const pruned = await run(api, less, "apply", { prune: true });
    expect(pruned.lines).toContain("  - shop-db (Shop database)");
    expect([...api.monitors.values()].map((m) => m.name)).toEqual(["Shop", "Made by hand"]);
    expect(api.monitors.has(byHand.id)).toBe(true);
  });

  it("puts back what was changed by hand only with --force", async () => {
    const api = fakeApi();
    await run(api, FILE, "apply");
    const shop = [...api.monitors.values()].find((m) => m.name === "Shop");
    if (!shop) throw new Error("missing");
    shop.settings.intervalSeconds = 300;
    expect((await run(api, FILE, "apply")).counts.unchanged).toBe(2);
    expect(shop.settings.intervalSeconds).toBe(300);
    expect((await run(api, FILE, "apply", { force: true })).counts.update).toBe(2);
    expect(api.monitors.get(shop.id)?.settings.intervalSeconds).toBe(60);
  });

  it("reads every page, waits when it is rate limited, and repeats a create safely", async () => {
    const api = fakeApi({ pageSize: 1 });
    await run(api, FILE, "apply");
    const waits: number[] = [];
    api.limitNext();
    expect(await client(api, waits).monitors()).toHaveLength(2);
    expect(waits).toEqual([2_000]);
    /* A run that was cut off after creating: the same create answers with the same monitor. */
    const [shop] = parseSpec(FILE).monitors;
    if (!shop) throw new Error("missing");
    const key = `sync-shop-${revisionOf(shop)}`;
    const body = { settings: { name: "Shop", tags: [] }, config: shop.config };
    const made = await client(api).create(body, key);
    expect(api.monitors.size).toBe(2);
    expect(made.id).toBe([...api.monitors.values()][0]?.id);
  });

  it("carries on when one monitor is refused, and ends as failed", async () => {
    const api = fakeApi();
    const bad = FILE.replace("type: tcp", "type: nonsense");
    const result = await run(api, bad, "apply");
    expect(result.failures).toEqual([
      {
        key: "shop-db",
        message:
          "POST /monitors answered 400: The request is invalid. (body.config.type: Invalid input)",
      },
    ]);
    expect([...api.monitors.values()].map((m) => m.name)).toEqual(["Shop"]);
    expect(result.lines.at(-1)).toBe("Done, with 1 monitor refused.");
  });

  it("won't try to apply with a key that can only read", async () => {
    const api = fakeApi({ scopes: ["monitors:read"] });
    expect((await run(api, FILE, "plan")).counts.create).toBe(2);
    await expect(run(api, FILE, "apply")).rejects.toThrow(/monitors:write/);
    expect(api.monitors.size).toBe(0);
  });
});

describe("the command", () => {
  const io = (api: ReturnType<typeof fakeApi>, files: Record<string, string>) => {
    const lines: string[] = [];
    return {
      lines,
      print: (line: string) => lines.push(line),
      readFile: async (path: string) => {
        const text = files[path];
        if (text === undefined) throw new Error(`ENOENT: no such file, open '${path}'`);
        return text;
      },
      fetch: api.fetch,
    };
  };
  const env = { MONITORING_API_KEY: "wp_test", MONITORING_URL: "https://app.example.com" };

  it("exits 0 when fine, 2 for a plan with changes when asked, 1 when something is wrong", async () => {
    const api = fakeApi();
    const files = { "monitoring.yml": FILE, "broken.yml": "version: 1\nmonitors: 5" };
    expect(await main(["plan", "--file", "monitoring.yml"], env, io(api, files))).toBe(0);
    expect(
      await main(["plan", "--file", "monitoring.yml", "--detailed-exitcode"], env, io(api, files)),
    ).toBe(2);
    expect(await main(["apply", "--file", "monitoring.yml"], env, io(api, files))).toBe(0);
    expect(
      await main(["plan", "--file", "monitoring.yml", "--detailed-exitcode"], env, io(api, files)),
    ).toBe(0);

    const broken = io(api, files);
    expect(await main(["plan", "--file", "broken.yml"], env, broken)).toBe(1);
    expect(broken.lines[0]).toContain("The monitoring file is invalid");
    const missing = io(api, files);
    expect(await main(["plan", "--file", "nowhere.yml"], env, missing)).toBe(1);
    expect(missing.lines[0]).toContain("no such file");
    const wrongKey = io(api, files);
    expect(
      await main(
        ["plan", "--file", "monitoring.yml"],
        { ...env, MONITORING_API_KEY: "wp_no" },
        wrongKey,
      ),
    ).toBe(1);
    expect(wrongKey.lines[0]).toContain("GET /me answered 401");
    const noMode = io(api, files);
    expect(await main(["--file", "monitoring.yml"], env, noMode)).toBe(1);
    expect(noMode.lines[0]).toBe("Say what to do: plan or apply.");
    expect(await main(["plan", "--file", "monitoring.yml"], {}, io(api, files))).toBe(1);
  });

  it("takes its settings from the action's inputs", async () => {
    const api = fakeApi();
    const inputs = {
      INPUT_MODE: "apply",
      INPUT_FILE: "monitoring.yml",
      INPUT_PRUNE: "true",
      "INPUT_API-KEY": "wp_test",
      INPUT_URL: "https://app.example.com",
    };
    api.addByHand("Old", ["sync:key=old", "sync:rev=0"]);
    expect(await main([], inputs, io(api, { "monitoring.yml": FILE }))).toBe(0);
    expect([...api.monitors.values()].map((m) => m.name)).toEqual(["Shop", "Shop database"]);
  });
});

describe("the committed bundle", () => {
  it("is what the source builds to", async () => {
    const built = await build({ ...bundleOptions, write: false });
    const expected = Buffer.from(built.outputFiles?.[0]?.contents ?? []).toString("utf8");
    /* Line endings aside: a checkout on Windows may rewrite them. */
    const lf = (text: string) => text.replace(/\r\n/g, "\n");
    expect(lf(await readFile(BUNDLE, "utf8"))).toBe(lf(expected));
  }, 60_000);
});
