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

// Must match CRITICAL_ACTIONS in the gate.
const ALL = [
  "MASTER_KEY_ROTATION_INITIATE",
  "MASTER_KEY_ROTATION_APPROVE",
  "MASTER_KEY_ROTATION_REVOKE",
  "MASTER_KEY_ROTATION_EXECUTE",
  "RECOVERY_PASSPHRASE_RESET",
  "VAULT_RESET_EXECUTED",
  "ADMIN_VAULT_RESET_EXECUTE",
  "EMERGENCY_ACCESS_ACTIVATE",
  // scim-team-admission-approval-plan.md C4.
  "TEAM_MEMBER_SCIM_APPROVE",
  "TEAM_MEMBER_SCIM_REJECT",
  "TEAM_MEMBER_SCIM_PENDING",
  "TEAM_MEMBER_SCIM_PENDING_WITHDRAW",
  "TEAM_MEMBER_SCIM_REMOVE",
  "TEAM_MEMBER_SCIM_ROLE_UPDATE",
  "TEAM_MEMBER_KEY_DISTRIBUTE",
  "SCIM_GROUP_MAPPING_CREATE",
];

const inTx = (a) =>
  `await logAuditInTx(tx, tenantId, {\n  ...base,\n  action: AUDIT_ACTION.${a},\n});\n`;
// Atomic-audit descriptor form (delegated to a shared helper).
const descriptor = (a) =>
  `await executeVaultReset(userId, {\n  tenantId,\n  params: {\n    action: AUDIT_ACTION.${a},\n    metadata: { phase: "committed" },\n  },\n});\n`;
const asyncCall = (a) =>
  `await logAuditAsync({\n  action: AUDIT_ACTION.${a},\n});\n`;
// logAuditBulkInTx forms (C4): an array literal of object literals, or a
// `.map` call whose arrow callback returns one (parenthesised body).
const bulkArray = (a) =>
  `await logAuditBulkInTx(tx, tenantId, [\n  { ...base, action: AUDIT_ACTION.${a} },\n]);\n`;
const bulkMap = (a) =>
  `await logAuditBulkInTx(tx, tenantId, items.map((item) => ({\n  ...base,\n  action: AUDIT_ACTION.${a},\n})));\n`;
const bulkAsync = (a) =>
  `await logAuditBulkAsync(tx, tenantId, [\n  { ...base, action: AUDIT_ACTION.${a} },\n]);\n`;
const bulkTernary = (a, b) =>
  `await logAuditBulkInTx(tx, tenantId, items.map((item) => ({\n  ...base,\n  action: item.flag ? AUDIT_ACTION.${a} : AUDIT_ACTION.${b},\n})));\n`;
