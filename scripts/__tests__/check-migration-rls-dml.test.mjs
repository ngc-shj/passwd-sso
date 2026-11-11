/**
 * Self-test for scripts/checks/check-migration-rls-dml.mjs (plan
 * migration-backfill-rls-bypass, C5).
 *
 * Runs the real gate against isolated fixture trees so every refusal and every
 * pass is proven. Expected hit lines are written by hand from the fixture SQL
 * (a DO wrapper puts body line N on file line N + 2); none is read back from
 * the gate. The real-tree cells compare against literals read off the shipped
 * SQL, and the FORCE counts against a separate regex pass of this file.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
// Overridable so a red-proof can point the cells at a mutated COPY of the gate.
const GATE =
  process.env.MIGRATION_RLS_DML_GATE_UNDER_TEST ??
  resolve(REPO_ROOT, "scripts", "checks", "check-migration-rls-dml.mjs");
const REAL_MIGRATIONS = join(REPO_ROOT, "prisma", "migrations");
const REAL_BASELINE = join(REPO_ROOT, "scripts", "checks", "migration-rls-dml-baseline.txt");

const FORCE_DIR = "20260101000000_force";
const CASE_DIR = "20260102000000_case";

let root;
let baselineFile;

function addMigration(name, sql) {
  const dir = join(root, "prisma", "migrations", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "migration.sql"), sql, "utf8");
}

function setBaseline(contents) {
  writeFileSync(baselineFile, contents, "utf8");
}

/** Forces three tables in an earlier migration (the usual fixture base). */
function addForceBase() {
  addMigration(
    FORCE_DIR,
    [
      `ALTER TABLE "tenant_members" FORCE ROW LEVEL SECURITY;`,
      `ALTER TABLE "team_members" FORCE ROW LEVEL SECURITY;`,
      `ALTER TABLE "team_invitations" FORCE ROW LEVEL SECURITY;`,
    ].join("\n"),
  );
}

