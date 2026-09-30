/* Booting with a bad environment must fail fast with a message that names each problem. */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const backendDir = fileURLToPath(new URL("../../", import.meta.url));

describe("server boot", () => {
  it("exits 1 and names the invalid variables", { timeout: 30_000 }, () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: backendDir,
      encoding: "utf8",
      timeout: 25_000,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        NODE_ENV: "production",
        WEB_ORIGIN: "not-a-url",
        REDIS_URL: "redis://localhost:6379",
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Invalid environment configuration");
    expect(result.stderr).toContain("DATABASE_URL: is required");
    expect(result.stderr).toContain("WEB_ORIGIN:");
    expect(result.stderr).toContain(".env.example");
  });
});
