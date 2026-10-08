/*
 * One run of the sync: read the file, read the workspace, say what would change, and with `apply`
 * change it. Everything it touches comes in as an argument (the file's text, the API, where to
 * print), so the command line, the GitHub Action and the tests all run the same code.
 */
import { ApiError, type Client } from "./client.js";
import { planSync, revisionOf, summarize, type Action } from "./plan.js";
import { parseSpec } from "./spec.js";

export interface RunOptions {
  mode: "plan" | "apply";
  /* Delete managed monitors that are no longer in the file. */
  prune: boolean;
  /* Apply every entry again, also those whose content didn't change. */
  force: boolean;
}

export interface RunResult {
  actions: Action[];
  counts: Record<Action["kind"], number>;
  /* Actions that were attempted and refused, with the reason. */
  failures: Array<{ key: string; message: string }>;
}

const SIGN = { create: "+", update: "~", delete: "-", unchanged: " " } as const;

export async function runSync(
  text: string,
  client: Client,
  options: RunOptions,
  print: (line: string) => void,
): Promise<RunResult> {
  const file = parseSpec(text);
  const me = await client.me();
  if (options.mode === "apply" && !me.scopes.includes("monitors:write")) {
    throw new ApiError(403, "The API key needs the monitors:write scope to apply changes.");
  }
  const actions = planSync(file, await client.monitors(), options);
  const counts = summarize(actions);

  print(`Workspace: ${me.workspaceName}`);
  for (const action of actions) {
    if (action.kind !== "unchanged") print(`  ${SIGN[action.kind]} ${action.key} (${action.name})`);
  }
  print(
    `${options.mode === "plan" ? "Plan" : "Applying"}: ${counts.create} to create, ${counts.update} to update, ${counts.delete} to delete, ${counts.unchanged} unchanged.`,
  );
  const result: RunResult = { actions, counts, failures: [] };
  if (options.mode === "plan") return result;

  const revisions = new Map(file.monitors.map((m) => [m.key, revisionOf(m)]));
  for (const action of actions) {
    try {
      if (action.kind === "create") {
        const made = await client.create(
          action.body,
          `sync-${action.key}-${revisions.get(action.key) ?? ""}`,
        );
        if (action.paused) await client.setPaused(made.id, true);
      } else if (action.kind === "update") {
        await client.update(action.id, action.body);
        if (action.paused !== undefined) await client.setPaused(action.id, action.paused);
      } else if (action.kind === "delete") {
        await client.remove(action.id);
      }
    } catch (err) {
      /* One refused monitor doesn't stop the others; the run still ends as failed. */
      if (!(err instanceof ApiError)) throw err;
      result.failures.push({ key: action.key, message: err.message });
      print(`  ! ${action.key}: ${err.message}`);
    }
  }
  print(
    result.failures.length === 0
      ? "Done."
      : `Done, with ${result.failures.length} monitor${result.failures.length === 1 ? "" : "s"} refused.`,
  );
  return result;
}
