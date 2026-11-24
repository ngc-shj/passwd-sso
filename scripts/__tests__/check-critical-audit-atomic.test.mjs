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
  "VAULT_PASSPHRASE_CHANGE",
  "RECOVERY_KEY_CREATED",
  "RECOVERY_KEY_REGENERATED",
  "VAULT_RESET_EXECUTED",
  "ADMIN_VAULT_RESET_EXECUTE",
  "EMERGENCY_ACCESS_ACTIVATE",
  // scim-team-admission-approval-plan.md C4.
  "TEAM_MEMBER_SCIM_APPROVE",
  "TEAM_MEMBER_SCIM_REJECT",
  "TEAM_MEMBER_INVITE_ACCEPT",
  "TEAM_MEMBER_INVITE_CANCEL",
  "TEAM_MEMBER_SCIM_PENDING",
  "TEAM_MEMBER_SCIM_PENDING_WITHDRAW",
  "TEAM_MEMBER_SCIM_REMOVE",
  "TEAM_MEMBER_SCIM_ROLE_UPDATE",
  "TEAM_MEMBER_KEY_DISTRIBUTE",
  "SCIM_GROUP_MAPPING_CREATE",
  // team-key-rotation-rekey D3.
  "TEAM_KEY_ROTATION_CARRY",
  "TEAM_KEY_ROTATION",
  // team-key-rotation-rekey C4.
  "TEAM_ATTACHMENT_MIGRATE",
  // team-key-rotation-rekey C2.
  "TEAM_ENTRY_REKEY",
  // departed-member-followups C1.
  "TEAM_MEMBER_ADD",
  "TEAM_MEMBER_INVITE",
  "TEAM_ROLE_UPDATE",
  // session-revocation-failure-surfaces.
  "TEAM_MEMBER_REMOVE",
];

// Must match IN_TX_ONLY_ACTIONS in the gate: action -> pinned direct logAuditInTx count.
const PINS = { TEAM_MEMBER_ADD: 1, TEAM_MEMBER_INVITE: 1, TEAM_ROLE_UPDATE: 2, TEAM_MEMBER_REMOVE: 1 };
// An action outside PINS, which the revert/missing cells take away and put back
// in another form.
const LAST = "TEAM_ENTRY_REKEY";

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

