/* One migration history for the whole database (PRODUCT.md §7.3). Tables live in module schema/ folders. */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: ["./src/modules/*/schema/*.ts", "./src/infra/*/schema.ts"],
  out: "./drizzle",
  casing: "snake_case",
  strict: true,
  verbose: true,
});
