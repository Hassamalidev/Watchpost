/* The web app (backend/web) is its own package with its own Vitest config. */
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "web/**", "dist/**", ".arch-selftest/**"],
    globalSetup: ["./src/__tests__/helpers/global-setup.ts"],
  },
});
