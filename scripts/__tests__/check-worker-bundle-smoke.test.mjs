/**
 * Self-test for scripts/checks/check-worker-bundle-smoke.sh — the R32 boot smoke
 * gate that bundles each worker exactly as the Dockerfile does and boots it with
 * --validate-env-only, catching artifacts that crash on load (e.g. the
 * createRequire(import.meta.url) ERR_INVALID_ARG_VALUE that shipped a
 * non-booting retention-gc worker in the 2026-07 review, H2).
 *
 * RT7: a guard is only trustworthy once it is proven able to go RED. The
 * red-proof here injects a runtime-module that crashes on load via the
 * WORKER_BUNDLE_SMOKE_ALIAS_OVERRIDE test hook and asserts the gate fails —
 * the same crash the real fix prevents.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GUARD = join(REPO_ROOT, "scripts/checks/check-worker-bundle-smoke.sh");

function runGuard(extraEnv = {}) {
  const r = spawnSync("bash", [GUARD], {
    encoding: "utf8",
    cwd: REPO_ROOT,
    timeout: 120_000,
    env: { ...process.env, ...extraEnv },
  });
  return { exitCode: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("check-worker-bundle-smoke.sh", () => {
  it("passes against the real repo (both worker bundles boot)", () => {
    const { exitCode, stdout, stderr } = runGuard();
    expect(exitCode, stdout + stderr).toBe(0);
    expect(stdout).toContain("all worker bundles boot with --validate-env-only");
  });

  describe("RT7 red-proof: gate goes RED when a bundled module crashes on load", () => {
    let crashDir;
    let crashModule;

    beforeAll(() => {
      crashDir = mkdtempSync(join(tmpdir(), "worker-smoke-redproof-"));
      crashModule = join(crashDir, "crash-runtime-module.ts");
      // Reproduces the pre-fix bug: createRequire(import.meta.url) throws
      // ERR_INVALID_ARG_VALUE at load time inside an esbuild CJS bundle, where
      // import.meta.url is undefined. Aliased in place of the real
      // runtime-module via the WORKER_BUNDLE_SMOKE_ALIAS_OVERRIDE hook.
      writeFileSync(
        crashModule,
        [
          'import { createRequire } from "node:module";',
          "const requireModule = createRequire(import.meta.url);",
          "export function requireOptionalModule(moduleName) {",
          "  return requireModule(moduleName);",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );
    });

    afterAll(() => {
      rmSync(crashDir, { recursive: true, force: true });
    });

    it("FAILS with a non-zero exit when the retention worker's runtime-module crashes on load", () => {
      const { exitCode, stdout } = runGuard({
        WORKER_BUNDLE_SMOKE_ALIAS_OVERRIDE: `@/lib/blob-store/runtime-module=${crashModule}`,
      });
      expect(exitCode).not.toBe(0);
      expect(stdout).toContain("do not boot as shipped");
    });
  });
});
