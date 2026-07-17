/**
 * Self-test for scripts/checks/check-actions-sha-pinned.sh — the CI guard
 * that requires every GitHub Actions workflow `uses:` reference to be
 * SHA-pinned (C23/T13), closing the floating-tag supply-chain risk.
 *
 * Driven against a fixture workflows dir via the
 * ACTIONS_SHA_PINNED_WORKFLOWS_DIR env override (mirrors
 * check-permanent-delete-stepup.test.mjs's fixture harness).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GUARD = join(REPO_ROOT, "scripts/checks/check-actions-sha-pinned.sh");

let root;
let workflowsDir;

function runGuard(extraEnv = {}) {
  const r = spawnSync("bash", [GUARD], {
    encoding: "utf8",
    env: {
      ...process.env,
      ACTIONS_SHA_PINNED_WORKFLOWS_DIR: workflowsDir,
      ...extraEnv,
    },
  });
  return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "actions-sha-pinned-"));
  workflowsDir = join(root, "workflows");
  mkdirSync(workflowsDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("check-actions-sha-pinned.sh", () => {
  it("FAILS (FORBIDDEN) on a floating-tag uses: reference", () => {
    writeFileSync(
      join(workflowsDir, "ci.yml"),
      "jobs:\n  build:\n    steps:\n      - uses: actions/checkout@v4\n",
      "utf8",
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("FORBIDDEN: floating tags in .github/workflows/");
    expect(stdout).toContain("uses: actions/checkout@v4");
  });

  it("passes on a SHA-pinned uses: reference", () => {
    writeFileSync(
      join(workflowsDir, "ci.yml"),
      "jobs:\n  build:\n    steps:\n      - uses: actions/checkout@8f4b7f84864484a7bde6ce6e46eddedd2f9c3e5e  # v4.2.2\n",
      "utf8",
    );
    const { exitCode } = runGuard();
    expect(exitCode).toBe(0);
  });

  it("passes when the workflows dir does not exist", () => {
    rmSync(workflowsDir, { recursive: true, force: true });
    const { exitCode } = runGuard();
    expect(exitCode).toBe(0);
  });

  it("does NOT flag local actions (./) or docker:// references", () => {
    writeFileSync(
      join(workflowsDir, "ci.yml"),
      "jobs:\n  build:\n    steps:\n      - uses: ./local-action\n      - uses: docker://alpine:3\n",
      "utf8",
    );
    const { exitCode } = runGuard();
    expect(exitCode).toBe(0);
  });

  describe("env-pollution guard (sec-F6)", () => {
    it("FAILS when CI=true and an override is set without ACTIONS_SHA_PINNED_FIXTURE_MODE=1", () => {
      const { exitCode, stdout } = runGuard({ CI: "true" });
      expect(exitCode).toBe(1);
      expect(stdout).toContain("ENV_POLLUTION_GUARD");
    });

    it("passes under CI=true when ACTIONS_SHA_PINNED_FIXTURE_MODE=1 is set and the fixture tree is clean", () => {
      writeFileSync(
        join(workflowsDir, "ci.yml"),
        "jobs:\n  build:\n    steps:\n      - uses: actions/checkout@8f4b7f84864484a7bde6ce6e46eddedd2f9c3e5e  # v4.2.2\n",
        "utf8",
      );
      const { exitCode } = runGuard({ CI: "true", ACTIONS_SHA_PINNED_FIXTURE_MODE: "1" });
      expect(exitCode).toBe(0);
    });
  });

  describe("real repo (no overrides)", () => {
    it("passes against the actual .github/workflows tree", () => {
      const r = spawnSync("bash", [GUARD], { encoding: "utf8" });
      expect(r.status, r.stdout + r.stderr).toBe(0);
    });
  });
});
