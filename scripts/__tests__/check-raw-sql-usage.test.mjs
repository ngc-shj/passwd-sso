/**
 * Regression tests for check-raw-sql-usage.mjs's Layer-2 guard branches.
 *
 * The checker is authored regex/span logic with non-trivial branches
 * (UNRESOLVED_SQL_ARG, MARKER_VALIDATOR_ABSENT, UNMARKED_INTERPOLATION,
 * IDENT_MARKERS_MISMATCH). Without these tests a future edit could silently
 * disable a guard, and CI would only notice once a real vulnerable file
 * appeared — the exact scenario the checker exists to prevent. Each case runs
 * the real CLI against an isolated fixture tree via RAW_SQL_CHECK_ROOT /
 * RAW_SQL_CHECK_ALLOWLIST env overrides (no mutation of the tracked allowlist).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CHECKER = fileURLToPath(new URL("../checks/check-raw-sql-usage.mjs", import.meta.url));

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "raw-sql-check-"));
  mkdirSync(join(dir, "scripts"), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Write a fixture .ts file under the fixture tree's scripts/ dir and an
// allowlist listing it, then run the checker. Returns { code, stderr }.
function run(fixtureName, source, allowlistLine) {
  const rel = `scripts/${fixtureName}`;
  writeFileSync(join(dir, rel), source, "utf8");
  const allowlist = join(dir, "allowlist.txt");
  writeFileSync(allowlist, `${allowlistLine ?? `${rel} # test fixture purpose over ten chars`}\n`, "utf8");
  try {
    const stdout = execFileSync("node", [CHECKER], {
      env: { ...process.env, RAW_SQL_CHECK_ROOT: dir, RAW_SQL_CHECK_ALLOWLIST: allowlist },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stderr: "", stdout };
  } catch (e) {
    return { code: e.status, stderr: e.stderr?.toString() ?? "", stdout: e.stdout?.toString() ?? "" };
  }
}

describe("check-raw-sql-usage Layer-2 guards", () => {
  it("fails closed (UNRESOLVED_SQL_ARG) on a reassignment-built SQL string", () => {
    const src = [
      "export async function run(tx, x) {",
      "  let sql = `SELECT 1`;",
      "  sql = sql + ` WHERE x = ${x}`;",
      "  return tx.$executeRawUnsafe(sql);",
      "}",
      "",
    ].join("\n");
    const r = run("unresolved.ts", src);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("UNRESOLVED_SQL_ARG");
  });

  it("rejects a marker naming a validator absent from the file (MARKER_VALIDATOR_ABSENT)", () => {
    const src = [
      "export async function run(tx, t) {",
      "  // raw-sql-ident: identifiers validated by nonExistentValidator() before use",
      "  return tx.$executeRawUnsafe(`DELETE FROM ${t}`);",
      "}",
      "",
    ].join("\n");
    const r = run("absent-validator.ts", src, "scripts/absent-validator.ts # test fixture purpose over ten chars # ident-markers=1");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("MARKER_VALIDATOR_ABSENT");
  });

  it("passes when a marker names a validator that IS present in the file (negative case)", () => {
    const src = [
      "function assertIdentifier(s) { if (!/^[a-z_]+$/.test(s)) throw new Error('bad'); }",
      "export async function run(tx, t) {",
      "  assertIdentifier(t);",
      "  // raw-sql-ident: identifiers validated by assertIdentifier() above before use",
      "  return tx.$executeRawUnsafe(`DELETE FROM ${t}`);",
      "}",
      "",
    ].join("\n");
    const r = run("present-validator.ts", src, "scripts/present-validator.ts # test fixture purpose over ten chars # ident-markers=1");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("check-raw-sql-usage: OK");
  });

  it("fails (UNMARKED_INTERPOLATION) on an interpolation with no marker", () => {
    const src = [
      "export async function run(tx, t) {",
      "  return tx.$executeRawUnsafe(`DELETE FROM ${t}`);",
      "}",
      "",
    ].join("\n");
    const r = run("unmarked.ts", src);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("UNMARKED_INTERPOLATION");
  });

  it("passes on a fully parameterized Unsafe call (no interpolation)", () => {
    const src = [
      "export async function run(tx, id) {",
      "  return tx.$executeRawUnsafe(`SELECT * FROM t WHERE id = $1`, id);",
      "}",
      "",
    ].join("\n");
    const r = run("safe.ts", src);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("check-raw-sql-usage: OK");
  });
});