/** Run the gate; `root` and the baseline are fixture-local unless `real` is set. */
function runGate({ args = [], real = false, env = {} } = {}) {
  const base = { PATH: process.env.PATH };
  const fixtureEnv = real
    ? {}
    : {
        MIGRATION_RLS_DML_CHECK_ROOT: root,
        MIGRATION_RLS_DML_CHECK_BASELINE: baselineFile,
        MIGRATION_RLS_DML_CHECK_FIXTURE: "1",
      };
  return spawnSync(process.execPath, [GATE, ...args], {
    env: { ...base, ...fixtureEnv, ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
}

/** DO wrapper: line 1 `DO tag`, line 2 `BEGIN`, body line N on file line N + 2. */
const doBlock = (body, tag = "$$") => `DO ${tag}\nBEGIN\n${body}\nEND\n${tag};`;

const GRANT = `PERFORM set_config('app.bypass_rls', 'on', true);`;
const tablesOf = (list) => `PERFORM set_config('app.bypass_tables', '${list}', true);`;
const RESTORE = `PERFORM set_config('app.bypass_rls', COALESCE(v_prev, ''), true);`;

const hitLine = (line, table) => `MIGRATION_RLS_DML: ${CASE_DIR}:${line}: ${table}`;

function hitLinesOf(stderr) {
  return stderr.split("\n").filter((l) => l.includes("MIGRATION_RLS_DML: "));
}

const linesWith = (stderr, marker) => stderr.split("\n").filter((l) => l.startsWith(`  ${marker}`));
const unparsedLine = (line, reason) => `  MIGRATION_RLS_DML_UNPARSED: ${CASE_DIR}:${line}: ${reason}`;
const dynamicLine = (line) => `  MIGRATION_RLS_DML_DYNAMIC: ${CASE_DIR}:${line}`;

const R_NESTED = "bypass setting (grant or restore) inside a nested block, branch or loop";
const R_SESSION = (setting) => `set_config('${setting}', ..., false) is session-scoped`;
const R_NOT_RESTORED = "bypass_rls granted but not restored by the end of the DO body";
const R_SET_BYPASS_DO = "SET / RESET of an app.bypass_* setting inside a DO body (lexical state unknown)";
const R_SET_BYPASS_LIT = "SET / RESET of an app.bypass_* setting inside an EXECUTE literal (lexical state unknown)";
const R_FORCE_DO = "FORCE ROW LEVEL SECURITY inside a DO body";
const R_FORCE_LIT = "FORCE ROW LEVEL SECURITY inside an EXECUTE literal";
const R_RENAME_DO = "ALTER TABLE <FORCE table> RENAME TO inside a DO body";
const R_RENAME_LIT = "ALTER TABLE <FORCE table> RENAME TO inside an EXECUTE literal";
const R_UNKNOWN_SETTING = "RESET ALL or a SET / RESET with a non-plain name after a bypass grant (restore state unknown)";
const R_FIRST_ARG = "set_config with a first argument that is not a plain 'literal'";
const R_SET_CONFIG_LIT = (setting) => `set_config of ${setting} inside an EXECUTE literal`;
const R_ESCAPE = "EXECUTE of an E-string with an escape other than \\' and \\\\, or an unterminated literal";
const R_UNICODE = "EXECUTE of a U&'…' literal";
const R_LIT_QUOTE = "EXECUTE literal holds an unterminated or unrecognised $ quote";
const R_DO_IN_LIT = "DO inside an EXECUTE literal";
const R_PREPARED = "EXECUTE (prepared statement) inside an EXECUTE literal";
const R_PG_SETTINGS_DO = "pg_settings inside a DO body (can change a bypass setting unseen)";
const R_PG_SETTINGS_LIT = "pg_settings inside an EXECUTE literal (can change a bypass setting unseen)";
const R_SENTINEL = "U+E000 in the SQL text (the scanner's substitution sentinel)";

beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), "migration-rls-dml-"));
  mkdirSync(join(root, "scripts", "checks"), { recursive: true });
  baselineFile = join(root, "scripts", "checks", "migration-rls-dml-baseline.txt");
  setBaseline("# empty baseline\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("check-migration-rls-dml: references refused without a bypass", () => {
  // [name, sql, [[file line, table], ...]]
  const refused = [
    // One case per reference form, each a single DO body line (file line 3).
    ["PERFORM … FROM", doBlock(`PERFORM count(*) FROM team_members;`), [[3, "team_members"]]],
    ["SELECT … INTO … FROM", doBlock(`SELECT count(*) INTO n FROM team_members;`), [[3, "team_members"]]],
    ["INSERT INTO t (cols)", doBlock(`INSERT INTO team_members (id) VALUES (1);`), [[3, "team_members"]]],
    ["INSERT INTO t SELECT", doBlock(`INSERT INTO team_members SELECT 1;`), [[3, "team_members"]]],
    ["UPDATE", doBlock(`UPDATE team_members SET a = 1;`), [[3, "team_members"]]],
    ["UPDATE ONLY", doBlock(`UPDATE ONLY team_members SET a = 1;`), [[3, "team_members"]]],
    ["DELETE FROM", doBlock(`DELETE FROM team_members;`), [[3, "team_members"]]],
    [
      "MERGE INTO",
      doBlock(`MERGE INTO team_members m USING (SELECT 1) s ON true WHEN MATCHED THEN DELETE;`),
      [[3, "team_members"]],
    ],
    ["JOIN", doBlock(`PERFORM 1 FROM other_t o JOIN team_members m ON true;`), [[3, "team_members"]]],
    ["USING", doBlock(`DELETE FROM other_t o USING team_members m WHERE true;`), [[3, "team_members"]]],
    ["comma join", doBlock(`PERFORM 1 FROM other_t o, team_members m;`), [[3, "team_members"]]],
    ["public.t", doBlock(`DELETE FROM public.team_members;`), [[3, "team_members"]]],
    ["quoted identifier", doBlock(`DELETE FROM "team_members";`), [[3, "team_members"]]],
    ["public.\"t\"", doBlock(`DELETE FROM public."team_members";`), [[3, "team_members"]]],
    ["WITH-prefixed DML", doBlock(`WITH x AS (SELECT 1) DELETE FROM team_members;`), [[3, "team_members"]]],
    [
      "CTE named differently from the table (body reads the table)",
      doBlock(`WITH x AS (SELECT 1 FROM team_members) SELECT * FROM x;`),
      [[3, "team_members"]],
    ],
    [
      "CTE of the table's own name whose body reads the real table",
      doBlock(`WITH team_members AS (SELECT 1 FROM team_members) SELECT * FROM team_members;`),
      [[3, "team_members"]],
    ],
    // PL/pgSQL-prefixed statements.
    [
      "BEGIN UPDATE",
      doBlock([`BEGIN`, `UPDATE team_members SET a = 1;`, `EXCEPTION WHEN OTHERS THEN NULL;`, `END;`].join("\n")),
      [[4, "team_members"]],
    ],
    ["IF … THEN UPDATE", doBlock(`IF true THEN UPDATE team_members SET a = 1; END IF;`), [[3, "team_members"]]],
    ["FOR r IN SELECT", doBlock(`FOR r IN SELECT id FROM team_members LOOP NULL; END LOOP;`), [[3, "team_members"]]],
    ["IF EXISTS (SELECT", doBlock(`IF EXISTS (SELECT 1 FROM team_members) THEN NULL; END IF;`), [[3, "team_members"]]],
    ["assignment from a subquery", doBlock(`v := (SELECT count(*) FROM team_members);`), [[3, "team_members"]]],
    // DO $tag$ and a Unicode dollar tag: the body is scanned, not skipped.
    ["DO $body$", doBlock(`UPDATE team_members SET a = 1;`, "$body$"), [[3, "team_members"]]],
    ["DO with a Unicode dollar tag", doBlock(`UPDATE team_members SET a = 1;`, "$é1$"), [[3, "team_members"]]],
    // Top level: a data statement is always refused.
    ["top-level UPDATE", `UPDATE team_members SET a = 1;`, [[1, "team_members"]]],
    ["top-level INSERT … SELECT", `INSERT INTO other_t SELECT * FROM team_members;`, [[1, "team_members"]]],
    ["top-level CREATE TABLE AS", `CREATE TABLE copy AS SELECT * FROM team_members;`, [[1, "team_members"]]],
    // Reference forms that are easy to miss.
    ["MERGE INTO ONLY", doBlock(`MERGE INTO ONLY team_members m USING (SELECT 1) s ON true WHEN MATCHED THEN DELETE;`), [[3, "team_members"]]],
    ["INSERT INTO u TABLE t", `INSERT INTO other_t TABLE team_members;`, [[1, "team_members"]]],
    ["INSERT INTO u (cols) TABLE t", `INSERT INTO other_t (a) TABLE team_members;`, [[1, "team_members"]]],
    ["top-level TABLE t", `TABLE team_members;`, [[1, "team_members"]]],
    ["TABLE t after UNION ALL", doBlock(`PERFORM 1 UNION ALL TABLE team_members;`), [[3, "team_members"]]],
    ["CREATE TABLE AS TABLE t", `CREATE TABLE copy AS TABLE team_members;`, [[1, "team_members"]]],
    ["top-level CREATE MATERIALIZED VIEW AS SELECT", `CREATE MATERIALIZED VIEW mv AS SELECT * FROM team_members;`, [[1, "team_members"]]],
    ["WITH … ) TABLE t", `WITH x AS (SELECT 1) TABLE team_members;`, [[1, "team_members"]]],
    ["WITH a AS (…), b AS (…) TABLE t", `WITH a AS (SELECT 1), b AS (SELECT 2) TABLE team_members;`, [[1, "team_members"]]],
    ["FOR r IN TABLE t", doBlock(`FOR r IN TABLE team_members LOOP NULL; END LOOP;`), [[3, "team_members"]]],
    ["INSERT INTO u AS a TABLE t", `INSERT INTO other_t AS o TABLE team_members;`, [[1, "team_members"]]],
    ["INSERT INTO u OVERRIDING SYSTEM VALUE TABLE t", `INSERT INTO other_t OVERRIDING SYSTEM VALUE TABLE team_members;`, [[1, "team_members"]]],
    ["INSERT INTO u AS a (cols) OVERRIDING USER VALUE TABLE t", `INSERT INTO other_t AS o (a) OVERRIDING USER VALUE TABLE team_members;`, [[1, "team_members"]]],
    ["CURSOR FOR TABLE t", doBlock(`DECLARE c CURSOR FOR TABLE team_members;`), [[3, "team_members"]]],
    ["CURSOR WITH HOLD FOR TABLE t", doBlock(`DECLARE c CURSOR WITH HOLD FOR TABLE team_members;`), [[3, "team_members"]]],
    // Identifier characters >= U+0080: a fullwidth letter before `$x$` must not open a dollar quote
    // that swallows the statement between the two (U+FF21 is above the old \uDFFF ceiling).
    ["top level: fullwidth letter before $x$", `SELECT 1 AS Ａ$x$;\nUPDATE team_members SET a = 1;\nSELECT 2 AS Ａ$x$;`, [[2, "team_members"]]],
    ["DO body: fullwidth letter before $x$", doBlock(`PERFORM 1 AS Ａ$x$;\nUPDATE team_members SET a = 1;\nPERFORM 2 AS Ａ$x$;`), [[4, "team_members"]]],
    // A single-literal EXECUTE is a nested unit: its references are read like the body's.
    ["EXECUTE of a DML literal", doBlock(`EXECUTE 'UPDATE team_members SET a = 1';`), [[3, "team_members"]]],
    ["EXECUTE of a dollar-quoted DML literal", doBlock(`EXECUTE $q$UPDATE team_members SET a = 1$q$;`), [[3, "team_members"]]],
    ["EXECUTE of an E-string DML literal (\\' only)", doBlock(`EXECUTE E'UPDATE team_members SET a = \\'x\\'';`), [[3, "team_members"]]],
    ["EXECUTE … INTO … USING of a DML literal", doBlock(`EXECUTE 'UPDATE team_members SET a = $1 RETURNING a' INTO n USING v;`), [[3, "team_members"]]],
    ["EXECUTE … USING (no INTO) of a DML literal", doBlock(`EXECUTE 'UPDATE team_members SET a = $1' USING v;`), [[3, "team_members"]]],
    ["EXECUTE of CREATE TABLE AS SELECT", doBlock(`EXECUTE 'CREATE TABLE c AS SELECT * FROM team_members';`), [[3, "team_members"]]],
    ["EXECUTE of CREATE MATERIALIZED VIEW AS SELECT", doBlock(`EXECUTE 'CREATE MATERIALIZED VIEW c AS SELECT * FROM team_members';`), [[3, "team_members"]]],
    ["EXECUTE of DDL followed by DML in one literal", doBlock(`EXECUTE 'ALTER TABLE u ADD COLUMN c int; UPDATE team_members SET x = 1';`), [[3, "team_members"]]],
    ["multi-line EXECUTE literal: line of the DML inside it", doBlock(`EXECUTE 'ALTER TABLE u ADD COLUMN c int;\nUPDATE team_members SET x = 1';`), [[4, "team_members"]]],
    [
      "EXECUTE of DML after the grant was restored",
      doBlock([GRANT, tablesOf("team_members"), RESTORE, `EXECUTE 'UPDATE team_members SET a = 1';`].join("\n")),
      [[6, "team_members"]],
    ],
    [
      "EXECUTE of DML on a table the grant does not list",
      doBlock([GRANT, tablesOf("tenant_members"), `EXECUTE 'UPDATE team_members SET a = 1';`, RESTORE].join("\n")),
      [[5, "team_members"]],
    ],
    // State tracking.
    [
      "grant → DML → restore → DML (only the last DML is refused)",
      doBlock([GRANT, tablesOf("team_members"), `UPDATE team_members SET a = 1;`, RESTORE, `UPDATE team_members SET a = 2;`].join("\n")),
      [[7, "team_members"]],
    ],
    [
      "grant missing the table",
      doBlock([GRANT, tablesOf("tenant_members"), `UPDATE team_members SET a = 1;`, RESTORE].join("\n")),
      [[5, "team_members"]],
    ],
    [
      "near-name list (tenant_members granted, team_members written)",
      doBlock([GRANT, tablesOf("tenant_member,team_member,tenant_members"), `UPDATE team_members SET a = 1;`, RESTORE].join("\n")),
      [[5, "team_members"]],
    ],
    [
      "one statement over two forced tables, only one granted",
      doBlock([GRANT, tablesOf("team_members"), `UPDATE team_members m SET a = 1 FROM tenant_members t WHERE true;`, RESTORE].join("\n")),
      [[5, "tenant_members"]],
    ],
    [
      "non-literal bypass_tables",
      doBlock([GRANT, `PERFORM set_config('app.bypass_tables', v_tables, true);`, `UPDATE team_members SET a = 1;`, RESTORE].join("\n")),
      [[5, "team_members"]],
    ],
    [
      "bypass_rls restored to a non-'on' literal before the DML",
      doBlock([GRANT, tablesOf("team_members"), `PERFORM set_config('app.bypass_rls', 'off', true);`, `UPDATE team_members SET a = 1;`].join("\n")),
      [[6, "team_members"]],
    ],
    [
      "grant given the wrong value ('ona' is not 'on')",
      doBlock([`PERFORM set_config('app.bypass_rls', 'ona', true);`, tablesOf("team_members"), `UPDATE team_members SET a = 1;`].join("\n")),
      [[5, "team_members"]],
    ],
    [
      "grant given the wrong value ('on ' with a trailing space is not 'on')",
      doBlock([`PERFORM set_config('app.bypass_rls', 'on ', true);`, tablesOf("team_members"), `UPDATE team_members SET a = 1;`].join("\n")),
      [[5, "team_members"]],
    ],
  ];

  for (const [name, sql, expected] of refused) {
    it(`refuses: ${name}`, () => {
      addForceBase();
      addMigration(CASE_DIR, sql);

      const r = runGate();

      expect(r.status).toBe(1);
      expect(hitLinesOf(r.stderr)).toEqual(expected.map(([line, table]) => `  ${hitLine(line, table)}`));
    });
  }

  it("refuses a table forced in an earlier migration and written in a later one", () => {
    addMigration("20260101000000_force_one", `ALTER TABLE team_members FORCE ROW LEVEL SECURITY;`);
    addMigration("20260101000001_write", `UPDATE team_members SET a = 1;`);

    const r = runGate();

    expect(r.status).toBe(1);
    expect(r.stderr).toContain("MIGRATION_RLS_DML: 20260101000001_write:1: team_members");
  });
});

