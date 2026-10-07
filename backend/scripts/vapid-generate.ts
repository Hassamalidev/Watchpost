/*
 * Prints a new VAPID key pair for web push as the two lines to put in `.env`
 * (`pnpm --filter @app/api vapid:generate`). Changing the pair later makes every device subscribe
 * again, so keep it once it is in use. The private key is a secret.
 */
import { generateVapidKeys } from "../src/infra/webpush.js";

const keys = generateVapidKeys();
process.stdout.write(
  [
    `VAPID_PUBLIC_KEY=${keys.publicKey}`,
    `VAPID_PRIVATE_KEY=${keys.privateKey}`,
    "VAPID_SUBJECT=mailto:you@example.com",
    "",
  ].join("\n"),
);
