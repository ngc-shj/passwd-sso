/**
 * Self-test for scripts/checks/check-critical-audit-atomic.sh — the M1 gate that
 * requires security-critical, single-mutation actions to write their audit via
 * logAuditInTx (atomic with the mutation), not post-commit logAuditAsync.
 *
 * RT7: the gate is red-proven by a fixture whose critical action is written only
 * via logAuditAsync — the exact regression the gate must catch.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GUARD = join(REPO_ROOT, "scripts/checks/check-critical-audit-atomic.sh");

let root;

function runGuard() {
  const r = spawnSync("bash", [GUARD], {
    encoding: "utf8",
    env: { ...process.env, CRITICAL_AUDIT_ATOMIC_ROOT: root },
  });
  return { exitCode: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// Write a minimal route file under src/app/api/<rel> in the fixture root.
function writeRoute(rel, contents) {
  const full = join(root, "src/app/api", rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents, "utf8");
}

const ALL_ACTIONS = [
  "MASTER_KEY_ROTATION_INITIATE",
  "MASTER_KEY_ROTATION_APPROVE",
  "MASTER_KEY_ROTATION_REVOKE",
  "RECOVERY_PASSPHRASE_RESET",
];

function inTxCall(action) {
  return `await logAuditInTx(tx, tenantId, {\n  action: AUDIT_ACTION.${action},\n});\n`;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "critical-audit-atomic-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("check-critical-audit-atomic.sh", () => {
  it("passes when every critical action is written via logAuditInTx", () => {
    ALL_ACTIONS.forEach((a, i) => writeRoute(`crit-${i}/route.ts`, inTxCall(a)));
    const { exitCode, stdout } = runGuard();
    expect(exitCode, stdout).toBe(0);
    expect(stdout).toContain("all 4 security-critical actions");
  });

  it("FAILS when a critical action is only in logAuditAsync (regression)", () => {
    // Three actions atomic; RECOVERY_PASSPHRASE_RESET reverted to async only.
    ALL_ACTIONS.slice(0, 3).forEach((a, i) =>
      writeRoute(`crit-${i}/route.ts`, inTxCall(a)),
    );
    writeRoute(
      "recover/route.ts",
      "await logAuditAsync({\n  action: AUDIT_ACTION.RECOVERY_PASSPHRASE_RESET,\n});\n",
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("AUDIT_ACTION.RECOVERY_PASSPHRASE_RESET is not written via logAuditInTx");
  });

  it("passes against the real repo", () => {
    const r = spawnSync("bash", [GUARD], { encoding: "utf8" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });
});
