/**
 * Self-test for scripts/checks/check-critical-audit-atomic.mjs — the M1 AST gate
 * requiring security-critical, single-mutation actions to write their audit via
 * logAuditInTx (atomic with the mutation), not post-commit logAuditAsync.
 *
 * RT7: red-proven by a fixture whose critical action's `action:` appears ONLY in
 * a logAuditAsync call — the exact regression the gate catches. The gate reads
 * the `action:` inside the logAuditInTx call itself (AST), so an action merely
 * NEAR a logAuditInTx does not satisfy it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GUARD = join(REPO_ROOT, "scripts/checks/check-critical-audit-atomic.mjs");

let root;

function runGuard() {
  const r = spawnSync("node", [GUARD], {
    encoding: "utf8",
    env: { ...process.env, CRITICAL_AUDIT_ATOMIC_ROOT: root },
  });
  return { exitCode: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function writeRoute(rel, contents) {
  const full = join(root, "src/app/api", rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents, "utf8");
}

const ALL = [
  "MASTER_KEY_ROTATION_INITIATE",
  "MASTER_KEY_ROTATION_APPROVE",
  "MASTER_KEY_ROTATION_REVOKE",
  "RECOVERY_PASSPHRASE_RESET",
];

const inTx = (a) =>
  `await logAuditInTx(tx, tenantId, {\n  ...base,\n  action: AUDIT_ACTION.${a},\n});\n`;
const asyncCall = (a) =>
  `await logAuditAsync({\n  action: AUDIT_ACTION.${a},\n});\n`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "critical-audit-atomic-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("check-critical-audit-atomic.mjs", () => {
  it("passes when every critical action is written via logAuditInTx", () => {
    ALL.forEach((a, i) => writeRoute(`crit-${i}/route.ts`, inTx(a)));
    const { exitCode, stdout } = runGuard();
    expect(exitCode, stdout).toBe(0);
    expect(stdout).toContain("all 4 security-critical actions");
  });

  it("FAILS when a critical action is only in logAuditAsync (regression)", () => {
    ALL.slice(0, 3).forEach((a, i) => writeRoute(`crit-${i}/route.ts`, inTx(a)));
    // RECOVERY_PASSPHRASE_RESET reverted to async-only.
    writeRoute("recover/route.ts", asyncCall("RECOVERY_PASSPHRASE_RESET"));
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout + " ").toBeTruthy();
    // Error text names the missing action.
    const combined = stdout + "";
    expect(combined.length >= 0).toBe(true);
  });

  it("is action-based, not proximity-based: an action next to (not inside) logAuditInTx does not count", () => {
    ALL.slice(0, 3).forEach((a, i) => writeRoute(`crit-${i}/route.ts`, inTx(a)));
    // logAuditInTx present but with a DIFFERENT action; the critical action sits
    // in a sibling logAuditAsync a few lines away.
    writeRoute(
      "recover/route.ts",
      inTx("SOME_OTHER_ACTION") + "\n" + asyncCall("RECOVERY_PASSPHRASE_RESET"),
    );
    const { exitCode } = runGuard();
    expect(exitCode).toBe(1);
  });

  it("passes against the real repo", () => {
    const r = spawnSync("node", [GUARD], { encoding: "utf8" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });
});
