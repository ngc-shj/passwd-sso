/**
 * Self-test for scripts/checks/check-ios-no-diagnostic-logging.sh — the CI
 * guard that forbids PSSO_DIAG diagnostic logging and two other reverted
 * crypto/scheme regressions from shipping in ios/**\/*.swift.
 *
 * Driven against a fixture ios/ tree via the IOS_DIAG_GUARD_IOS_DIR env
 * override, mirroring check-permanent-delete-stepup.test.mjs's fixture
 * harness. Only the PSSO_DIAG marker (plan C2's assigned case) is exercised
 * end-to-end; the other two patterns share the same check_pattern() helper
 * so are not independently at risk of a different failure mode.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GUARD = join(REPO_ROOT, "scripts/checks/check-ios-no-diagnostic-logging.sh");

let root;
let iosDir;

function runGuard(extraEnv = {}) {
  const r = spawnSync("bash", [GUARD], {
    encoding: "utf8",
    env: {
      ...process.env,
      IOS_DIAG_GUARD_IOS_DIR: iosDir,
      ...extraEnv,
    },
  });
  return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ios-diag-guard-"));
  iosDir = join(root, "ios");
  mkdirSync(iosDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("check-ios-no-diagnostic-logging.sh", () => {
  it("FAILS on a .swift fixture containing PSSO_DIAG", () => {
    writeFileSync(
      join(iosDir, "Diagnostics.swift"),
      'NSLog("PSSO_DIAG: response body = \\(body)")\n',
      "utf8",
    );
    const { exitCode, stderr } = runGuard();
    expect(exitCode).toBe(1);
    expect(stderr).toContain("FAIL: forbidden iOS pattern (PSSO_DIAG diagnostic logging)");
    expect(stderr).toContain("PSSO_DIAG");
  });

  it("passes on a clean .swift fixture with none of the forbidden patterns", () => {
    writeFileSync(
      join(iosDir, "Client.swift"),
      'let request = URLRequest(url: url)\nrequest.setValue("Bearer \\(accessToken)", forHTTPHeaderField: "Authorization")\n',
      "utf8",
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("iOS diagnostic-logging guard passed.");
  });

  describe("env-pollution guard (sec-F6)", () => {
    it("FAILS when CI=true and an override is set without IOS_DIAG_GUARD_FIXTURE_MODE=1", () => {
      const { exitCode, stderr } = runGuard({ CI: "true" });
      expect(exitCode).toBe(1);
      expect(stderr).toContain("ENV_POLLUTION_GUARD");
    });

    it("passes under CI=true when IOS_DIAG_GUARD_FIXTURE_MODE=1 is set and the fixture tree is clean", () => {
      const { exitCode } = runGuard({ CI: "true", IOS_DIAG_GUARD_FIXTURE_MODE: "1" });
      expect(exitCode).toBe(0);
    });
  });

  describe("real repo (no overrides)", () => {
    it("passes against the actual ios/ tree", () => {
      const r = spawnSync("bash", [GUARD], { encoding: "utf8" });
      expect(r.status, r.stdout + r.stderr).toBe(0);
    });
  });
});
