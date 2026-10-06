/*
 * Registers a managed probe and prints its credentials once:
 *   pnpm --filter @app/api probe:create --name eu-1 --region eu-central
 * The secret is stored encrypted and never shown again; put the printed lines in the probe's env.
 */
import { REGIONS, type Region } from "@app/shared";
import { loadConfig } from "../src/config/index.js";
import { createContainer } from "../src/composition/container.js";
import type { ProbesModule } from "../src/modules/probes/index.js";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

const name = flag("--name");
const region = flag("--region");
const kind = flag("--kind") ?? "managed";
if (
  !name ||
  !region ||
  !(REGIONS as readonly string[]).includes(region) ||
  (kind !== "managed" && kind !== "private")
) {
  process.stderr.write(
    `Usage: pnpm probe:create --name <name> --region <${REGIONS.join("|")}> [--kind managed|private --workspace <id>]\n`,
  );
  process.exit(1);
}
const workspaceId = flag("--workspace");
if (kind === "private" && !workspaceId) {
  process.stderr.write("Private probes need --workspace <workspace id>\n");
  process.exit(1);
}

const container = createContainer(loadConfig(), { service: "api" });
try {
  const probes = container.modules.find((m) => m.name === "probes") as ProbesModule | undefined;
  if (!probes) throw new Error("probes module is not registered");
  const { id, secret } = await probes.service.register({
    name,
    region: region as Region,
    kind,
    ...(workspaceId ? { workspaceId } : {}),
  });
  process.stdout.write(
    `Probe "${name}" registered. Put these in the probe's environment (shown once):\n\nPROBE_ID=${id}\nPROBE_SECRET=${secret}\nPROBE_REGION=${region}\nPROBE_MODE=${kind}\n`,
  );
} finally {
  await container.close();
}