// Every critical action once, the pinned ones their pinned number of times,
// except `skip`. `pins` overrides a pinned count (to go one below or above).
function writeAllExcept(skip, pins = {}) {
  ALL.forEach((a, i) => {
    if (a === skip) return;
    const n = pins[a] ?? PINS[a] ?? 1;
    writeRoute(`crit-${i}/route.ts`, inTx(a).repeat(n));
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "critical-audit-atomic-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("check-critical-audit-atomic.mjs", () => {
  it("passes when every critical action is written via logAuditInTx", () => {
    writeAllExcept();
    const { exitCode, stdout } = runGuard();
    expect(exitCode, stdout).toBe(0);
    expect(stdout).toContain(`all ${ALL.length} security-critical actions`);
  });

  it("recognizes an action written via an atomic-audit descriptor (delegated to a helper)", () => {
    // All but one via logAuditInTx; the last via the { params: { action } }
    // descriptor passed to a shared helper (executeVaultReset).
    writeAllExcept(LAST);
    writeRoute("vault/reset/route.ts", descriptor(LAST));
    const { exitCode, stdout } = runGuard();
    expect(exitCode, stdout).toBe(0);
  });

  it("FAILS when a critical action is only in logAuditAsync (regression)", () => {
    // All but the last via logAuditInTx; the last reverted to async-only.
    writeAllExcept(LAST);
    const reverted = LAST;
    writeRoute("recover/route.ts", asyncCall(reverted));
    const { exitCode, stdout, stderr } = runGuard();
    expect(exitCode).toBe(1);
    expect(stdout + stderr).toContain(reverted);
  });

  it("is action-based, not proximity-based: an action next to (not inside) logAuditInTx does not count", () => {
    writeAllExcept(LAST);
    const reverted = LAST;
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
      writeAllExcept(LAST);
      writeRoute("scim/bulk-array/route.ts", bulkArray(LAST));
      const { exitCode, stdout } = runGuard();
      expect(exitCode, stdout).toBe(0);
    });

    it("passes with the last critical action via a bulk .map call", () => {
      writeAllExcept(LAST);
      writeRoute("scim/bulk-map/route.ts", bulkMap(LAST));
      const { exitCode, stdout } = runGuard();
      expect(exitCode, stdout).toBe(0);
    });

    it("FAILS (missing-action) when the last critical action has no bulk call either", () => {
      writeAllExcept(LAST);
      const { exitCode, stdout, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout + stderr).toContain(LAST);
    });

    it("FAILS (missing-action) when the bulk array literal writes an already-present action instead", () => {
      writeAllExcept(LAST);
      writeRoute("scim/bulk-array/route.ts", bulkArray(ALL[0]));
      const { exitCode, stdout, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout + stderr).toContain(LAST);
    });

    it("FAILS (missing-action) when the bulk .map writes an already-present action instead", () => {
      writeAllExcept(LAST);
      writeRoute("scim/bulk-map/route.ts", bulkMap(ALL[0]));
      const { exitCode, stdout, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout + stderr).toContain(LAST);
    });

    it("FAILS with the refusal message on a ternary action in a bulk .map, even when every critical action is otherwise present", () => {
      writeAllExcept();
      writeRoute("scim/bulk-ternary/route.ts", bulkTernary(ALL[0], ALL[1]));
      const { exitCode, stdout, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout + stderr).toMatch(/REFUSED.*not a literal AUDIT_ACTION/);
    });

    it("refuses a spread of .map() inside a bulk array literal", () => {
      writeAllExcept();
      writeRoute("scim/bulk-spread/route.ts", bulkSpreadOfMap(ALL[0]));
      const { exitCode, stdout, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout + stderr).toMatch(/REFUSED.*spread of a \.map\(\)/);
    });

    it("does not count logAuditBulkAsync toward the atomic action set", () => {
      writeAllExcept(LAST);
      writeRoute("scim/bulk-async/route.ts", bulkAsync(LAST));
      const { exitCode, stdout, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stdout + stderr).toContain(LAST);
    });
  });

  describe("IN_TX_ONLY_ACTIONS emitter pinning (C1)", () => {
    const asyncTernary = (a) =>
      `await logAuditAsync({\n  action: flag ? AUDIT_ACTION.${a} : AUDIT_ACTION.TEAM_MEMBER_REMOVE,\n});\n`;
    const bulkAsyncMapped = (a) =>
      `await logAuditBulkAsync(items.map((item) => ({\n  ...base,\n  action: AUDIT_ACTION.${a},\n})));\n`;

    it("passes on the pinned baseline", () => {
      writeAllExcept();
      const { exitCode, stdout, stderr } = runGuard();
      expect(exitCode, stdout + stderr).toBe(0);
    });

    it.each(Object.keys(PINS))("FAILS on a direct logAuditAsync emit of %s", (a) => {
      writeAllExcept();
      writeRoute("extra/route.ts", asyncCall(a));
      const { exitCode, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stderr).toContain(`AUDIT_ACTION.${a} in a logAuditAsync call`);
    });

    it("FAILS on a ternary arm naming a listed action in logAuditAsync", () => {
      writeAllExcept();
      writeRoute("extra/route.ts", asyncTernary("TEAM_ROLE_UPDATE"));
      const { exitCode, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stderr).toContain("AUDIT_ACTION.TEAM_ROLE_UPDATE in a logAuditAsync call");
    });

    it("FAILS on a mapped logAuditBulkAsync element naming a listed action", () => {
      writeAllExcept();
      writeRoute("extra/route.ts", bulkAsyncMapped("TEAM_MEMBER_ADD"));
      const { exitCode, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stderr).toContain("AUDIT_ACTION.TEAM_MEMBER_ADD in a logAuditBulkAsync call");
    });

    it("FAILS when an action has one emit fewer than its pin", () => {
      writeAllExcept(undefined, { TEAM_ROLE_UPDATE: 1 });
      const { exitCode, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stderr).toContain("AUDIT_ACTION.TEAM_ROLE_UPDATE has 1 direct logAuditInTx emitter(s), pinned at 2");
    });

    it("FAILS when an action has one emit more than its pin", () => {
      writeAllExcept(undefined, { TEAM_MEMBER_INVITE: 2 });
      const { exitCode, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stderr).toContain("AUDIT_ACTION.TEAM_MEMBER_INVITE has 2 direct logAuditInTx emitter(s), pinned at 1");
    });

    it("FAILS when the pin is met only through the descriptor form", () => {
      writeAllExcept("TEAM_MEMBER_ADD");
      writeRoute("extra/route.ts", descriptor("TEAM_MEMBER_ADD"));
      const { exitCode, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stderr).toContain("AUDIT_ACTION.TEAM_MEMBER_ADD has 0 direct logAuditInTx emitter(s), pinned at 1");
    });

    it("allows an identifier-valued async action (stated limit)", () => {
      writeAllExcept();
      writeRoute("extra/route.ts", "await logAuditAsync({\n  action: auditAction,\n});\n");
      const { exitCode, stdout, stderr } = runGuard();
      expect(exitCode, stdout + stderr).toBe(0);
    });

    it("allows an async TEAM_MEMBER_INVITE_CANCEL (exact name equality)", () => {
      writeAllExcept();
      writeRoute("extra/route.ts", asyncCall("TEAM_MEMBER_INVITE_CANCEL"));
      const { exitCode, stdout, stderr } = runGuard();
      expect(exitCode, stdout + stderr).toBe(0);
    });

    it("does not count an in-tx TEAM_MEMBER_INVITE_ACCEPT toward TEAM_MEMBER_INVITE", () => {
      // The accept emit exists (via ALL), but INVITE itself is absent: still a failure.
      writeAllExcept("TEAM_MEMBER_INVITE");
      const { exitCode, stderr } = runGuard();
      expect(exitCode).toBe(1);
      expect(stderr).toContain("AUDIT_ACTION.TEAM_MEMBER_INVITE has 0 direct logAuditInTx emitter(s), pinned at 1");
    });
  });

  it("passes against the real repo", () => {
    const r = spawnSync("node", [GUARD], { encoding: "utf8" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });
});
