/*
 * `pnpm arch`: runs the dependency-cruiser rules in .dependency-cruiser.cjs (PRODUCT.md §7.13).
 * Each project is cruised with its own tsconfig so path aliases (the web app's "@/") resolve.
 * Exported for tests, which run the same rules against fixture trees via `baseDir`.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cruise, format } from "dependency-cruiser";
import extractTSConfig from "dependency-cruiser/config-utl/extract-ts-config";

const require = createRequire(import.meta.url);
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = require(path.join(REPO_ROOT, ".dependency-cruiser.cjs"));

export const DEFAULT_PROJECTS = [
  { files: ["backend/src", "packages/shared/src", "probe/src"], tsConfig: "backend/tsconfig.json" },
  { files: ["backend/web"], tsConfig: "backend/web/tsconfig.json" },
];

/* Returns every rule violation (errors and warnings) plus a formatted report. */
export async function checkArchitecture({ baseDir = REPO_ROOT, projects = DEFAULT_PROJECTS } = {}) {
  const violations = [];
  const reports = [];
  let modules = 0;
  for (const project of projects) {
    const tsConfigPath = path.join(baseDir, project.tsConfig);
    const result = await cruise(
      project.files,
      {
        ...config.options,
        baseDir,
        validate: true,
        ruleSet: { forbidden: config.forbidden },
        tsConfig: { fileName: tsConfigPath },
      },
      undefined,
      { tsConfig: extractTSConfig(tsConfigPath) },
    );
    const output = result.output;
    modules += output.summary.totalCruised;
    violations.push(...output.summary.violations);
    reports.push((await format(output, { outputType: "err" })).output);
  }
  return { violations, modules, report: reports.join("\n") };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { violations, modules, report } = await checkArchitecture();
  process.stdout.write(report.trim() ? `${report}\n` : "");
  if (violations.length > 0) {
    process.stderr.write(`\n${violations.length} architecture violation(s). See PRODUCT.md §7.\n`);
    process.exit(1);
  }
  process.stdout.write(`architecture ok: ${modules} modules checked\n`);
}