describe("check-migration-rls-dml: ALTER TABLE … RENAME TO moves FORCE membership", () => {
  it("refuses DML on the new name", () => {
    addMigration(FORCE_DIR, `ALTER TABLE team_members FORCE ROW LEVEL SECURITY;`);
    addMigration(CASE_DIR, `ALTER TABLE team_members RENAME TO team_members_v2;\nUPDATE team_members_v2 SET a = 1;`);

    const r = runGate();

    expect(r.status).toBe(1);
    expect(hitLinesOf(r.stderr)).toEqual([`  ${hitLine(2, "team_members_v2")}`]);
  });

  it("passes DML on the old name, which is no longer the forced table", () => {
    addMigration(FORCE_DIR, `ALTER TABLE team_members FORCE ROW LEVEL SECURITY;`);
    addMigration(CASE_DIR, `ALTER TABLE team_members RENAME TO team_members_v2;\nUPDATE team_members SET a = 1;`);

    const r = runGate();

    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
  });

  it("does not treat RENAME COLUMN … TO as a table rename", () => {
    addMigration(FORCE_DIR, `ALTER TABLE team_members FORCE ROW LEVEL SECURITY;`);
    addMigration(CASE_DIR, `ALTER TABLE team_members RENAME COLUMN a TO b;\nUPDATE team_members SET b = 1;`);

    const r = runGate();

    expect(r.status).toBe(1);
    expect(hitLinesOf(r.stderr)).toEqual([`  ${hitLine(2, "team_members")}`]);
  });
});

