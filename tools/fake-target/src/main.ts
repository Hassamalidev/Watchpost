/* Entry point: `pnpm --filter @app/fake-target dev` locally, or the fake-target compose service. */
import { loadConfig } from "./config.js";
import { startServers } from "./servers.js";

const config = loadConfig();
const running = await startServers(config);

process.stdout.write(
  `fake-target: http ${running.httpPort} (ws at /ws), tls ${running.tlsPort} ` +
    `(cert expires ${running.certNotAfter.toISOString()}), tcp echo ${running.tcpPort}\n`,
);

async function shutdown(): Promise<void> {
  await running.close();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
