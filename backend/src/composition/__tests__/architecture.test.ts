/*
 * Architecture tests (PRODUCT.md §7.13): the declared module graph, event catalog and table
 * ownership are consistent, and the dependency-cruiser rules really reject forbidden code.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { EVENT_TYPES } from "@app/shared";
import { checkArchitecture } from "../../../../scripts/arch-check.mjs";
import { QUEUES, isQueueName } from "../../infra/queues/index.js";
import { ALLOWED_CALLS, EVENT_SUBSCRIPTIONS, MODULE_NAMES, mayCall } from "../architecture.js";

const BACKEND = fileURLToPath(new URL("../../../", import.meta.url));
const SRC = path.join(BACKEND, "src");
const SCRATCH = path.join(BACKEND, ".arch-selftest", `rules-${randomBytes(4).toString("hex")}`);

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

describe("declared module graph (§7.4)", () => {
  it("only references known modules", () => {
    for (const name of MODULE_NAMES) {
      for (const target of ALLOWED_CALLS[name]) {
        if (target !== "*") expect(MODULE_NAMES).toContain(target);
      }
    }
  });

  it("has no cycles", () => {
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (name: (typeof MODULE_NAMES)[number], trail: string[]): void => {
      if (done.has(name)) return;
      if (visiting.has(name)) throw new Error(`cycle: ${[...trail, name].join(" -> ")}`);
      visiting.add(name);
      for (const next of ALLOWED_CALLS[name]) {
        if (next !== "*") visit(next, [...trail, name]);
      }
      visiting.delete(name);
      done.add(name);
    };
    for (const name of MODULE_NAMES) expect(() => visit(name, [])).not.toThrow();
  });

  it("answers mayCall from the table", () => {
    expect(mayCall("detection", "incidents")).toBe(true);
    expect(mayCall("incidents", "detection")).toBe(false);
    expect(mayCall("admin", "billing")).toBe(true);
  });
});

describe("event catalog (§7.5)", () => {
  it("gives every event a consumer or an explicit noConsumer", () => {
    for (const type of EVENT_TYPES) {
      const subs = EVENT_SUBSCRIPTIONS[type];
      expect(subs === "noConsumer" || subs.length > 0, type).toBe(true);
    }
  });

  it("routes subscribers to real event-handler queues that are rebuilt from the outbox", () => {
    for (const type of EVENT_TYPES) {
      const subs = EVENT_SUBSCRIPTIONS[type];
      if (subs === "noConsumer") continue;
      for (const sub of subs) {
        expect(isQueueName(sub.queue), `${type} -> ${sub.queue}`).toBe(true);
        expect(QUEUES[sub.queue].kind).toBe("event-handler");
      }
    }
  });
});

describe("table ownership (§8)", () => {
  it("declares every Drizzle table in a module schema/ folder or infra/*/schema.ts, once", () => {
    const owners = new Map<string, string>();
    for (const file of walk(SRC).filter((f) => f.endsWith(".ts") && !f.includes("__tests__"))) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/pgTable\(\s*"([a-z0-9_]+)"/g)) {
        const rel = path.relative(SRC, file).split(path.sep).join("/");
        expect(rel, `${match[1]} is declared outside a schema file`).toMatch(
          /^(modules\/[^/]+\/schema\/[^/]+\.ts|infra\/[^/]+\/schema\.ts)$/,
        );
        expect(owners.get(match[1] ?? ""), `${match[1]} is declared twice`).toBeUndefined();
        owners.set(match[1] ?? "", rel);
      }
    }
    expect(owners.get("outbox_events")).toBe("infra/outbox/schema.ts");
  });
});

describe("dependency-cruiser rules", () => {
  function scratch(files: Record<string, string>) {
    for (const [file, content] of Object.entries(files)) {
      const target = path.join(SCRATCH, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
  }

  it("pass on the real repository", async () => {
    const { violations } = await checkArchitecture();
    expect(violations.map((v) => `${v.rule.name}: ${v.from} -> ${v.to}`)).toEqual([]);
  }, 60_000);

  it("reject a forbidden module edge, a deep import, a cycle and lower layers importing modules", async () => {
    scratch({
      "backend/tsconfig.json": JSON.stringify({
        compilerOptions: { module: "nodenext", moduleResolution: "nodenext", strict: true },
        include: ["src"],
      }),
      "backend/src/modules/workspaces/index.ts": `export { workspaceName } from "./workspaces.service.js";\n`,
      "backend/src/modules/workspaces/workspaces.service.ts": `export const workspaceName = "acme";\n`,
      "backend/src/modules/audit/index.ts": `export const audit = true;\n`,
      /* allowed: incidents may call workspaces through its index */
      "backend/src/modules/incidents/index.ts": `import { workspaceName } from "../workspaces/index.js";\nexport const x = workspaceName;\n`,
      /* deep import: incidents -> workspaces internals */
      "backend/src/modules/incidents/incidents.service.ts": `import { workspaceName } from "../workspaces/workspaces.service.js";\nexport const y = workspaceName;\n`,
      /* forbidden edge: monitors may not call incidents (§7.4) */
      "backend/src/modules/monitors/index.ts": `import { x } from "../incidents/index.js";\nexport const z = x;\n`,
      /* cycle */
      "backend/src/infra/a.ts": `import { b } from "./b.js";\nexport const a = () => b;\n`,
      "backend/src/infra/b.ts": `import { a } from "./a.js";\nexport const b = () => a;\n`,
      /* lower layer importing a module */
      "backend/src/infra/c.ts": `import { audit } from "../modules/audit/index.js";\nexport const c = audit;\n`,
    });

    const { violations } = await checkArchitecture({
      baseDir: SCRATCH,
      projects: [{ files: ["backend/src"], tsConfig: "backend/tsconfig.json" }],
    });
    const found = violations.map((v) => `${v.rule.name}: ${v.from} -> ${v.to}`);

    expect(found).toContain(
      "module-edge:monitors: backend/src/modules/monitors/index.ts -> backend/src/modules/incidents/index.ts",
    );
    expect(found).toContain(
      "module-public-api-only: backend/src/modules/incidents/incidents.service.ts -> backend/src/modules/workspaces/workspaces.service.ts",
    );
    expect(found.some((f) => f.startsWith("no-circular: backend/src/infra/"))).toBe(true);
    expect(found).toContain(
      "lower-layers-never-import-modules: backend/src/infra/c.ts -> backend/src/modules/audit/index.ts",
    );
    /* The allowed edge is not reported. */
    expect(
      found.some((f) => f.includes("modules/incidents/index.ts -> backend/src/modules/workspaces")),
    ).toBe(false);
  }, 60_000);
});
