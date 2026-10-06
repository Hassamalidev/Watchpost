/* docs/schemas must match the Zod schemas (P1-T03 AC). Regenerate with `pnpm --filter @app/shared schemas:generate`. */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSON_SCHEMA_EXPORTS } from "../index.js";
import { renderJsonSchema, renderSchemaIndex } from "../schemas/json-schema-render.js";

const DIR = fileURLToPath(new URL("../../../../docs/schemas/", import.meta.url));
const HINT = "stale: run `pnpm --filter @app/shared schemas:generate`";

describe("published JSON Schemas", () => {
  it("has one up-to-date file per exported schema", () => {
    for (const [name, schema] of Object.entries(JSON_SCHEMA_EXPORTS)) {
      const file = path.join(DIR, `${name}.json`);
      expect(existsSync(file), `${name}.json missing: ${HINT}`).toBe(true);
      expect(readFileSync(file, "utf8"), `${name}.json ${HINT}`).toBe(
        renderJsonSchema(name, schema),
      );
    }
  });

  it("has no leftover files and an up-to-date index", () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith(".json"));
    expect(files.sort()).toEqual(
      Object.keys(JSON_SCHEMA_EXPORTS)
        .map((n) => `${n}.json`)
        .sort(),
    );
    expect(readFileSync(path.join(DIR, "README.md"), "utf8")).toBe(
      renderSchemaIndex(Object.keys(JSON_SCHEMA_EXPORTS)),
    );
  });

  it("describes the monitor config as a union on type", () => {
    const schema = JSON.parse(readFileSync(path.join(DIR, "monitor-config.json"), "utf8"));
    const variants = (schema.oneOf ?? schema.anyOf) as Array<{
      properties: { type: { const: string } };
    }>;
    expect(variants.map((v) => v.properties.type.const)).toContain("heartbeat");
  });
});
