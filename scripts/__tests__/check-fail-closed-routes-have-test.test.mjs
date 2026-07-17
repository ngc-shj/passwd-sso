/**
 * Self-test for scripts/checks/check-fail-closed-routes-have-test.sh (AC4.3)
 * — the CI guard requiring every route with `failClosedOnRedisError: true`
 * to have either a sibling test referencing `redisErrored` or a debt entry.
 *
 * Multi-input gate (test-F10, plan C2): the route-scan root (src/app/api)
 * AND the debt file are both read relative to a SINGLE fixture root via
 * FAIL_CLOSED_TEST_ROOT — never per-file overrides — so a fixture route can
 * never end up checked against the real repo's debt file or vice versa.
 * The AC4.4/AC4.5 whole-repo limiter-count invariants are skipped whenever
 * the fixture root is overridden (meaningless against an isolated tree);
 * the "real repo, no overrides" case still exercises them.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GUARD = join(REPO_ROOT, "scripts/checks/check-fail-closed-routes-have-test.sh");

let root;
let apiDir;
let debtFile;

function runGuard(extraEnv = {}) {
  const r = spawnSync("bash", [GUARD], {
    encoding: "utf8",
    env: {
      ...process.env,
      FAIL_CLOSED_TEST_ROOT: root,
      FAIL_CLOSED_TEST_DEBT_FILE: debtFile,
      ...extraEnv,
    },
  });
  return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
}

function writeRoute(rel, body) {
  const dir = join(apiDir, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "route.ts"), body, "utf8");
  return `src/app/api/${rel}/route.ts`;
}

const FAIL_CLOSED_LINE =
  'const limiter = rateLimiter({ failClosedOnRedisError: true });\n';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fail-closed-test-"));
  apiDir = join(root, "src/app/api");
  debtFile = join(root, "scripts/checks/fail-closed-test-debt.txt");
  mkdirSync(apiDir, { recursive: true });
  mkdirSync(dirname(debtFile), { recursive: true });
  writeFileSync(debtFile, "# fixture debt list\n", "utf8");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("check-fail-closed-routes-have-test.sh", () => {
  it("FAILS (MISSING_FAIL_CLOSED_TEST) when an opt-in route has no sibling test and no debt entry", () => {
    const rel = writeRoute("widgets/purge", FAIL_CLOSED_LINE);
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("MISSING_FAIL_CLOSED_TEST:");
    expect(stdout).toContain(rel);
  });

  it("passes when the opt-in route has an adjacent route.test.ts referencing redisErrored", () => {
    writeRoute("widgets/purge", FAIL_CLOSED_LINE);
    writeFileSync(
      join(apiDir, "widgets/purge/route.test.ts"),
      'it("503s on redisErrored", () => { /* redisErrored */ });\n',
      "utf8",
    );
    const { exitCode } = runGuard();
    expect(exitCode).toBe(0);
  });

  it("passes when the opt-in route has a legacy __tests__ sibling referencing redisErrored", () => {
    writeRoute("widgets/purge", FAIL_CLOSED_LINE);
    const altDir = join(root, "src/__tests__/api/widgets");
    mkdirSync(altDir, { recursive: true });
    writeFileSync(
      join(altDir, "purge.test.ts"),
      'it("503s on redisErrored", () => { /* redisErrored */ });\n',
      "utf8",
    );
    const { exitCode } = runGuard();
    expect(exitCode).toBe(0);
  });

  it("passes when the opt-in route is listed in the debt file", () => {
    const rel = writeRoute("widgets/purge", FAIL_CLOSED_LINE);
    writeFileSync(debtFile, `${rel}\n`, "utf8");
    const { exitCode } = runGuard();
    expect(exitCode).toBe(0);
  });

  describe("env-pollution guard (sec-F6)", () => {
    it("FAILS when CI=true and an override is set without FAIL_CLOSED_TEST_FIXTURE_MODE=1", () => {
      const { exitCode, stdout } = runGuard({ CI: "true" });
      expect(exitCode).toBe(1);
      expect(stdout).toContain("ENV_POLLUTION_GUARD");
    });

    it("passes under CI=true when FAIL_CLOSED_TEST_FIXTURE_MODE=1 is set and the fixture tree is clean", () => {
      const { exitCode } = runGuard({ CI: "true", FAIL_CLOSED_TEST_FIXTURE_MODE: "1" });
      expect(exitCode).toBe(0);
    });
  });

  describe("real repo (no overrides)", () => {
    it("passes against the actual repo source tree (incl. AC4.4/AC4.5 counts)", () => {
      const r = spawnSync("bash", [GUARD], { encoding: "utf8" });
      expect(r.status, r.stdout + r.stderr).toBe(0);
    });
  });
});
