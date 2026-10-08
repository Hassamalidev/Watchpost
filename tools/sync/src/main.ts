/*
 * Command line and GitHub Action entry.
 *
 *   monitoring-sync plan  --file monitoring.yml
 *   monitoring-sync apply --file monitoring.yml [--prune] [--force]
 *
 * The API key comes from MONITORING_API_KEY and the address from MONITORING_URL (never from
 * arguments, which end up in logs and shell history). As an action, the inputs arrive as INPUT_*
 * variables. Exit codes: 0 fine, 1 failed, and with `plan --detailed-exitcode` 2 when there is
 * something to change.
 */
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ApiError, createClient, type Fetch } from "./client.js";
import { runSync } from "./run.js";
import { SpecError } from "./spec.js";

const USAGE = `Usage: monitoring-sync <plan|apply> --file <path> [--prune] [--force] [--detailed-exitcode]
Environment: MONITORING_API_KEY (required), MONITORING_URL (required, for example https://app.example.com)`;

export interface Invocation {
  mode: "plan" | "apply";
  file: string;
  prune: boolean;
  force: boolean;
  detailedExitCode: boolean;
  apiKey: string;
  url: string;
}

const truthy = (value: string | undefined) => value === "true" || value === "1";

/* Arguments win over the action's inputs, so the same file serves both ways of running it. */
export function readInvocation(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): Invocation | string {
  const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
  const fileIndex = argv.indexOf("--file");
  const mode = argv.find((arg) => arg === "plan" || arg === "apply") ?? env.INPUT_MODE;
  const file = (fileIndex === -1 ? undefined : argv[fileIndex + 1]) ?? env.INPUT_FILE;
  const apiKey = env.MONITORING_API_KEY ?? env["INPUT_API-KEY"];
  const url = env.MONITORING_URL ?? env.INPUT_URL;
  if (mode !== "plan" && mode !== "apply") return "Say what to do: plan or apply.";
  if (file === undefined || file === "") return "Say which file: --file <path>.";
  if (apiKey === undefined || apiKey === "") return "MONITORING_API_KEY is not set.";
  if (url === undefined || !/^https?:\/\//.test(url))
    return "MONITORING_URL is not set to an http(s) address.";
  return {
    mode,
    file,
    prune: flags.has("--prune") || truthy(env.INPUT_PRUNE),
    force: flags.has("--force") || truthy(env.INPUT_FORCE),
    detailedExitCode: flags.has("--detailed-exitcode"),
    apiKey,
    url,
  };
}

export async function main(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  io: {
    print: (line: string) => void;
    readFile: (path: string) => Promise<string>;
    fetch: Fetch;
  },
): Promise<number> {
  const invocation = readInvocation(argv, env);
  if (typeof invocation === "string") {
    io.print(invocation);
    io.print(USAGE);
    return 1;
  }
  try {
    const text = await io.readFile(invocation.file);
    const client = createClient({
      baseUrl: invocation.url,
      apiKey: invocation.apiKey,
      fetch: io.fetch,
    });
    const result = await runSync(text, client, invocation, io.print);
    if (result.failures.length > 0) return 1;
    const changes = result.counts.create + result.counts.update + result.counts.delete;
    return invocation.mode === "plan" && invocation.detailedExitCode && changes > 0 ? 2 : 0;
  } catch (err) {
    if (err instanceof SpecError || err instanceof ApiError) {
      io.print(err.message);
      return 1;
    }
    io.print(err instanceof Error ? `Failed: ${err.message}` : "Failed.");
    return 1;
  }
}

/* True when this file is the program that was started, not something a test imported. */
function startedDirectly(): boolean {
  const started = process.argv[1];
  if (started === undefined) return false;
  try {
    return realpathSync(started) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (startedDirectly()) {
  process.exitCode = await main(process.argv.slice(2), process.env, {
    print: (line) => void process.stdout.write(`${line}\n`),
    readFile: (path) => readFile(path, "utf8"),
    fetch: (url, init) => fetch(url, init),
  });
}