describe("check-migration-rls-dml: fail closed", () => {
  // [name, sql, file line, full reason, ...further [line, reason] pairs]; the UNPARSED lines must equal exactly these.
  const failClosed = [
    [
      "set_config(bypass_rls, …, false)",
      doBlock([`PERFORM set_config('app.bypass_rls', 'on', false);`].join("\n")),
      3,
      R_SESSION("app.bypass_rls"),
    ],
    [
      "set_config(bypass_tables, …, false)",
      doBlock([GRANT, `PERFORM set_config('app.bypass_tables', 'team_members', false);`, RESTORE].join("\n")),
      4,
      R_SESSION("app.bypass_tables"),
    ],
    ["grant inside IF", doBlock([`IF true THEN`, GRANT, `END IF;`].join("\n")), 4, R_NESTED],
    ["grant inside LOOP", doBlock([`FOR r IN SELECT 1 LOOP`, GRANT, `END LOOP;`].join("\n")), 4, R_NESTED],
    [
      "grant inside a nested BEGIN … EXCEPTION",
      doBlock([`BEGIN`, GRANT, `EXCEPTION WHEN OTHERS THEN NULL;`, `END;`].join("\n")),
      4,
      R_NESTED,
    ],
    ["grant inside CASE", doBlock([`CASE WHEN true THEN`, GRANT, `END CASE;`].join("\n")), 4, R_NESTED],
    [
      "grant inside an EXCEPTION handler",
      doBlock([`BEGIN NULL; EXCEPTION WHEN OTHERS THEN`, GRANT, `END;`].join("\n")),
      4,
      R_NESTED,
    ],
    [
      "no restore",
      doBlock([GRANT, tablesOf("team_members"), `UPDATE team_members SET a = 1;`].join("\n")),
      3,
      R_NOT_RESTORED,
    ],
    [
      "bypass_tables literal inside IF",
      doBlock([`IF true THEN`, tablesOf("team_members"), `END IF;`].join("\n")),
      4,
      R_NESTED,
    ],
    [
      "bypass_tables literal inside LOOP",
      doBlock([`FOR r IN SELECT 1 LOOP`, tablesOf("team_members"), `END LOOP;`].join("\n")),
      4,
      R_NESTED,
    ],
    [
      "bypass_tables literal inside an EXCEPTION handler",
      doBlock([`BEGIN NULL; EXCEPTION WHEN OTHERS THEN`, tablesOf("team_members"), `END;`].join("\n")),
      4,
      R_NESTED,
    ],
    // Restores must sit at the body's top block after the last grant.
    [
      "bypass_rls restore inside IF",
      doBlock([GRANT, tablesOf("team_members"), `UPDATE team_members SET a = 1;`, `IF true THEN`, RESTORE, `END IF;`].join("\n")),
      7,
      R_NESTED,
      // the refused restore is not applied, so the grant is still open at the end
      [3, R_NOT_RESTORED],
    ],
    [
      "bypass_rls restore inside LOOP",
      doBlock([GRANT, `FOR r IN SELECT 1 LOOP`, RESTORE, `END LOOP;`].join("\n")),
      5,
      R_NESTED,
      // the refused restore is not applied, so the grant is still open at the end
      [3, R_NOT_RESTORED],
    ],
    [
      "bypass_tables '' restore inside a nested block",
      doBlock([GRANT, tablesOf("team_members"), `BEGIN`, tablesOf(""), `END;`, RESTORE].join("\n")),
      6,
      R_NESTED,
    ],
    [
      "bypass_rls restore inside an EXCEPTION handler",
      doBlock([GRANT, `BEGIN NULL; EXCEPTION WHEN OTHERS THEN`, RESTORE, `END;`].join("\n")),
      5,
      R_NESTED,
      // the refused restore is not applied, so the grant is still open at the end
      [3, R_NOT_RESTORED],
    ],
    // SET / RESET.
    ["SET LOCAL app.bypass_rls in a DO body", doBlock(`SET LOCAL app.bypass_rls = 'on';`), 3, R_SET_BYPASS_DO],
    ["RESET app.bypass_tables in a DO body", doBlock(`RESET app.bypass_tables;`), 3, R_SET_BYPASS_DO],
    ["EXECUTE of SET LOCAL app.bypass_rls", doBlock(`EXECUTE 'SET LOCAL app.bypass_rls = on';`), 3, R_SET_BYPASS_LIT],
    [
      "RESET ALL after a grant",
      doBlock([GRANT, tablesOf("team_members"), `RESET ALL;`, `UPDATE team_members SET a = 1;`, RESTORE].join("\n")),
      5,
      R_UNKNOWN_SETTING,
    ],
    [
      "EXECUTE of RESET ALL after a grant",
      doBlock([GRANT, tablesOf("team_members"), `EXECUTE 'RESET ALL';`, `UPDATE team_members SET a = 1;`, RESTORE].join("\n")),
      5,
      R_UNKNOWN_SETTING,
    ],
    [
      "SET of a dotted name with a quoted tail after a grant",
      doBlock([GRANT, `SET LOCAL app."x" = 1;`, RESTORE].join("\n")),
      4,
      R_UNKNOWN_SETTING,
    ],
    [
      "pg_settings written inside a DO body",
      doBlock(
        [GRANT, tablesOf("team_members"), `UPDATE pg_settings SET setting = '' WHERE name = 'app.bypass_rls';`, `UPDATE team_members SET a = 1;`, RESTORE].join("\n"),
      ),
      5,
      R_PG_SETTINGS_DO,
    ],
    ["pg_settings inside an EXECUTE literal", doBlock(`EXECUTE 'UPDATE pg_catalog.pg_settings SET setting = 1';`), 3, R_PG_SETTINGS_LIT],
    // `x\uE000$a$` is one identifier to PostgreSQL; sql-scan would open a dollar quote there.
    ["U+E000 before $a$", `SELECT 1;\nSELECT 1 AS x\uE000$a$;\nUPDATE team_members SET a = 1;\nSELECT 1 AS y\uE000$a$;`, 2, R_SENTINEL],
    [
      "SET of a quoted setting name after a grant",
      doBlock([GRANT, `SET LOCAL "lock_timeout" TO 0;`, RESTORE].join("\n")),
      4,
      R_UNKNOWN_SETTING,
    ],
    [
      "EXECUTE of a SET of a quoted setting name after a grant",
      doBlock([GRANT, `EXECUTE 'SET LOCAL "lock_timeout" = 0';`, RESTORE].join("\n")),
      4,
      R_UNKNOWN_SETTING,
    ],
    [
      "SET of a quoted app.bypass_rls name",
      doBlock([GRANT, `SET LOCAL "app.bypass_rls" TO 'off';`, RESTORE].join("\n")),
      4,
      R_SET_BYPASS_DO,
    ],
    [
      "EXECUTE of a SET of a quoted app.bypass_rls name",
      doBlock([GRANT, `EXECUTE 'SET LOCAL "app.bypass_rls" = ''off''';`, RESTORE].join("\n")),
      4,
      R_SET_BYPASS_LIT,
    ],
    // set_config.
    [
      "set_config with a runtime-built name",
      doBlock([GRANT, `PERFORM set_config(v_name, 'off', true);`, RESTORE].join("\n")),
      4,
      R_FIRST_ARG,
    ],
    [
      "set_config with a concatenated name",
      doBlock([GRANT, `PERFORM set_config('app.' || 'bypass_rls', 'off', true);`, RESTORE].join("\n")),
      4,
      R_FIRST_ARG,
    ],
    [
      "set_config with an E-string name",
      doBlock([GRANT, `PERFORM set_config(E'app.bypass_rls', 'off', true);`, RESTORE].join("\n")),
      4,
      R_FIRST_ARG,
    ],
    [
      "set_config with a dollar-quoted name",
      doBlock([GRANT, `PERFORM set_config($n$app.bypass_rls$n$, 'off', true);`, RESTORE].join("\n")),
      4,
      R_FIRST_ARG,
    ],
    [
      "set_config of a bypass setting inside an EXECUTE literal",
      doBlock(`EXECUTE 'SELECT set_config(''app.bypass_rls'', ''on'', true)';`),
      3,
      R_SET_CONFIG_LIT("app.bypass_rls"),
    ],
    [
      "set_config behind a DDL literal's column default",
      doBlock(`EXECUTE 'ALTER TABLE u ADD COLUMN c text DEFAULT set_config(''app.bypass_tables'', ''team_members'', true)';`),
      3,
      R_SET_CONFIG_LIT("app.bypass_tables"),
    ],
    [
      "set_config with a runtime-built name inside an EXECUTE literal",
      doBlock(`EXECUTE 'SELECT set_config(v_name, ''off'', true)';`),
      3,
      R_FIRST_ARG,
    ],
    // E-string / U& EXECUTE operands that cannot be unquoted.
    ["EXECUTE of an E-string with an octal escape (\\073)", doBlock(`EXECUTE E'ALTER TABLE u ADD COLUMN c int\\073 UPDATE team_members SET x = 1';`), 3, R_ESCAPE],
    ["EXECUTE of an E-string with a hex escape (\\x3b)", doBlock(`EXECUTE E'ALTER TABLE u ADD COLUMN c int\\x3b UPDATE team_members SET x = 1';`), 3, R_ESCAPE],
    ["EXECUTE of an E-string with an octal name escape (\\137)", doBlock(`EXECUTE E'UPDATE team_members SET a = 1 WHERE app\\137x';`), 3, R_ESCAPE],
    ["EXECUTE of an E-string with a unicode escape", doBlock(`EXECUTE E'UPDATE team_members SET a = 1 -- \\u0041';`), 3, R_ESCAPE],
    ["EXECUTE of a U&'…' literal", doBlock(`EXECUTE U&'UPDATE team_members SET a = 1';`), 3, R_UNICODE],
    // Nested-unit restrictions.
    [
      "FORCE ROW LEVEL SECURITY inside a DO",
      doBlock(`ALTER TABLE other_t FORCE ROW LEVEL SECURITY;`),
      3,
      R_FORCE_DO,
    ],
    [
      "FORCE ROW LEVEL SECURITY inside an EXECUTE literal",
      doBlock(`EXECUTE 'ALTER TABLE other_t FORCE ROW LEVEL SECURITY';`),
      3,
      R_FORCE_LIT,
    ],
    ["RENAME of a FORCE table inside a DO", doBlock(`ALTER TABLE team_members RENAME TO team_members_v2;`), 3, R_RENAME_DO],
    [
      "RENAME of a FORCE table inside an EXECUTE literal",
      doBlock(`EXECUTE 'ALTER TABLE public.team_members RENAME TO team_members_v2';`),
      3,
      R_RENAME_LIT,
    ],
    [
      "DO inside an EXECUTE literal",
      doBlock(`EXECUTE 'DO $x$ BEGIN UPDATE team_members SET a = 1; END $x$';`),
      3,
      R_DO_IN_LIT,
    ],
    ["a prepared EXECUTE inside an EXECUTE literal", doBlock(`EXECUTE 'EXECUTE p(1)';`), 3, R_PREPARED],
    ["EXECUTE literal with an unterminated $ quote", doBlock(`EXECUTE 'SELECT $x$ 1';`), 3, R_LIT_QUOTE],
    // Dollar quotes.
    ["unterminated dollar quote", `DO $$\nBEGIN\nUPDATE team_members SET a = 1;\nEND;\n`, 1, "unterminated dollar quote"],
    [
      "unterminated Unicode dollar quote",
      `DO $é1$\nBEGIN\nUPDATE team_members SET a = 1;\nEND;\n`,
      1,
      "unterminated dollar quote",
      [1, "DO without a dollar-quoted body"],
    ],
    ["unrecognised dollar quote", `SELECT $ab-c$ 1 $ab-c$;`, 1, "unrecognised dollar quote", [1, "unrecognised dollar quote"]],
    [
      "full DO without a dollar-quoted body",
      `DO 'BEGIN UPDATE team_members SET a = 1; END';`,
      1,
      "DO without a dollar-quoted body",
    ],
  ];

  for (const [name, sql, line, reason, ...more] of failClosed) {
    it(`fails closed: ${name}`, () => {
      addForceBase();
      addMigration(CASE_DIR, sql);

      const r = runGate();

      expect(r.status).toBe(1);
      expect(linesWith(r.stderr, "MIGRATION_RLS_DML_UNPARSED")).toEqual([
        unparsedLine(line, reason),
        ...more.map(([l, why]) => unparsedLine(l, why)),
      ]);
    });
  }

  it("cannot be baselined away", () => {
    addForceBase();
    addMigration(CASE_DIR, doBlock(`EXECUTE U&'UPDATE team_members SET a = 1';`));
    setBaseline(`${CASE_DIR}  # baselined but still fails closed\n`);

    const r = runGate();

    expect(r.status).toBe(1);
    expect(linesWith(r.stderr, "MIGRATION_RLS_DML_UNPARSED")).toEqual([unparsedLine(3, R_UNICODE)]);
  });
});

