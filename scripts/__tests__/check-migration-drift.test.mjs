/**
 * Self-test for scripts/checks/check-migration-drift.mjs — the CI guard
 * that detects schema/migration drift by pure file analysis (RLS coverage,
 * enum-value completeness, column completeness).
 *
 * The gate is cwd-relative (reads "prisma/schema.prisma" and
 * "prisma/migrations" off the process cwd, no env override), so it is
 * fixtured by spawning it with `cwd` pointed at a temp tree that mirrors
 * that shape — no code change to the gate itself (plan C2: "fixturable by
 * cwd alone"). Only Check C (column completeness) is exercised — it is the
 * simplest complete violation/clean pair and does not require constructing
 * a full RLS-policy or enum fixture.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GUARD = join(REPO_ROOT, "scripts/checks/check-migration-drift.mjs");

let root;

function runGuard(cwd = root) {
  const r = spawnSync("node", [GUARD], { encoding: "utf8", cwd });
  return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
}

const SCHEMA = [
  "model Widget {",
  "  id    String @id",
  "  name  String",
  "  color String",
  "}",
  "",
].join("\n");

function writeMigration(root, name, sql) {
  const dir = join(root, "prisma/migrations", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "migration.sql"), sql, "utf8");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "migration-drift-"));
  mkdirSync(join(root, "prisma/migrations"), { recursive: true });
  writeFileSync(join(root, "prisma/schema.prisma"), SCHEMA, "utf8");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("check-migration-drift.mjs", () => {
  it('FAILS with "not found in any migration" when a schema column is absent from migrations', () => {
    writeMigration(
      root,
      "20260101000000_create_widget",
      'CREATE TABLE "widget" (\n  "id" TEXT NOT NULL,\n  "name" TEXT NOT NULL\n);\n',
    );
    const { exitCode, stderr } = runGuard();
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Table "widget" column "color" not found in any migration');
  });

  it("passes when every schema column is present in migrations", () => {
    writeMigration(
      root,
      "20260101000000_create_widget",
      'CREATE TABLE "widget" (\n  "id" TEXT NOT NULL,\n  "name" TEXT NOT NULL,\n  "color" TEXT NOT NULL\n);\n',
    );
    const { exitCode, stdout } = runGuard();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("check-migration-drift:");
    expect(stdout).toContain("all consistent");
  });

  describe("real repo (no overrides)", () => {
    it("passes against the actual schema + migrations tree", () => {
      const r = spawnSync("node", [GUARD], { encoding: "utf8" });
      expect(r.status, r.stdout + r.stderr).toBe(0);
    });
  });
});
