import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const GATE = join(dirname(fileURLToPath(import.meta.url)), "..", "checks", "check-emergency-activate-atomic.mjs");
const SUBJECT = "src/lib/emergency-access/vault-auto-promote.ts";

let root;

function run() {
  try {
    const stdout = execFileSync("node", [GATE], {
      encoding: "utf8",
      env: { ...process.env, EMERGENCY_ACTIVATE_ATOMIC_ROOT: root },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function writeSubject(body) {
  mkdirSync(join(root, dirname(SUBJECT)), { recursive: true });
  writeFileSync(join(root, SUBJECT), body);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "emg-atomic-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("check-emergency-activate-atomic", () => {
  it("passes when the activation audit uses logAuditInTx", () => {
    writeSubject(`await logAuditInTx(db, tenantId, { action: "X" });\n`);
    const { code, out } = run();
    expect(code).toBe(0);
    expect(out).toContain("OK");
  });

  it("fails, naming the line, when it is reverted to logAuditAsync", () => {
    writeSubject(`await logAuditAsync({ action: "X" });\n`);
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain(`${SUBJECT}:1`);
  });

  it("does not flag prose that merely mentions logAuditAsync", () => {
    // The production file explains what it used to do. A word-shaped pattern
    // would flag its own documentation, which is how a gate gets softened into
    // uselessness on its first run.
    writeSubject(
      `// The emit used to be \`logAuditAsync\` placed after the guards.\n` +
        `await logAuditInTx(db, tenantId, { action: "X" });\n`,
    );
    expect(run().code).toBe(0);
  });

  it("fails when the subject is missing, distinguishably from clean", () => {
    // "the file moved" and "the file is clean" must not share an exit status.
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain("not found");
  });
});
