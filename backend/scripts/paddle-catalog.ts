/*
 * Creates the Paddle products, prices and founding discount (PRODUCT.md §11 "Catalog"):
 *   pnpm --filter @app/api paddle:catalog            (sandbox, the default PADDLE_ENV)
 *   pnpm --filter @app/api paddle:catalog --live     (required when PADDLE_ENV=production)
 * Safe to re-run: objects are found by `custom_data.key` and only missing ones are created. Prints
 * the PADDLE_PRICE_* lines for .env. Creating catalog objects costs nothing.
 */
import { loadConfig } from "../src/config/index.js";
import { createSdkCatalogClient, syncCatalog } from "../src/infra/paddle/catalog.js";

const config = loadConfig();
if (config.paddle === undefined) {
  process.stderr.write(
    "Set PADDLE_API_KEY and PADDLE_WEBHOOK_SECRET in .env first (see ENV_SETUP.md).\n",
  );
  process.exit(1);
}
if (config.paddle.environment === "production" && !process.argv.includes("--live")) {
  process.stderr.write(
    "PADDLE_ENV=production: this would create the LIVE catalog. Re-run with --live to confirm.\n",
  );
  process.exit(1);
}

const { env, created } = await syncCatalog(
  createSdkCatalogClient({ apiKey: config.paddle.apiKey, environment: config.paddle.environment }),
);
process.stdout.write(
  `Paddle ${config.paddle.environment} catalog: ${
    created.length === 0 ? "already complete" : `created ${created.join(", ")}`
  }.\n\nPut these in .env:\n\n${Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`,
);
