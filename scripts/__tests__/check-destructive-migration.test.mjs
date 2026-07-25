/**
 * Self-test for scripts/checks/check-destructive-migration.mjs (RT7).
 *
 * Runs the real gate against isolated fixture trees so both branches are proven:
 * it PASSES on a compatible migration and FAILS on each destructive DDL kind.
 * A gate that can only pass is decorative.
 *
 * T1 — additive-only migration → exit 0
 * T2 — each destructive kind (DROP COLUMN / DROP TABLE / RENAME / SET NOT NULL
 *      / ALTER COLUMN TYPE) → exit 1 naming the migration
 * T3 — a destructive migration listed in the baseline → exit 0
 * T4 — a baseline entry with no reason (or too short) → exit 1
 * T5 — a baseline entry naming a migration that is no longer destructive →
 *      exit 1 (STALE_ALLOWLIST_ENTRY anti-drift)
 * T6 — destructive DDL appearing only inside a comment or string literal does
 *      NOT trip the gate (no false positive)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GATE = resolve(REPO_ROOT, "scripts", "checks", "check-destructive-migration.mjs");

let root;

/** Write prisma/migrations/<name>/migration.sql inside the fixture tree. */
function addMigration(name, sql) {
  const dir = join(root, "prisma", "migrations", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "migration.sql"), sql, "utf8");
}

function setBaseline(contents) {
  const dir = join(root, "scripts", "checks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "destructive-migration-baseline.txt"), contents, "utf8");
}

function runGate() {
  return spawnSync(process.execPath, [GATE], {
    env: {
      PATH: process.env.PATH,
      DESTRUCTIVE_MIGRATION_CHECK_ROOT: root,
      DESTRUCTIVE_MIGRATION_CHECK_ALLOWLIST: join(
        root,
        "scripts",
        "checks",
        "destructive-migration-baseline.txt",
      ),
    },
    encoding: "utf8",
    timeout: 20_000,
  });
}

beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), "destructive-mig-"));
  setBaseline("# empty baseline\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("check-destructive-migration gate", () => {
  it("T1: passes on an additive-only migration", () => {
    addMigration(
      "20260101000000_add_column",
      `ALTER TABLE "users" ADD COLUMN "nickname" TEXT;`,
    );

    const r = runGate();

    expect(r.status).toBe(0);
  });

  const destructiveCases = [
    ["DROP COLUMN", `ALTER TABLE "users" DROP COLUMN "nickname";`],
    ["DROP TABLE", `DROP TABLE "legacy_sessions";`],
    ["RENAME", `ALTER TABLE "users" RENAME COLUMN "name" TO "full_name";`],
    ["SET NOT NULL", `ALTER TABLE "users" ALTER COLUMN "email" SET NOT NULL;`],
    ["ALTER COLUMN TYPE", `ALTER TABLE "users" ALTER COLUMN "age" TYPE BIGINT;`],
  ];

  for (const [kind, sql] of destructiveCases) {
    it(`T2: fails on ${kind}`, () => {
      addMigration("20260101000001_destructive", sql);

      const r = runGate();

      expect(r.status).toBe(1);
      expect(r.stderr).toContain("DESTRUCTIVE_MIGRATION: 20260101000001_destructive");
    });
  }

  it("T3: passes when the destructive migration is baselined with a reason", () => {
    addMigration("20260101000002_dropcol", `ALTER TABLE "users" DROP COLUMN "old";`);
    setBaseline("20260101000002_dropcol  # shipped before the rule; column was unused\n");

    const r = runGate();

    expect(r.status).toBe(0);
  });

  it("T4: fails when a baseline entry has no usable reason", () => {
    addMigration("20260101000002_dropcol", `ALTER TABLE "users" DROP COLUMN "old";`);
    setBaseline("20260101000002_dropcol  # short\n");

    const r = runGate();

    expect(r.status).toBe(1);
    expect(r.stderr).toContain("ALLOWLIST_ENTRY_WITHOUT_REASON");
  });

  it("T5: fails on a stale baseline entry (migration no longer destructive)", () => {
    addMigration("20260101000003_additive", `ALTER TABLE "users" ADD COLUMN "x" TEXT;`);
    setBaseline("20260101000003_additive  # was destructive once, no longer is\n");

    const r = runGate();

    expect(r.status).toBe(1);
    expect(r.stderr).toContain("STALE_ALLOWLIST_ENTRY: 20260101000003_additive");
  });

  it("T6: does not flag destructive DDL inside a comment or string literal", () => {
    addMigration(
      "20260101000004_noise",
      [
        `-- This migration does NOT do: ALTER TABLE "users" DROP COLUMN "x";`,
        `INSERT INTO "notes" ("body") VALUES ('we used to DROP TABLE legacy here');`,
        `ALTER TABLE "users" ADD COLUMN "y" TEXT;`,
      ].join("\n"),
    );

    const r = runGate();

    expect(r.status).toBe(0);
  });
});