describe("check-migration-rls-dml: dynamic EXECUTE", () => {
  // [name, body, file line(s) of the EXECUTE findings]; every shape is an EXECUTE that is not ONE plain literal.
  const dynamic = [
    ["format() of a literal", doBlock(`EXECUTE format('UPDATE %I SET a = 1', 'team_members');`), [3]],
    ["format() with %s of a variable", doBlock(`EXECUTE format('ALTER TABLE u ADD COLUMN c int %s', q);`), [3]],
    ["a DDL literal concatenated with a variable", doBlock(`EXECUTE 'ALTER TABLE u ADD COLUMN c int;' || q;`), [3]],
    ["SET LOCAL lock_timeout literal concatenated with a variable", doBlock(`EXECUTE 'SET LOCAL lock_timeout = 0; ' || q;`), [3]],
    ["two literals concatenated", doBlock(`EXECUTE 'ALTER TABLE u ADD COLUMN c int; ' || 'UPDATE team_members SET x = 1';`), [3]],
    ["a parenthesised literal", doBlock(`EXECUTE ('SELECT 1');`), [3]],
    ["two adjacent literals", doBlock(`EXECUTE 'SELECT'\n' 1';`), [3]],
    ["a function call", doBlock(`EXECUTE build_sql();`), [3]],
    ["a variable", doBlock(`EXECUTE v_sql;`), [3]],
    ["a variable with INTO / USING", doBlock(`EXECUTE v_sql INTO n USING v;`), [3]],
    ["a record column", doBlock([`FOR r IN SELECT 'UPDATE team_members SET x = 1' AS s LOOP`, `EXECUTE r.s;`, `END LOOP;`].join("\n")), [4]],
    ["a variable assigned a DML literal (DECLARE)", `DO $$\nDECLARE q text := 'UPDATE team_members SET x = 1';\nBEGIN\nEXECUTE q;\nEND\n$$;`, [4]],
    ["a variable assigned a dollar-quoted literal", `DO $$\nDECLARE q text := $q$UPDATE team_members SET x = 1$q$;\nBEGIN\nEXECUTE q;\nEND\n$$;`, [4]],
    [
      "catalog-derived names formatted into a literal-free EXECUTE",
      doBlock([`FOR r IN SELECT format('UPDATE %I SET a = 1', c.relname) AS s FROM pg_class c LOOP`, `EXECUTE r.s;`, `END LOOP;`].join("\n")),
      [4],
    ],
    ["literal-free EXECUTE next to prose naming a FORCE table", doBlock([`RAISE NOTICE 'backfilling team_members';`, `EXECUTE r.definition;`].join("\n")), [4]],
    ["a literal-free EXECUTE in a body that names no FORCE table", doBlock(`EXECUTE r.definition;`), [3]],
    ["a literal-free EXECUTE of a grant-covered body", doBlock([GRANT, tablesOf("team_members"), `EXECUTE v_sql;`, RESTORE].join("\n")), [5]],
    ["two findings in one body", doBlock([`EXECUTE v_a;`, `EXECUTE format('SELECT %s', v_b);`].join("\n")), [3, 4]],
  ];

  for (const [name, sql, lines] of dynamic) {
    it(`reports MIGRATION_RLS_DML_DYNAMIC: ${name}`, () => {
      addForceBase();
      addMigration(CASE_DIR, sql);

      const r = runGate();

      expect(r.status).toBe(1);
      expect(linesWith(r.stderr, "MIGRATION_RLS_DML_DYNAMIC")).toEqual(lines.map(dynamicLine));
      expect(linesWith(r.stderr, "MIGRATION_RLS_DML_UNPARSED")).toEqual([]);
    });
  }

  it("is baselinable, and --list prints it with the DYNAMIC prefix before the trailer", () => {
    addForceBase();
    addMigration(CASE_DIR, doBlock(`EXECUTE format('GRANT CONNECT ON DATABASE %I TO r', current_database());`));
    setBaseline(`${CASE_DIR}  # role DDL through format() with %I; no DML on a FORCE table\n`);

    const run = runGate();
    const list = runGate({ args: ["--list"] });

    expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: "" });
    expect(list.stdout.trim().split("\n")).toEqual([
      `MIGRATION_RLS_DML_DYNAMIC: ${CASE_DIR}:3`,
      `FORCE_STATEMENTS=3 FORCED_TABLES=3`,
    ]);
  });

  it("a baseline entry for a directory with a DYNAMIC finding is not stale", () => {
    addForceBase();
    addMigration(CASE_DIR, doBlock(`EXECUTE v_sql;`));
    setBaseline(`${CASE_DIR}  # shipped role DDL replay; executes no DML on a FORCE table\n`);

    const r = runGate();

    expect(r.status).toBe(0);
  });

  it("is not reported for EXECUTE FUNCTION, GRANT EXECUTE, or a single plain literal", () => {
    addForceBase();
    addMigration(
      CASE_DIR,
      doBlock(
        [
          `CREATE TRIGGER g BEFORE INSERT ON other_t FOR EACH ROW EXECUTE FUNCTION f();`,
          `GRANT EXECUTE ON FUNCTION f() TO r;`,
          `EXECUTE 'ALTER TABLE u ADD COLUMN c int';`,
        ].join("\n"),
      ),
    );

    const r = runGate();

    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
  });

  it("is not reported at the top level or inside a function body", () => {
    addForceBase();
    addMigration(
      CASE_DIR,
      `CREATE FUNCTION f() RETURNS void AS $$ BEGIN EXECUTE format('x %s', 1); END $$ LANGUAGE plpgsql;`,
    );

    const r = runGate();

    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
  });
});