const bulkSpreadOfMap = (a) =>
  `await logAuditBulkInTx(tx, tenantId, [\n  ...items.map((item) => ({ ...base, action: AUDIT_ACTION.${a} })),\n]);\n`;

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
    expect(stdout).toContain("all 16 security-critical actions");
  });

  it("recognizes an action written via an atomic-audit descriptor (delegated to a helper)", () => {
    // All but one via logAuditInTx; the last via the { params: { action } }
    // descriptor passed to a shared helper (executeVaultReset).
    ALL.slice(0, -1).forEach((a, i) => writeRoute(`crit-${i}/route.ts`, inTx(a)));
    writeRoute("vault/reset/route.ts", descriptor(ALL[ALL.length - 1]));
    const { exitCode, stdout } = runGuard();
    expect(exitCode, stdout).toBe(0);
  });

  it("FAILS when a critical action is only in logAuditAsync (regression)", () => {
    // All but the last via logAuditInTx; the last reverted to async-only.
    ALL.slice(0, -1).forEach((a, i) => writeRoute(`crit-${i}/route.ts`, inTx(a)));
    const reverted = ALL[ALL.length - 1];
    writeRoute("recover/route.ts", asyncCall(reverted));
    const { exitCode, stdout, stderr } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout + stderr).toContain(reverted);
  });

  it("is action-based, not proximity-based: an action next to (not inside) logAuditInTx does not count", () => {
    ALL.slice(0, -1).forEach((a, i) => writeRoute(`crit-${i}/route.ts`, inTx(a)));
    const reverted = ALL[ALL.length - 1];
    // logAuditInTx present but with a DIFFERENT action; the critical action sits
    // in a sibling logAuditAsync a few lines away.
    writeRoute(
      "recover/route.ts",
      inTx("SOME_OTHER_ACTION") + "\n" + asyncCall(reverted),
    );
    const { exitCode } = runGuard();
    expect(exitCode).toBe(1);
  });

  describe("logAuditBulkInTx (C4: SCIM team admission approval)", () => {
    it("passes with the last critical action via a bulk array literal", () => {
      ALL.slice(0, -1).forEach((a, i) => writeRoute(`crit-${i}/route.ts`, inTx(a)));
      writeRoute("scim/bulk-array/route.ts", bulkArray(ALL[ALL.length - 1]));
      const { exitCode, stdout } = runGuard();
      expect(exitCode, stdout).toBe(0);
    });

    it("passes with the last critical action via a bulk .map call", () => {
      ALL.slice(0, -1).forEach((a, i) => writeRoute(`crit-${i}/route.ts`, inTx(a)));
      writeRoute("scim/bulk-map/route.ts", bulkMap(ALL[ALL.length - 1]));
      const { exitCode, stdout } = runGuard();
      expect(exitCode, stdout).toBe(0);
    });

    it("FAILS (missing-action) when the last critical action has no bulk call either", () => {
      ALL.slice(0, -1).forEach((a, i) => writeRoute(`crit-${i}/route.ts`, inTx(a)));
      const { exitCode, stdout, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout + stderr).toContain(ALL[ALL.length - 1]);
    });

    it("FAILS (missing-action) when the bulk array literal writes an already-present action instead", () => {
      ALL.slice(0, -1).forEach((a, i) => writeRoute(`crit-${i}/route.ts`, inTx(a)));
      writeRoute("scim/bulk-array/route.ts", bulkArray(ALL[0]));
      const { exitCode, stdout, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout + stderr).toContain(ALL[ALL.length - 1]);
    });

    it("FAILS (missing-action) when the bulk .map writes an already-present action instead", () => {
      ALL.slice(0, -1).forEach((a, i) => writeRoute(`crit-${i}/route.ts`, inTx(a)));
      writeRoute("scim/bulk-map/route.ts", bulkMap(ALL[0]));
      const { exitCode, stdout, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout + stderr).toContain(ALL[ALL.length - 1]);
    });

    it("FAILS with the refusal message on a ternary action in a bulk .map, even when every critical action is otherwise present", () => {
      ALL.forEach((a, i) => writeRoute(`crit-${i}/route.ts`, inTx(a)));
      writeRoute("scim/bulk-ternary/route.ts", bulkTernary(ALL[0], ALL[1]));
      const { exitCode, stdout, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout + stderr).toMatch(/REFUSED.*not a literal AUDIT_ACTION/);
    });

    it("refuses a spread of .map() inside a bulk array literal", () => {
      ALL.forEach((a, i) => writeRoute(`crit-${i}/route.ts`, inTx(a)));
      writeRoute("scim/bulk-spread/route.ts", bulkSpreadOfMap(ALL[0]));
      const { exitCode, stdout, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout + stderr).toMatch(/REFUSED.*spread of a \.map\(\)/);
    });

    it("does not count logAuditBulkAsync toward the atomic action set", () => {
      ALL.slice(0, -1).forEach((a, i) => writeRoute(`crit-${i}/route.ts`, inTx(a)));
      writeRoute("scim/bulk-async/route.ts", bulkAsync(ALL[ALL.length - 1]));
      const { exitCode, stdout, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout + stderr).toContain(ALL[ALL.length - 1]);
    });
  });

  it("passes against the real repo", () => {
    const r = spawnSync("node", [GUARD], { encoding: "utf8" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });
});
