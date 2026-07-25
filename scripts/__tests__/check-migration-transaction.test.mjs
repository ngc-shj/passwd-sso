/**
 * Self-test for scripts/checks/check-migration-transaction.mjs (RT7).
 *
 * Runs the real gate against isolated fixture trees so both branches are proven.
 *
 * T1 — single DDL statement, unwrapped → exit 0 (nothing to make atomic)
 * T2 — multiple DDL statements, unwrapped → exit 1
 * T3 — multiple DDL statements wrapped in BEGIN/COMMIT → exit 0
 * T4 — START TRANSACTION/COMMIT is accepted as a wrapper
 * T5 — a `DO $$ BEGIN … END $$` block is ONE statement and its BEGIN is NOT a
 *      transaction BEGIN (the two failure modes a naive grep would confuse)
 * T6 — CREATE INDEX CONCURRENTLY is exempt (cannot run inside a transaction)
 * T7 — baseline entry suppresses the finding; a stale entry fails
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const GATE = resolve(REPO_ROOT, "scripts", "checks", "check-migration-transaction.mjs");

let root;

function addMigration(name, sql) {
  const dir = join(root, "prisma", "migrations", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "migration.sql"), sql, "utf8");
}

function setBaseline(contents) {
  const dir = join(root, "scripts", "checks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "migration-transaction-baseline.txt"), contents, "utf8");
}

function runGate() {
  return spawnSync(process.execPath, [GATE], {
    env: {
      PATH: process.env.PATH,
      MIGRATION_TX_CHECK_ROOT: root,
      MIGRATION_TX_CHECK_ALLOWLIST: join(
        root,
        "scripts",
        "checks",
        "migration-transaction-baseline.txt",
      ),
    },
    encoding: "utf8",
    timeout: 20_000,
  });
}

beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), "migration-tx-"));
  setBaseline("# empty baseline\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("check-migration-transaction gate", () => {
  it("T1: passes a single unwrapped DDL statement", () => {
    addMigration("20260101000000_single", `ALTER TABLE "users" ADD COLUMN "a" TEXT;`);

    expect(runGate().status).toBe(0);
  });

  it("T2: fails multiple unwrapped DDL statements", () => {
    addMigration(
      "20260101000001_multi",
      [
        `ALTER TABLE "users" ADD COLUMN "a" TEXT;`,
        `ALTER TABLE "users" ADD COLUMN "b" TEXT;`,
      ].join("\n"),
    );

    const r = runGate();

    expect(r.status).toBe(1);
    expect(r.stderr).toContain("UNWRAPPED_MULTI_DDL: 20260101000001_multi");
  });

  it("T3: passes multiple DDL statements wrapped in BEGIN/COMMIT", () => {
    addMigration(
      "20260101000002_wrapped",
      [
        `BEGIN;`,
        `ALTER TABLE "users" ADD COLUMN "a" TEXT;`,
        `ALTER TABLE "users" ADD COLUMN "b" TEXT;`,
        `COMMIT;`,
      ].join("\n"),
    );

    expect(runGate().status).toBe(0);
  });

  it("T4: accepts START TRANSACTION as the wrapper", () => {
    addMigration(
      "20260101000003_start_tx",
      [
        `START TRANSACTION;`,
        `ALTER TABLE "users" ADD COLUMN "a" TEXT;`,
        `ALTER TABLE "users" ADD COLUMN "b" TEXT;`,
        `COMMIT;`,
      ].join("\n"),
    );

    expect(runGate().status).toBe(0);
  });

  it("T5: a DO block is one statement and its BEGIN is not a transaction BEGIN", () => {
    // Two independent traps for a naive implementation:
    //  - counting DDL inside the DO body would make this look multi-statement;
    //  - treating the PL/pgSQL `BEGIN` as a transaction BEGIN would make an
    //    genuinely unwrapped migration look wrapped.
    // Here the DO block plus a second top-level DDL IS multi-statement and
    // unwrapped, so it must fail.
    addMigration(
      "20260101000004_do_block",
      [
        `DO $$ BEGIN EXECUTE 'ALTER TABLE users ADD COLUMN a TEXT'; END $$;`,
        `ALTER TABLE "users" ADD COLUMN "b" TEXT;`,
      ].join("\n"),
    );

    const r = runGate();

    expect(r.status).toBe(1);
    expect(r.stderr).toContain("UNWRAPPED_MULTI_DDL: 20260101000004_do_block");
    // Exactly 2 statements — the DO body's inner DDL must not be counted.
    expect(r.stderr).toContain("(2 DDL statements");
  });

  it("T6: exempts CREATE INDEX CONCURRENTLY (cannot run in a transaction)", () => {
    addMigration(
      "20260101000005_concurrent",
      [
        `CREATE INDEX CONCURRENTLY "idx_a" ON "users" ("a");`,
        `CREATE INDEX CONCURRENTLY "idx_b" ON "users" ("b");`,
      ].join("\n"),
    );

    expect(runGate().status).toBe(0);
  });

  it("T7: baseline suppresses the finding, and a stale entry fails", () => {
    addMigration(
      "20260101000006_multi",
      [
        `ALTER TABLE "users" ADD COLUMN "a" TEXT;`,
        `ALTER TABLE "users" ADD COLUMN "b" TEXT;`,
      ].join("\n"),
    );
    setBaseline("20260101000006_multi  # shipped before the explicit-transaction rule\n");

    expect(runGate().status).toBe(0);

    // Now make it compliant — the baseline entry becomes stale and must fail.
    addMigration(
      "20260101000006_multi",
      [
        `BEGIN;`,
        `ALTER TABLE "users" ADD COLUMN "a" TEXT;`,
        `ALTER TABLE "users" ADD COLUMN "b" TEXT;`,
        `COMMIT;`,
      ].join("\n"),
    );

    const r = runGate();

    expect(r.status).toBe(1);
    expect(r.stderr).toContain("STALE_ALLOWLIST_ENTRY: 20260101000006_multi");
  });
});
