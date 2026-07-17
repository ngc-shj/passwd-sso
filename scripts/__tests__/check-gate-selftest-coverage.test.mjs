/**
 * Self-test for scripts/checks/check-gate-selftest-coverage.sh — the meta-gate
 * that requires every scripts/checks/ gate (and every inline `run_step
 * "Static: ..." bash -c '...'` gate in pre-pr.sh) to have a sibling self-test
 * or a reasoned debt entry.
 *
 * A regression in the meta-gate's own detection would silently let untested
 * gates land, so it gets fixture-driven RT7 coverage of its own (mirrors
 * check-permanent-delete-stepup.test.mjs's env-override fixture harness).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GUARD = join(REPO_ROOT, "scripts/checks/check-gate-selftest-coverage.sh");

let root;
let checksDir;
let testsDir;
let debtFile;
let preprFile;

/** Run the guard against the fixture tree. */
function runGuard(extraEnv = {}) {
  const r = spawnSync("bash", [GUARD], {
    encoding: "utf8",
    env: {
      ...process.env,
      GATE_SELFTEST_CHECKS_DIR: checksDir,
      GATE_SELFTEST_TESTS_DIR: testsDir,
      GATE_SELFTEST_DEBT_FILE: debtFile,
      GATE_SELFTEST_PREPR_FILE: preprFile,
      // Fixture-mode default so the env-pollution guard does not fire under
      // CI=true; the pollution-guard test overrides it back to "".
      GATE_SELFTEST_FIXTURE_MODE: "1",
      ...extraEnv,
    },
  });
  return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gate-selftest-"));
  checksDir = join(root, "checks");
  testsDir = join(root, "tests");
  debtFile = join(root, "gate-selftest-debt.txt");
  preprFile = join(root, "pre-pr.sh");
  mkdirSync(checksDir, { recursive: true });
  mkdirSync(testsDir, { recursive: true });
  writeFileSync(debtFile, "# fixture debt list\n", "utf8");
  writeFileSync(preprFile, "#!/usr/bin/env bash\nset -euo pipefail\n", "utf8");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("check-gate-selftest-coverage.sh", () => {
  it("FAILS (MISSING_GATE_SELFTEST) when a check has no test and no debt entry", () => {
    writeFileSync(join(checksDir, "check-foo.sh"), "#!/usr/bin/env bash\nexit 0\n", "utf8");
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("MISSING_GATE_SELFTEST: scripts/checks/check-foo.sh");
  });

  it("passes when a check has a sibling .test.mjs", () => {
    writeFileSync(join(checksDir, "check-foo.sh"), "#!/usr/bin/env bash\nexit 0\n", "utf8");
    writeFileSync(join(testsDir, "check-foo.test.mjs"), "// fixture test\n", "utf8");
    const { exitCode } = runGuard();
    expect(exitCode).toBe(0);
  });

  it("passes when a .mjs check has a sibling .test.ts", () => {
    writeFileSync(join(checksDir, "check-bar.mjs"), "// fixture check\n", "utf8");
    writeFileSync(join(testsDir, "check-bar.test.ts"), "// fixture test\n", "utf8");
    const { exitCode } = runGuard();
    expect(exitCode).toBe(0);
  });

  it("passes when a check has a reasoned debt entry instead of a test", () => {
    writeFileSync(join(checksDir, "check-foo.sh"), "#!/usr/bin/env bash\nexit 0\n", "utf8");
    writeFileSync(
      debtFile,
      "scripts/checks/check-foo.sh  # reason: non-security scope, test debt\n",
      "utf8",
    );
    const { exitCode } = runGuard();
    expect(exitCode).toBe(0);
  });

  it("FAILS (DEBT_ENTRY_WITHOUT_REASON) when a debt entry has no reason", () => {
    writeFileSync(join(checksDir, "check-foo.sh"), "#!/usr/bin/env bash\nexit 0\n", "utf8");
    writeFileSync(debtFile, "scripts/checks/check-foo.sh\n", "utf8");
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("DEBT_ENTRY_WITHOUT_REASON");
  });

  it("FAILS (DEBT_ENTRY_WITHOUT_REASON) when a debt entry's reason is too short", () => {
    writeFileSync(join(checksDir, "check-foo.sh"), "#!/usr/bin/env bash\nexit 0\n", "utf8");
    writeFileSync(debtFile, "scripts/checks/check-foo.sh  # x\n", "utf8");
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("DEBT_ENTRY_WITHOUT_REASON");
  });

  it("FAILS (STALE_DEBT_ENTRY) when a debt entry names a check that no longer exists", () => {
    writeFileSync(
      debtFile,
      "scripts/checks/check-does-not-exist.sh  # reason: stale placeholder entry\n",
      "utf8",
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("STALE_DEBT_ENTRY: scripts/checks/check-does-not-exist.sh");
  });

  it("FAILS (STALE_DEBT_ENTRY) when a debt-listed check has SINCE gained a sibling test", () => {
    // The check still exists AND is debt-listed, but a sibling self-test was
    // since added — the test now satisfies coverage, so the debt exemption is
    // stale and must be removed (otherwise debt never shrinks and a later test
    // deletion would be masked by the lingering entry). External-review Low.
    writeFileSync(join(checksDir, "check-foo.sh"), "#!/usr/bin/env bash\nexit 0\n", "utf8");
    writeFileSync(join(testsDir, "check-foo.test.mjs"), "// fixture test\n", "utf8");
    writeFileSync(
      debtFile,
      "scripts/checks/check-foo.sh  # reason: was untested, debt entry now stale\n",
      "utf8",
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain(
      "STALE_DEBT_ENTRY: scripts/checks/check-foo.sh (a sibling self-test now exists",
    );
  });

  it("passes when fully covered: mixed tested + debt-listed checks", () => {
    writeFileSync(join(checksDir, "check-foo.sh"), "#!/usr/bin/env bash\nexit 0\n", "utf8");
    writeFileSync(join(testsDir, "check-foo.test.mjs"), "// fixture test\n", "utf8");
    writeFileSync(join(checksDir, "check-bar.mjs"), "// fixture check\n", "utf8");
    writeFileSync(
      debtFile,
      "scripts/checks/check-bar.mjs  # reason: non-security scope, test debt\n",
      "utf8",
    );
    const { exitCode } = runGuard();
    expect(exitCode).toBe(0);
  });

  describe("inline pre-pr.sh Static: bash -c gates", () => {
    it("FAILS (MISSING_GATE_SELFTEST) when an inline Static: bash -c gate has no debt entry", () => {
      writeFileSync(
        preprFile,
        `#!/usr/bin/env bash\nrun_step "Static: my-inline-gate" bash -c '\n  exit 0\n'\n`,
        "utf8",
      );
      const { exitCode, stdout } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout).toContain("MISSING_GATE_SELFTEST: pre-pr:Static: my-inline-gate");
    });

    it("passes when an inline Static: bash -c gate has a reasoned debt entry", () => {
      writeFileSync(
        preprFile,
        `#!/usr/bin/env bash\nrun_step "Static: my-inline-gate" bash -c '\n  exit 0\n'\n`,
        "utf8",
      );
      writeFileSync(
        debtFile,
        "pre-pr:Static: my-inline-gate  # reason: inline gate, extraction deferred (SC7)\n",
        "utf8",
      );
      const { exitCode } = runGuard();
      expect(exitCode).toBe(0);
    });

    it("FAILS (STALE_DEBT_ENTRY) when a pre-pr: debt entry names an inline gate that no longer exists", () => {
      writeFileSync(debtFile, "pre-pr:Static: long-gone-gate  # reason: stale placeholder\n", "utf8");
      const { exitCode, stdout } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout).toContain("STALE_DEBT_ENTRY: pre-pr:Static: long-gone-gate");
    });

    it("does NOT require a debt entry for a non-Static: inline bash -c step (build/test orchestration)", () => {
      writeFileSync(
        preprFile,
        `#!/usr/bin/env bash\nrun_step "CLI: Build" bash -c '\n  cd cli && npm run build\n'\n`,
        "utf8",
      );
      const { exitCode } = runGuard();
      expect(exitCode).toBe(0);
    });

    it("does NOT require a debt entry for a Static: gate that targets a script file (not inline bash -c)", () => {
      writeFileSync(join(checksDir, "check-foo.sh"), "#!/usr/bin/env bash\nexit 0\n", "utf8");
      writeFileSync(join(testsDir, "check-foo.test.mjs"), "// fixture test\n", "utf8");
      writeFileSync(
        preprFile,
        `#!/usr/bin/env bash\nrun_step "Static: foo" bash scripts/checks/check-foo.sh\n`,
        "utf8",
      );
      const { exitCode } = runGuard();
      expect(exitCode).toBe(0);
    });
  });

  describe("env-pollution guard (sec-F6)", () => {
    it("FAILS when CI=true and an override is set without GATE_SELFTEST_FIXTURE_MODE=1", () => {
      const { exitCode, stdout } = runGuard({ CI: "true", GATE_SELFTEST_FIXTURE_MODE: "" });
      expect(exitCode).toBe(1);
      expect(stdout).toContain("ENV_POLLUTION_GUARD");
    });

    it("passes under CI=true when GATE_SELFTEST_FIXTURE_MODE=1 is set and the fixture tree is fully covered", () => {
      const { exitCode } = runGuard({ CI: "true", GATE_SELFTEST_FIXTURE_MODE: "1" });
      expect(exitCode).toBe(0);
    });
  });
});
