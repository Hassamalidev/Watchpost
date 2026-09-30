/*
 * Architecture rules enforced in CI by `pnpm arch` (PRODUCT.md §7.13).
 * Module edges come from backend/src/composition/module-edges.json, the same file architecture.ts
 * types, so the enforced graph and the declared graph cannot drift apart.
 */
const { modules: EDGES } = require("./backend/src/composition/module-edges.json");

const MODULES = "^backend/src/modules/";
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* One rule per module: it may import only itself and the modules §7.4 lists for it. */
const moduleEdgeRules = Object.entries(EDGES)
  .filter(([, allowed]) => !allowed.includes("*"))
  .map(([name, allowed]) => ({
    name: `module-edge:${name}`,
    severity: "error",
    comment: `modules/${name} may only call: ${allowed.length ? allowed.join(", ") : "(nothing)"} (PRODUCT.md §7.4)`,
    from: { path: `${MODULES}${escape(name)}/` },
    to: {
      path: `${MODULES}[^/]+/`,
      pathNot: `${MODULES}(${[name, ...allowed].map(escape).join("|")})/`,
    },
  }));

const PROVIDER_SDKS = "/(@paddle|@anthropic-ai|resend|twilio|@aws-sdk|@slack|web-push|@microsoft)/";

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "The dependency graph has no cycles (PRODUCT.md §7.4).",
      from: {},
      to: { circular: true },
    },
    {
      name: "module-public-api-only",
      severity: "error",
      comment:
        "Other modules are reached only through modules/<name>/index.ts (PRODUCT.md §7.1 rule 3).",
      from: { path: `${MODULES}([^/]+)/` },
      to: {
        path: `${MODULES}[^/]+/`,
        pathNot: [`${MODULES}$1/`, `${MODULES}[^/]+/index\\.ts$`],
      },
    },
    ...moduleEdgeRules,
    {
      name: "lower-layers-never-import-modules",
      severity: "error",
      comment:
        "core, config, infra and middleware never import modules; middleware gets functions from the container (§7.3).",
      from: { path: "^backend/src/(core|config|infra|middleware)/" },
      to: { path: `${MODULES}` },
    },
    {
      name: "core-is-pure",
      severity: "error",
      comment: "core holds types and pure helpers with no I/O (§7.3).",
      from: { path: "^backend/src/core/", pathNot: "__tests__/" },
      to: { path: "^backend/src/(infra|middleware|composition|config)/" },
    },
    {
      name: "drizzle-only-in-repositories",
      severity: "error",
      comment: "drizzle-orm only in *.repository.ts, schema/ and infra/db (§7.13).",
      from: {
        path: "^backend/src/",
        pathNot: [
          "\\.repository\\.ts$",
          "/schema/",
          "/schema\\.ts$",
          "^backend/src/infra/db/",
          "__tests__/",
        ],
      },
      to: { path: "/drizzle-orm/" },
    },
    {
      name: "provider-sdks-behind-adapters",
      severity: "error",
      comment: "Provider SDKs only in infra/ and modules/channels/adapters/ (§7.1 rule 12).",
      from: {
        path: "^backend/src/",
        pathNot: ["^backend/src/infra/", "^backend/src/modules/channels/adapters/"],
      },
      to: { path: PROVIDER_SDKS },
    },
    {
      name: "shared-is-pure",
      severity: "error",
      comment: "@app/shared imports nothing except zod: no Node APIs, no I/O (§7.1 rule 10).",
      from: { path: "^packages/shared/src/", pathNot: "__tests__/" },
      to: {
        dependencyTypesNot: ["local"],
        pathNot: "/zod/",
      },
    },
    {
      name: "web-is-an-api-client",
      severity: "error",
      comment:
        "backend/web imports only @app/shared from our packages; it never touches backend code (§7.1 rule 11).",
      from: { path: "^backend/web/" },
      to: { path: "^(backend/src|probe|tools)/" },
    },
    {
      name: "probe-never-imports-backend",
      severity: "error",
      comment: "The probe imports only @app/shared (§7.6).",
      from: { path: "^probe/" },
      to: { path: "^backend/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: {
      path: "(^|/)(node_modules|dist|\\.next|coverage|\\.turbo|\\.arch-selftest|playwright-report|test-results)/",
    },
    tsPreCompilationDeps: true,
    /* Absolute, so the tsconfig's relative "extends" resolves correctly. */
    tsConfig: { fileName: require("node:path").join(__dirname, "backend", "tsconfig.json") },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