describe("check-migration-rls-dml: passes", () => {
  // [name, sql, withForceBase]
  const passing = [
    [
      "full grant + COALESCE restore",
      doBlock([GRANT, tablesOf("team_members,tenant_members"), `UPDATE team_members m SET a = 1 FROM tenant_members t WHERE true;`, RESTORE].join("\n")),
      true,
    ],
    [
      "full grant + COALESCE restore with a Unicode dollar tag",
      doBlock([GRANT, tablesOf("team_members"), `UPDATE team_members SET a = 1;`, RESTORE].join("\n"), "$é1$"),
      true,
    ],
    ["DML before the table's FORCE in the same migration", `UPDATE team_members SET a = 1;\nALTER TABLE team_members FORCE ROW LEVEL SECURITY;`, false],
    ["NO FORCE then DML", `ALTER TABLE team_members NO FORCE ROW LEVEL SECURITY;\nUPDATE team_members SET a = 1;`, true],
    [
      "DML in a function body",
      `CREATE FUNCTION f() RETURNS void AS $$ BEGIN UPDATE team_members SET a = 1; END $$ LANGUAGE plpgsql;`,
      true,
    ],
    [
      "UPDATE in a comment or a string",
      [`-- UPDATE team_members SET a = 1;`, `/* DELETE FROM team_members; */`, `SELECT 'UPDATE team_members SET a = 1';`].join("\n"),
      true,
    ],
    ["a policy body is not an executed read", `CREATE POLICY p ON team_members USING (EXISTS (SELECT 1 FROM tenant_members));`, true],
    ["a CTE of the table's name is not the table", doBlock(`WITH team_members AS (SELECT 1) SELECT * FROM team_members;`), true],
    ["EXTRACT(… FROM …) and IS DISTINCT FROM are not table positions", doBlock(`v := extract(epoch FROM team_members) IS DISTINCT FROM team_members;`), true],
    ["a function in FROM is not a table", doBlock(`PERFORM 1 FROM team_members(1);`), true],
    ["an unforced table", doBlock(`UPDATE other_t SET a = 1;`), true],
    ["a non-public schema is not the forced table", doBlock(`UPDATE audit.team_members SET a = 1;`), true],
    ["EXECUTE of literal DDL", doBlock(`EXECUTE 'ALTER TABLE team_members ADD COLUMN x int';`), true],
    ["EXECUTE of literal DDL with a trailing semicolon", doBlock(`EXECUTE 'ALTER TABLE u ADD COLUMN c int;';`), true],
    ["EXECUTE 'SET LOCAL lock_timeout = 0' (single literal, no bypass)", doBlock(`EXECUTE 'SET LOCAL lock_timeout = 0';`), true],
    ["EXECUTE of an E-string whose only escapes are \\' and \\\\", doBlock(`EXECUTE E'ALTER TABLE u ADD COLUMN c text DEFAULT \\'a\\\\b\\'';`), true],
    ["EXECUTE of a dollar-quoted DDL literal", doBlock(`EXECUTE $q$ALTER TABLE u ADD COLUMN c int$q$;`), true],
    ["EXECUTE … INTO … USING of a literal that touches no FORCE table", doBlock(`EXECUTE 'SELECT $1' INTO n USING v;`), true],
    ["EXECUTE … USING (no INTO) of a literal that touches no FORCE table", doBlock(`EXECUTE 'PERFORM $1' USING v;`), true],
    ["a bare mention in prose is not a reference", doBlock(`RAISE NOTICE 'backfilling team_members';`), true],
    ["RAISE prose naming a FORCE table next to a single-literal EXECUTE", doBlock([`RAISE NOTICE 'altering team_members';`, `EXECUTE 'ALTER TABLE u ADD COLUMN x int';`].join("\n")), true],
    ["a string variable naming a FORCE table that is never executed", doBlock(`v := 'UPDATE team_members SET a = 1';`), true],
    [
      "grant + single-literal DML covered by the grant + restore",
      doBlock([GRANT, tablesOf("team_members"), `EXECUTE 'UPDATE team_members SET a = 1';`, RESTORE].join("\n")),
      true,
    ],
    [
      "grant + a literal that is DDL then DML on a granted table",
      doBlock([GRANT, tablesOf("team_members"), `EXECUTE 'ALTER TABLE u ADD COLUMN c int; UPDATE team_members SET a = 1';`, RESTORE].join("\n")),
      true,
    ],
    ["RESET ALL in a unit that never granted", doBlock(`RESET ALL;`), true],
    [
      "grant + UPDATE … SET \"col\" on a granted table (SET mid-statement is not a setting)",
      doBlock([GRANT, tablesOf("team_members"), `UPDATE team_members SET "a" = 1;`, RESTORE].join("\n")),
      true,
    ],
    [
      "SET LOCAL lock_timeout and RESET lock_timeout after a grant (plain names)",
      doBlock([GRANT, `SET LOCAL lock_timeout = 0;`, `RESET lock_timeout;`, RESTORE].join("\n")),
      true,
    ],
    [
      "set_config of an unrelated plain-literal setting after a grant",
      doBlock([GRANT, `PERFORM set_config('lock_timeout', '0', true);`, RESTORE].join("\n")),
      true,
    ],
    ["ALTER TABLE RENAME TO of an unforced table", doBlock(`ALTER TABLE other_t RENAME TO other_t2;`), true],
    ["RENAME COLUMN of a forced table is not a table rename", doBlock(`ALTER TABLE team_members RENAME COLUMN a TO b;`), true],
    [
      "LOCK / TRUNCATE / ON / ADD / FOR TABLE are not TABLE query forms",
      doBlock(
        [
          `LOCK TABLE team_members IN SHARE MODE;`,
          `TRUNCATE TABLE team_members;`,
          `GRANT SELECT ON TABLE team_members TO r;`,
          `ALTER PUBLICATION p ADD TABLE team_members;`,
          `CREATE PUBLICATION p2 FOR TABLE team_members;`,
        ].join("\n"),
      ),
      true,
    ],
    ["top level: a fullwidth-letter identifier holding $x$ twice is one word each time", `SELECT 1 AS Ａ$x$, 2 AS Ａ$x$;`, true],
    ["top level: a single fullwidth-letter identifier holding $x$ opens no dollar quote", `SELECT 1 AS Ａ$x$;`, true],
    ["DO body: a single fullwidth-letter identifier holding $x$ opens no dollar quote", doBlock(`PERFORM 1 AS Ａ$x$;`), true],
    ["ALTER / CREATE TABLE in a DO body are not TABLE query forms", doBlock([`ALTER TABLE team_members ADD COLUMN x int;`, `CREATE TABLE team_members_copy (id int);`].join("\n")), true],
    [
      "a bypass_tables literal and its '' restore at the unit's top block",
      doBlock([GRANT, tablesOf("team_members"), `UPDATE team_members SET a = 1;`, tablesOf(""), RESTORE].join("\n")),
      true,
    ],
    ["trigger EXECUTE FUNCTION is not dynamic SQL", doBlock(`CREATE TRIGGER g BEFORE INSERT ON other_t FOR EACH ROW EXECUTE FUNCTION f();`), true],
  ];

  for (const [name, sql, withBase] of passing) {
    it(`passes: ${name}`, () => {
      if (withBase) addForceBase();
      addMigration(CASE_DIR, sql);

      const r = runGate();

      expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
    });
  }

  it("passes the shipped grant-and-restore pattern (20261109162613 copied as a fixture)", () => {
    const dir = readdirSync(REAL_MIGRATIONS).find((d) => d.startsWith("20261109162613_"));
    expect(dir).toBeDefined();
    addMigration(
      FORCE_DIR,
      [
        `ALTER TABLE "service_account_tokens" FORCE ROW LEVEL SECURITY;`,
        `ALTER TABLE "access_requests" FORCE ROW LEVEL SECURITY;`,
      ].join("\n"),
    );
    addMigration(CASE_DIR, readFileSync(join(REAL_MIGRATIONS, dir, "migration.sql"), "utf8"));

    const r = runGate();

    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
  });

  it("passes a write in a migration that sorts before the FORCE", () => {
    addMigration("20260101000000_write", `UPDATE team_members SET a = 1;`);
    addMigration("20260101000001_force_later", `ALTER TABLE team_members FORCE ROW LEVEL SECURITY;`);

    const r = runGate();

    expect(r.status).toBe(0);
  });
});

