/*
 * Writes docs/schemas/*.json from JSON_SCHEMA_EXPORTS (P1-T03): `pnpm --filter @app/shared schemas:generate`.
 * A test fails when these files are stale, so regenerate after changing a schema.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSON_SCHEMA_EXPORTS } from "../src/schemas/json-schema-exports.js";
import { renderJsonSchema, renderSchemaIndex } from "../src/schemas/json-schema-render.js";

export const SCHEMA_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs/schemas",
);

mkdirSync(SCHEMA_DIR, { recursive: true });
for (const file of readdirSync(SCHEMA_DIR)) {
  if (file.endsWith(".json")) rmSync(path.join(SCHEMA_DIR, file));
}
for (const [name, schema] of Object.entries(JSON_SCHEMA_EXPORTS)) {
  writeFileSync(path.join(SCHEMA_DIR, `${name}.json`), renderJsonSchema(name, schema));
}
writeFileSync(
  path.join(SCHEMA_DIR, "README.md"),
  renderSchemaIndex(Object.keys(JSON_SCHEMA_EXPORTS)),
);
process.stdout.write(`wrote ${Object.keys(JSON_SCHEMA_EXPORTS).length} schemas to ${SCHEMA_DIR}\n`);
