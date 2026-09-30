/*
 * `pnpm new:module <name> [--calls a,b] [--root <backend dir>]`
 * Creates modules/<name>/ from the template in PRODUCT.md §7.3, adds the module to
 * composition/module-edges.json (if new) and registers its factory in composition/modules.ts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export interface GenerateOptions {
  name: string;
  root?: string;
  calls?: string[];
}

const pascal = (name: string) =>
  name
    .split("-")
    .map((p) => p[0]?.toUpperCase() + p.slice(1))
    .join("");
const camel = (name: string) => {
  const p = pascal(name);
  return p[0]?.toLowerCase() + p.slice(1);
};

function templates(name: string): Record<string, string> {
  const P = pascal(name);
  const c = camel(name);
  return {
    "index.ts": `/* Public API of the ${name} module. Other modules import only from this file (PRODUCT.md §7.1). */
import type { AppModule, Infra } from "../../composition/types.js";
import { create${P}Controller } from "./${name}.controller.js";
import { create${P}Repository } from "./${name}.repository.js";
import { create${P}Router } from "./${name}.routes.js";
import { create${P}Service, type ${P}Service } from "./${name}.service.js";
import { ${c}Processors } from "./jobs/index.js";

export type { ${P}Service };

export interface ${P}ModuleDeps {
  infra: Pick<Infra, "db" | "outbox" | "clock" | "logger">;
}

export interface ${P}Module extends AppModule {
  service: ${P}Service;
}

export function create${P}Module(deps: ${P}ModuleDeps): ${P}Module {
  const repository = create${P}Repository(deps.infra.db);
  const service = create${P}Service({ repository, clock: deps.infra.clock });
  const controller = create${P}Controller(service);
  return {
    name: "${name}",
    service,
    routers: [{ path: "/api/${name}", router: create${P}Router(controller) }],
    processors: ${c}Processors,
  };
}
`,
    [`${name}.routes.ts`]: `/* HTTP routes: paths, middleware and validators, then the controller. */
import { Router } from "express";
import type { ${P}Controller } from "./${name}.controller.js";

export function create${P}Router(controller: ${P}Controller): Router {
  const router = Router();
  router.get("/status", controller.status);
  return router;
}
`,
    [`${name}.controller.ts`]: `/* HTTP in and out only; no business logic. */
import type { RequestHandler } from "express";
import type { ${P}Service } from "./${name}.service.js";

export interface ${P}Controller {
  status: RequestHandler;
}

export function create${P}Controller(service: ${P}Service): ${P}Controller {
  return {
    status: async (_req, res) => {
      res.json(await service.status());
    },
  };
}
`,
    [`${name}.service.ts`]: `/* Business rules and transactions. Emits events through the outbox. */
import type { Clock } from "../../core/clock.js";
import type { ${P}Repository } from "./${name}.repository.js";

export interface ${P}Service {
  status(): Promise<{ module: "${name}"; checkedAt: string }>;
}

export function create${P}Service(deps: { repository: ${P}Repository; clock: Clock }): ${P}Service {
  void deps.repository;
  return {
    async status() {
      return { module: "${name}", checkedAt: deps.clock.now().toISOString() };
    },
  };
}
`,
    [`${name}.repository.ts`]: `/* Drizzle queries for this module's own tables only (tables go in schema/). */
import type { DbOrTx } from "../../infra/db/index.js";

export type ${P}Repository = ReturnType<typeof create${P}Repository>;

export function create${P}Repository(db: DbOrTx) {
  void db;
  return {};
}
`,
    "schema/README.md": `Drizzle tables owned by the ${name} module. Only ${name}.repository.ts queries them.\n`,
    "validators/index.ts": `/* Zod request schemas, built from @app/shared. */
import { z } from "zod";

export const ${c}StatusQuery = z.object({});
`,
    "types/index.ts": `/* Internal types of the ${name} module. */
export type ${P}Id = string;
`,
    "events/index.ts": `/* Handlers for events this module consumes (registered via defineEventProcessor). */
import type { EventHandlers } from "../../../infra/outbox/index.js";

export const ${c}EventHandlers: EventHandlers = {};
`,
    "jobs/index.ts": `/* BullMQ processors for this module's jobs. */
import type { JobProcessor } from "../../../infra/queues/index.js";

export const ${c}Processors: JobProcessor[] = [];
`,
    [`__tests__/${name}.service.test.ts`]: `import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../../core/clock.js";
import { create${P}Service } from "../${name}.service.js";

describe("${name} service", () => {
  it("reports its status", async () => {
    const clock = createFakeClock("2026-01-01T00:00:00Z");
    const service = create${P}Service({ repository: {}, clock });
    await expect(service.status()).resolves.toEqual({
      module: "${name}",
      checkedAt: "2026-01-01T00:00:00.000Z",
    });
  });
});
`,
  };
}

export function generateModule({ name, root, calls = [] }: GenerateOptions): string[] {
  if (!NAME.test(name)) throw new Error(`Module names are kebab-case, got "${name}"`);
  const backend = root ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const moduleDir = path.join(backend, "src", "modules", name);
  if (existsSync(moduleDir)) throw new Error(`modules/${name} already exists`);

  const written: string[] = [];
  for (const [file, content] of Object.entries(templates(name))) {
    const target = path.join(moduleDir, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
    written.push(path.relative(backend, target));
  }

  const edgesPath = path.join(backend, "src", "composition", "module-edges.json");
  const edges = JSON.parse(readFileSync(edgesPath, "utf8")) as {
    modules: Record<string, string[]>;
  };
  if (edges.modules[name] === undefined) {
    for (const call of calls) {
      if (edges.modules[call] === undefined) throw new Error(`--calls: unknown module "${call}"`);
    }
    edges.modules[name] = calls;
    writeFileSync(edgesPath, `${JSON.stringify(edges, null, 2)}\n`);
    written.push(path.relative(backend, edgesPath));
  }

  const modulesPath = path.join(backend, "src", "composition", "modules.ts");
  const P = pascal(name);
  const source = readFileSync(modulesPath, "utf8")
    .replace(
      "/* new-module:imports */",
      `import { create${P}Module } from "../modules/${name}/index.js";\n/* new-module:imports */`,
    )
    .replace(
      "  /* new-module:create */",
      `  modules.push(create${P}Module({ infra }));\n  /* new-module:create */`,
    );
  writeFileSync(modulesPath, source);
  written.push(path.relative(backend, modulesPath));
  return written;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const flag = (n: string) => {
    const i = args.indexOf(n);
    return i === -1 ? undefined : args[i + 1];
  };
  const name = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
  if (name === undefined) {
    process.stderr.write("Usage: pnpm new:module <name> [--calls a,b] [--root <backend dir>]\n");
    process.exit(1);
  }
  try {
    const calls = flag("--calls")?.split(",").filter(Boolean);
    const root = flag("--root");
    const files = generateModule({ name, ...(calls ? { calls } : {}), ...(root ? { root } : {}) });
    process.stdout.write(`Created module "${name}":\n${files.map((f) => `  ${f}`).join("\n")}\n`);
    process.stdout.write(
      `Next: add it to PRODUCT.md §7.4 (tables, responsibility, allowed calls).\n`,
    );
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