describe("check-migration-rls-dml: baseline", () => {
  const writeSql = `UPDATE team_members SET a = 1;`;

  it("passes a hit baselined with a reason", () => {
    addForceBase();
    addMigration(CASE_DIR, writeSql);
    setBaseline(`${CASE_DIR}  # shipped before the gate; no rows existed to backfill\n`);

    const r = runGate();

    expect(r.status).toBe(0);
  });

  it("fails on a baseline entry with a short reason", () => {
    addForceBase();
    addMigration(CASE_DIR, writeSql);
    setBaseline(`${CASE_DIR}  # short\n`);

    const r = runGate();

    expect(r.status).toBe(1);
    expect(r.stderr).toContain("ALLOWLIST_ENTRY_WITHOUT_REASON");
  });

  it("fails on a baseline entry with no reason at all", () => {
    addForceBase();
    addMigration(CASE_DIR, writeSql);
    setBaseline(`${CASE_DIR}\n`);

    const r = runGate();

    expect(r.status).toBe(1);
    expect(r.stderr).toContain("ALLOWLIST_ENTRY_WITHOUT_REASON");
  });

  it("fails on a stale entry (migration no longer hits)", () => {
    addForceBase();
    addMigration(CASE_DIR, `SELECT 1;`);
    setBaseline(`${CASE_DIR}  # was a backfill once, no longer touches a forced table\n`);

    const r = runGate();

    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`STALE_ALLOWLIST_ENTRY: ${CASE_DIR}`);
  });

  it("fails on a stale entry naming a migration that does not exist", () => {
    addForceBase();
    setBaseline(`20990101000000_gone  # deleted migration kept in the baseline\n`);

    const r = runGate();

    expect(r.status).toBe(1);
    expect(r.stderr).toContain("STALE_ALLOWLIST_ENTRY: 20990101000000_gone");
  });

  it("names dir, line and table in the message", () => {
    addForceBase();
    addMigration(CASE_DIR, `SELECT 1;\n\nDELETE FROM tenant_members;`);

    const r = runGate();

    expect(r.status).toBe(1);
    expect(r.stderr).toContain(hitLine(3, "tenant_members"));
  });
});

describe("check-migration-rls-dml: --list", () => {
  it("prints every hit, baselined ones included, then the FORCE trailer", () => {
    addForceBase();
    addMigration(CASE_DIR, `SELECT 1;\n\nDELETE FROM tenant_members;\nUPDATE team_members SET a = 1;`);
    setBaseline(`${CASE_DIR}  # baselined; --list still prints it\n`);

    const r = runGate({ args: ["--list"] });

    expect(r.status).toBe(0);
    expect(r.stdout.trim().split("\n")).toEqual([
      `${CASE_DIR}:3:tenant_members`,
      `${CASE_DIR}:4:team_members`,
      `FORCE_STATEMENTS=3 FORCED_TABLES=3`,
    ]);
  });

  it("counts FORCE statements only, and ignores a commented-out FORCE", () => {
    addMigration(
      FORCE_DIR,
      [
        `-- ALTER TABLE a FORCE ROW LEVEL SECURITY;`,
        `ALTER TABLE b FORCE ROW LEVEL SECURITY;`,
        `/* ALTER TABLE c FORCE ROW LEVEL SECURITY; */`,
      ].join("\n"),
    );

    const r = runGate({ args: ["--list"] });

    expect(r.stdout.trim()).toBe(`FORCE_STATEMENTS=1 FORCED_TABLES=1`);
  });

  it("FORCED_TABLES is every table a FORCE names, not the final forced set (FORCE then NO FORCE)", () => {
    addMigration(
      FORCE_DIR,
      [
        `ALTER TABLE x FORCE ROW LEVEL SECURITY;`,
        `ALTER TABLE x NO FORCE ROW LEVEL SECURITY;`,
        `ALTER TABLE "public"."y" FORCE ROW LEVEL SECURITY;`,
        `ALTER TABLE ONLY public.y FORCE ROW LEVEL SECURITY;`,
      ].join("\n"),
    );

    const r = runGate({ args: ["--list"] });

    expect(r.stdout.trim()).toBe(`FORCE_STATEMENTS=3 FORCED_TABLES=2`);
  });
});

describe("check-migration-rls-dml: root override under CI", () => {
  it("refuses a root override without the fixture flag when CI is set", () => {
    addForceBase();

    const r = runGate({ env: { CI: "true", MIGRATION_RLS_DML_CHECK_FIXTURE: "" } });

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("MIGRATION_RLS_DML_CHECK_FIXTURE");
  });

  it("accepts the override under CI with the fixture flag", () => {
    addForceBase();

    const r = runGate({ env: { CI: "true" } });

    expect(r.status).toBe(0);
  });
});

