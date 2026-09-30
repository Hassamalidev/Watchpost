/* Pure rendering of Zod schemas to JSON Schema text, shared by the generator and its staleness test. */
import { z } from "zod";

/* Input shape: fields with defaults are optional, which is what API clients and probes send. */
export function renderJsonSchema(name: string, schema: z.ZodType): string {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
  /* URN, not a URL: the product domain isn't chosen yet (Open decision #1). */
  return `${JSON.stringify({ $id: `urn:watchpost:schema:${name}`, title: name, ...json }, null, 2)}\n`;
}

export function renderSchemaIndex(names: readonly string[]): string {
  const rows = [...names].sort().map((n) => `- [${n}](./${n}.json)`);
  return [
    "# JSON Schemas",
    "",
    "Generated from the Zod schemas in `@app/shared` (`packages/shared/src/schemas/json-schema-exports.ts`).",
    "Do not edit by hand: run `pnpm --filter @app/shared schemas:generate`. A test fails when these are stale.",
    "",
    ...rows,
    "",
  ].join("\n");
}
