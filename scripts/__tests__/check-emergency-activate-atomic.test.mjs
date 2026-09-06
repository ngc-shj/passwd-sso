import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const GATE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "checks",
  "check-emergency-activate-atomic.mjs",
);
const E1 = "src/lib/emergency-access/vault-auto-promote.ts";
const E2 = "src/app/api/emergency-access/[id]/approve/route.ts";

const ATOMIC = `await logAuditInTx(tx, tenantId, { action: AUDIT_ACTION.EMERGENCY_ACCESS_ACTIVATE });\n`;
const ASYNC = `await logAuditAsync({ action: AUDIT_ACTION.EMERGENCY_ACCESS_ACTIVATE });\n`;

let root;

function run() {
  try {
    return { code: 0, out: execFileSync("node", [GATE], {
      encoding: "utf8",
      env: { ...process.env, EMERGENCY_ACTIVATE_ATOMIC_ROOT: root },
      stdio: ["ignore", "pipe", "pipe"],
    }) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function write(rel, body) {
  mkdirSync(join(root, dirname(rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

/** Both emitters correct — the state every other case mutates away from. */
function writeBothAtomic() {
  write(E1, ATOMIC);
  write(E2, ATOMIC);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "emg-atomic-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("check-emergency-activate-atomic", () => {
  it("passes when both emitters use logAuditInTx", () => {
    writeBothAtomic();
    const { code, out } = run();
    expect(code).toBe(0);
    expect(out).toContain("2 emitters write");
  });

  // The clause the first version of this gate did not have. It checked only for
  // the absence of logAuditAsync, so deleting the emit entirely passed — and it
  // still printed "written in-transaction", a positive claim about a state it
  // could not distinguish from correct.
  it("fails when an emitter has no audit emit at all", () => {
    writeBothAtomic();
    write(E1, `const x = 1;\n`);
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("no logAuditInTx call");
    expect(out).toContain(E1);
  });

  it("fails when an emitter reverts to logAuditAsync, naming the line", () => {
    writeBothAtomic();
    write(E2, ASYNC);
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain(`${E2}:1`);
    expect(out).toContain("post-commit and best-effort");
  });

  // Each emitter is covered independently. The sibling action-scoped gate is
  // satisfied by either one, which is the whole reason this gate exists; a
  // version of it that were also satisfied by either would add nothing.
  it("fails when only ONE emitter is correct", () => {
    writeBothAtomic();
    write(E1, ASYNC);
    expect(run().code).toBe(1);
    writeBothAtomic();
    write(E2, ASYNC);
    expect(run().code).toBe(1);
  });

  it("is decided on the parse tree, not on line text", () => {
    // A call split across lines, and prose naming the forbidden function. The
    // text version of this gate got both wrong in opposite directions.
    writeBothAtomic();
    write(
      E1,
      `// The emit used to be \`logAuditAsync\` placed after the guards.\n` +
        `await logAuditInTx(\n  tx,\n  tenantId,\n  { action: AUDIT_ACTION.EMERGENCY_ACCESS_ACTIVATE },\n);\n`,
    );
    expect(run().code).toBe(0);

    write(
      E1,
      `await logAuditAsync(\n  { action: AUDIT_ACTION.EMERGENCY_ACCESS_ACTIVATE },\n);\n` + ATOMIC,
    );
    expect(run().code).toBe(1);
  });

  it("ignores emits of a DIFFERENT action", () => {
    // The allow side of the action predicate: these files emit other actions,
    // and a gate keyed on the function name alone would flag them.
    writeBothAtomic();
    write(E1, `await logAuditAsync({ action: AUDIT_ACTION.EMERGENCY_ACCESS_REQUEST });\n` + ATOMIC);
    expect(run().code).toBe(0);
  });

  it("fails when a subject is missing, distinguishably from clean", () => {
    write(E1, ATOMIC); // E2 absent
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("not found");
    expect(out).toContain(E2);
  });
});
