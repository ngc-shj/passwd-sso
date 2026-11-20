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
 * T9 — ALTER TABLE … ADD … CHECK in each grammatical form → exit 1 (ADD CHECK)
 * T10 — a CHECK outside ALTER TABLE … ADD (CREATE TABLE, ALTER DOMAIN, a policy's
 *       WITH CHECK, VALIDATE CONSTRAINT, a comment or string) → exit 0
 * T11 — the #1011 migration's kind set is exactly ADD CHECK
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { findDestructiveKinds } from "../checks/check-destructive-migration.mjs";

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
  // `TRUNCATE` also names a trigger EVENT, and that form is the opposite of
  // destructive — it is how a migration FORBIDS truncation. A bare token match
  // read an append-only guard as the thing it guards against. The paired deny
  // case (`TRUNCATE TABLE …` under T2) is what proves the narrowing did not
  // open a hole; in PostgreSQL's grammar no truncation statement can follow
  // BEFORE / AFTER / OR.
  const triggerEventCases = [
    ["BEFORE TRUNCATE", `CREATE TRIGGER g BEFORE TRUNCATE ON "t" FOR EACH STATEMENT EXECUTE FUNCTION f();`],
    ["AFTER TRUNCATE", `CREATE TRIGGER g AFTER TRUNCATE ON "t" FOR EACH STATEMENT EXECUTE FUNCTION f();`],
    ["OR TRUNCATE in an event list", `CREATE TRIGGER g BEFORE INSERT OR TRUNCATE ON "t" FOR EACH STATEMENT EXECUTE FUNCTION f();`],
  ];

  for (const [kind, sql] of triggerEventCases) {
    it(`T1b: passes on ${kind} (a trigger event, not a truncation)`, () => {
      addMigration("20260101000003_append_only_guard", sql);

      const r = runGate();

      expect(r.status).toBe(0);
    });
  }

  // `TRUNCATE` is also a table PRIVILEGE, and revoking it is how a migration
  // removes truncation from a role. The tokenizer drops commas, so the
  // privilege list reads as a run of privilege keywords after GRANT / REVOKE
  // (or REVOKE GRANT OPTION FOR); the paired deny cases under T2 are a
  // truncation statement directly after such a list and after a statement
  // boundary, proving the narrowing stops at both.
  const privilegeCases = [
    ["REVOKE TRUNCATE alone", `REVOKE TRUNCATE ON "t" FROM r;`],
    ["REVOKE TRUNCATE mid-list", `REVOKE DELETE, TRUNCATE, REFERENCES ON "t" FROM r;`],
    ["GRANT TRUNCATE", `GRANT SELECT, TRUNCATE ON "t" TO r;`],
    ["REVOKE GRANT OPTION FOR TRUNCATE", `REVOKE GRANT OPTION FOR TRUNCATE ON "t" FROM r;`],
    [
      "REVOKE TRUNCATE inside a DO $$ block",
      `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'r') THEN REVOKE DELETE, TRUNCATE ON "t" FROM r; END IF; END $$;`,
    ],
  ];

  for (const [kind, sql] of privilegeCases) {
    it(`T1c: passes on ${kind} (a privilege, not a truncation)`, () => {
      addMigration("20260101000004_revoke_privilege", sql);

      const r = runGate();

      expect(r.status).toBe(0);
    });
  }

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
    // Evasion cases reported in review — each slipped past the previous
    // regex-over-stripped-text implementation.
    // PostgreSQL makes COLUMN optional in ALTER TABLE ... RENAME.
    ["RENAME without the optional COLUMN keyword", `ALTER TABLE users RENAME email TO email_address;`],
    ["ALTER TYPE ... RENAME VALUE", `ALTER TYPE status RENAME VALUE 'OLD' TO 'NEW';`],
    // The `--` is inside a string literal, so it does NOT start a comment;
    // stripping comments before parsing strings deletes the DROP and misses it.
    ["DROP after a string literal containing --", `SELECT '-- harmless'; DROP TABLE users;`],
    // These migrations wrap their DDL in DO blocks; skipping dollar-quoted
    // bodies wholesale would miss the majority of real renames.
    [
      "RENAME inside a DO $$ block",
      `DO $$ BEGIN EXECUTE 'ALTER TABLE users RENAME COLUMN a TO b'; END $$;`,
    ],
    ["ALTER TABLE DROP without COLUMN", `ALTER TABLE "users" DROP "nickname";`],
    ["DROP CONSTRAINT", `ALTER TABLE "users" DROP CONSTRAINT "users_email_key";`],
    ["DROP VIEW", `DROP VIEW "user_summary";`],
    ["TRUNCATE", `TRUNCATE TABLE "extension_tokens";`],
    // The privilege-list narrowing must stop at the statement boundary.
    ["TRUNCATE after a REVOKE TRUNCATE", `REVOKE DELETE, TRUNCATE ON "t" FROM r; TRUNCATE "t";`],
    ["TRUNCATE without a semicolon after a REVOKE", `REVOKE TRUNCATE ON "t" FROM r TRUNCATE "t";`],
    // A dollar-quote tag may contain digits after the first character; an
    // earlier [A-Za-z_]* pattern rejected $body1$, leaving the body unscanned.
    [
      "DROP inside a $body1$-tagged block",
      `DO $body1$ BEGIN EXECUTE 'DROP TABLE users'; END $body1$;`,
    ],
    // Dollar-quote tags follow the unquoted-identifier rule, which is not
    // ASCII-only — an [A-Za-z_] class left this body unscanned entirely.
    [
      "DROP inside a Unicode-tagged block",
      `DO $é1$ BEGIN EXECUTE 'DROP TABLE users'; END $é1$;`,
    ],
    // Object types that an enumerate-the-destructive-kinds design missed
    // entirely. These break old code or remove a security boundary.
    ["DROP FUNCTION", `DROP FUNCTION tenant_guard();`],
    ["DROP TRIGGER", `DROP TRIGGER audit_guard ON "users";`],
    ["DROP POLICY", `DROP POLICY tenant_isolation ON "users";`],
    ["DROP INDEX", `DROP INDEX users_email_key;`],
    ["DISABLE ROW LEVEL SECURITY", `ALTER TABLE "users" DISABLE ROW LEVEL SECURITY;`],
    ["NO FORCE ROW LEVEL SECURITY", `ALTER TABLE "users" NO FORCE ROW LEVEL SECURITY;`],
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
        `/* nor does it DROP TABLE legacy_sessions; */`,
        `INSERT INTO "notes" ("body") VALUES ('we used to DROP TABLE legacy here');`,
        `ALTER TABLE "users" ADD COLUMN "y" TEXT;`,
      ].join("\n"),
    );

    const r = runGate();

    expect(r.status).toBe(0);
  });

  it("T7: does not flag the relaxing DROP forms (DEFAULT / NOT NULL / IDENTITY)", () => {
    // These remove a CONSTRAINT on writes rather than removing data, so old
    // code keeps working — flagging them would train reviewers to rubber-stamp
    // baseline additions.
    addMigration(
      "20260101000005_relaxing",
      [
        `ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;`,
        `ALTER TABLE "users" ALTER COLUMN "created_at" DROP DEFAULT;`,
      ].join("\n"),
    );

    const r = runGate();

    expect(r.status).toBe(0);
  });

  it("T7b: fails closed on a dollar sign it cannot parse as a dollar-quote", () => {
    // Defence against the NEXT unrecognised quoting form: rather than treating
    // an unparsed `$` as punctuation (which is how the ASCII-only tag pattern
    // let a whole body go unscanned), the tokenizer emits a sentinel that
    // surfaces as a review-required finding.
    addMigration("20260101000007_odd_dollar", `SELECT $9bad$ DROP TABLE users $9bad$;`);

    const r = runGate();

    expect(r.status).toBe(1);
    expect(r.stderr).toContain("20260101000007_odd_dollar");
    expect(r.stderr).toContain("needs review");
  });

  it("T8: does not flag a quoted identifier that looks like a keyword", () => {
    addMigration(
      "20260101000006_quoted",
      `ALTER TABLE "users" ADD COLUMN "rename" TEXT;`,
    );

    const r = runGate();

    expect(r.status).toBe(0);
  });

  // A CHECK added to an existing table narrows writes the way SET NOT NULL
  // does: old code still live during the migration can be refused.
  const addCheckCases = [
    ["ADD CONSTRAINT c CHECK", `ALTER TABLE "t" ADD CONSTRAINT "c" CHECK ("x" > 0);`],
    ["ADD CHECK without a constraint name", `ALTER TABLE "t" ADD CHECK ("x" > 0);`],
    ["ALTER TABLE ONLY", `ALTER TABLE ONLY "t" ADD CONSTRAINT "c" CHECK ("x" > 0);`],
    ["ALTER TABLE IF EXISTS", `ALTER TABLE IF EXISTS "t" ADD CONSTRAINT "c" CHECK ("x" > 0);`],
    // The CHECK is the second subcommand, after one that is not an ADD.
    [
      "a multi-subcommand ALTER TABLE",
      `ALTER TABLE "t" ALTER COLUMN "x" SET DEFAULT 0, ADD CONSTRAINT "c" CHECK ("x" >= 0);`,
    ],
    ["ADD COLUMN c int CHECK (…)", `ALTER TABLE "t" ADD COLUMN "c" INT CHECK ("c" > 0);`],
    [
      "ADD COLUMN IF NOT EXISTS … CONSTRAINT c CHECK (…)",
      `ALTER TABLE "t" ADD COLUMN IF NOT EXISTS "c" INT NOT NULL DEFAULT 1 CONSTRAINT "c_pos" CHECK ("c" > 0);`,
    ],
    ["ADD without the optional COLUMN keyword", `ALTER TABLE "t" ADD "c" INT CHECK ("c" > 0);`],
    // NOT VALID skips the scan of stored rows, not the check of new writes.
    ["NOT VALID", `ALTER TABLE "t" ADD CONSTRAINT "c" CHECK ("x" > 0) NOT VALID;`],
    // tokenize() re-scans DO bodies with quotes neutralised, so DDL inside an
    // EXECUTE literal is seen.
    [
      "a CHECK inside a DO-body EXECUTE literal",
      `DO $$ BEGIN EXECUTE 'ALTER TABLE t ADD CONSTRAINT c CHECK (x > 0)'; END $$;`,
    ],
  ];

  for (const [kind, sql] of addCheckCases) {
    it(`T9: fails on ${kind}`, () => {
      addMigration("20260101000008_add_check", sql);

      const r = runGate();

      expect(r.status).toBe(1);
      expect(r.stderr).toContain("DESTRUCTIVE_MIGRATION: 20260101000008_add_check (ADD CHECK)");
    });
  }

  const notAddCheckCases = [
    // A new table has no old writers.
    [
      "CREATE TABLE … CHECK",
      `CREATE TABLE "t" ("x" INT CHECK ("x" > 0), CONSTRAINT "c" CHECK ("x" < 10));`,
    ],
    // The walk back for ALTER TABLE … ADD stops at the statement boundary.
    [
      "CREATE TABLE … CHECK after an ALTER TABLE … ADD COLUMN",
      `ALTER TABLE "u" ADD COLUMN "y" TEXT; CREATE TABLE "t" ("x" INT CHECK ("x" > 0));`,
    ],
    // No migration uses a domain (`grep -rn "CREATE DOMAIN" prisma/migrations`
    // is empty), so a domain CHECK has no writers to break.
    ["ALTER DOMAIN … ADD CONSTRAINT … CHECK", `ALTER DOMAIN "d" ADD CONSTRAINT "c" CHECK (VALUE > 0);`],
    // Every RLS migration writes this shape.
    [
      "a policy's WITH CHECK after an ALTER TABLE",
      `ALTER TABLE "t" ENABLE ROW LEVEL SECURITY; CREATE POLICY p ON "t" USING (true) WITH CHECK (true);`,
    ],
    ["VALIDATE CONSTRAINT", `ALTER TABLE "t" VALIDATE CONSTRAINT "c";`],
    [
      "a CHECK only in a top-level comment or string",
      [
        `-- ALTER TABLE "t" ADD CONSTRAINT "c" CHECK ("x" > 0);`,
        `/* ALTER TABLE t ADD CHECK (x > 0); */`,
        `INSERT INTO "notes" ("body") VALUES ('ALTER TABLE t ADD CHECK (x > 0)');`,
      ].join("\n"),
    ],
  ];

  for (const [kind, sql] of notAddCheckCases) {
    it(`T10: passes on ${kind}`, () => {
      addMigration("20260101000009_not_add_check", sql);

      const r = runGate();

      expect(r.status).toBe(0);
    });
  }

  // Baseline entries are per directory, so this migration's entry would also
  // cover destructive DDL added to it later; pin its kind set instead.
  it("T11: the #1011 ItemKey identity migration flags ADD CHECK and nothing else", () => {
    const sql = readFileSync(
      resolve(
        REPO_ROOT,
        "prisma",
        "migrations",
        "20261120000000_team_item_key_id_check",
        "migration.sql",
      ),
      "utf8",
    );

    expect(findDestructiveKinds(sql)).toEqual(["ADD CHECK"]);
  });
});