describe("check-migration-rls-dml: real tree", () => {
  // Hit lines of the two originals, read off the shipped SQL (applied
  // migrations are checksummed, so the lines cannot move).
  const DEPARTURE = "20261101000000_team_tenant_departure";
  const REKEY = "20261104000000_team_key_rotation_rekey";
  const ORIGINAL_HITS = [
    `${DEPARTURE}:69:team_members`,
    `${DEPARTURE}:72:tenant_members`,
    `${DEPARTURE}:81:team_invitations`,
    `${DEPARTURE}:83:tenant_members`,
    `${DEPARTURE}:92:team_invitations`,
    `${DEPARTURE}:94:users`,
    `${DEPARTURE}:95:tenant_members`,
    `${DEPARTURE}:108:tenant_member_departures`,
    `${DEPARTURE}:110:audit_logs`,
    `${DEPARTURE}:111:users`,
    `${DEPARTURE}:119:team_invitations`,
    `${DEPARTURE}:121:users`,
    `${DEPARTURE}:122:tenant_member_departures`,
    `${DEPARTURE}:130:teams`,
    `${DEPARTURE}:132:team_members`,
    `${REKEY}:37:team_password_entries`,
    `${REKEY}:39:teams`,
    `${REKEY}:47:team_password_entries`,
    `${REKEY}:53:team_password_entry_histories`,
    `${REKEY}:54:attachments`,
    `${REKEY}:56:team_password_entries`,
    `${REKEY}:63:team_password_entries`,
    `${REKEY}:72:team_password_entry_histories`,
    `${REKEY}:74:team_password_entries`,
  ];
  // Hits per baselined directory, counted by reading each migration. The 121
  // was recounted without the gate: replay FORCE/NO FORCE over the earlier
  // migrations by regex, strip comments, split on `;`, and count
  // `UPDATE … SET` / FROM / JOIN / USING / INSERT INTO names that are forced.
  const COUNTS = {
    "20260321100000_unify_all_ids_to_uuid": 121,
    "20260415130000_audit_path_unification": 2,
    "20260418042050_unify_session_timeout_policy": 2,
    "20260418144000_flip_extension_token_family_not_null": 2,
    "20260418160000_clamp_session_timeout_min_to_5": 2,
    "20260430120002_admin_vault_reset_backfill": 5,
    "20260502000000_audit_anchor_publisher_phase2": 1,
    "20260519100000_replace_mobile_bridge_code_device_pubkey_with_jkt": 1,
    "20260522000100_access_request_requester": 1,
    "20260524060000_extension_dpop_sender_constrained": 1,
    "20260629000000_add_mcp_refresh_token_family_created_at": 2,
    "20260629000100_flip_mcp_refresh_token_family_created_at_not_null": 2,
    "20260725000000_hash_session_tokens_purge_plaintext": 1,
    [DEPARTURE]: 15,
    [REKEY]: 9,
  };

  // DYNAMIC findings per directory (shipped DO bodies whose EXECUTE is not one
  // plain literal), counted by grepping `EXECUTE` in each DO body by hand: role /
  // grant / policy / constraint / trigger DDL replays, none of them DML.
  const DYNAMIC_COUNTS = {
    "20260321110000_convert_id_columns_to_uuid_type": 6,
    "20260412100001_add_audit_outbox_worker_role": 1,
    "20260428170853_add_dcr_cleanup_worker_role_and_system_tenant": 1,
    "20260502000000_audit_anchor_publisher_phase2": 1,
    "20260611011121_revoke_public_connect_on_app_db": 1,
    "20260618000000_add_retention_gc_worker_role": 1,
    "20261019000000_rls_bypass_admits_report_mode": 4,
    "20261023010000_retire_dcr_cleanup_worker_role": 7,
  };

  const baselineDirs = () =>
    readFileSync(REAL_BASELINE, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "" && !l.trim().startsWith("#"))
      .map((l) => l.split("#")[0].trim());

  const DYNAMIC_PREFIX = "MIGRATION_RLS_DML_DYNAMIC: ";
  const list = () => {
    const r = runGate({ args: ["--list"], real: true });
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split("\n");
    const body = lines.slice(0, -1);
    return {
      hits: body.filter((l) => !l.startsWith(DYNAMIC_PREFIX)),
      dynamic: body.filter((l) => l.startsWith(DYNAMIC_PREFIX)).map((l) => l.slice(DYNAMIC_PREFIX.length)),
      trailer: lines[lines.length - 1],
    };
  };

  it("passes with exactly the baseline", () => {
    const r = runGate({ real: true });

    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
  });

  it("--list hits for the two originals equal the hand-written literal", () => {
    const { hits } = list();

    expect(hits.filter((h) => h.startsWith(DEPARTURE) || h.startsWith(REKEY))).toEqual(ORIGINAL_HITS);
  });

  it("the hit and dynamic directories together equal the baseline file's entries, with the literal per-directory counts", () => {
    const { hits, dynamic } = list();
    const counts = {};
    for (const h of hits) counts[h.split(":")[0]] = (counts[h.split(":")[0]] ?? 0) + 1;
    const dynamicCounts = {};
    for (const d of dynamic) dynamicCounts[d.split(":")[0]] = (dynamicCounts[d.split(":")[0]] ?? 0) + 1;

    expect([...new Set([...Object.keys(counts), ...Object.keys(dynamicCounts)])].sort()).toEqual([...baselineDirs()].sort());
    expect(counts).toEqual(COUNTS);
    expect(dynamicCounts).toEqual(DYNAMIC_COUNTS);
  });

  it("every baseline entry carries a reason of at least 10 characters", () => {
    const entries = readFileSync(REAL_BASELINE, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));

    expect(entries.length).toBe(22);
    for (const e of entries) expect(e.slice(e.indexOf("#") + 1).trim().length).toBeGreaterThanOrEqual(10);
  });

  it("the C1 fix-forward migration yields no hit", () => {
    const c1Dir = readdirSync(REAL_MIGRATIONS).find((d) => d.endsWith("_rls_backfill_rerun"));
    expect(c1Dir).toBe("20261110000000_rls_backfill_rerun");
    expect(existsSync(join(REAL_MIGRATIONS, c1Dir, "migration.sql"))).toBe(true);

    const { hits, dynamic } = list();

    expect(hits.filter((h) => h.startsWith(`${c1Dir}:`))).toEqual([]);
    expect(dynamic.filter((d) => d.startsWith(`${c1Dir}:`))).toEqual([]);
    expect(baselineDirs()).not.toContain(c1Dir);
  });

  it("FORCE counts equal an independent regex pass over the tree (comments stripped, NO FORCE excluded)", () => {
    const stripComments = (sql) => sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
    const FORCE_RE =
      /ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?((?:"[^"]+"|\w+)(?:\s*\.\s*(?:"[^"]+"|\w+))?)\s+(NO\s+)?FORCE\s+ROW\s+LEVEL\s+SECURITY/gi;
    const normalise = (name) =>
      name
        .replace(/\s+/g, "")
        .replace(/"/g, "")
        .replace(/^public\./i, "")
        .toLowerCase();
    let statements = 0;
    const tables = new Set();
    for (const dir of readdirSync(REAL_MIGRATIONS, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const file = join(REAL_MIGRATIONS, dir.name, "migration.sql");
      if (!existsSync(file)) continue;
      for (const m of stripComments(readFileSync(file, "utf8")).matchAll(FORCE_RE)) {
        if (m[2]) continue;
        statements++;
        tables.add(normalise(m[1]));
      }
    }

    const { trailer } = list();

    expect(trailer).toBe(`FORCE_STATEMENTS=${statements} FORCED_TABLES=${tables.size}`);
    expect(statements).toBeGreaterThan(0);
  });
});
