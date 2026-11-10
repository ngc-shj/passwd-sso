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
      "grant given the wrong value ('on ' is not 'on')",
      doBlock([`PERFORM set_config('app.bypass_rls', 'ona', true);`, tablesOf("team_members"), `UPDATE team_members SET a = 1;`].join("\n")),
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

describe("check-migration-rls-dml: fail closed", () => {
  // [name, sql, file line, message fragment]
  const failClosed = [
    [
      "set_config(bypass_rls, …, false)",
      doBlock([`PERFORM set_config('app.bypass_rls', 'on', false);`].join("\n")),
      3,
      "session-scoped",
    ],
    [
      "set_config(bypass_tables, …, false)",
      doBlock([GRANT, `PERFORM set_config('app.bypass_tables', 'team_members', false);`, RESTORE].join("\n")),
      4,
      "session-scoped",
    ],
    ["grant inside IF", doBlock([`IF true THEN`, GRANT, `END IF;`].join("\n")), 4, "nested block"],
    ["grant inside LOOP", doBlock([`FOR r IN SELECT 1 LOOP`, GRANT, `END LOOP;`].join("\n")), 4, "nested block"],
    [
      "grant inside a nested BEGIN … EXCEPTION",
      doBlock([`BEGIN`, GRANT, `EXCEPTION WHEN OTHERS THEN NULL;`, `END;`].join("\n")),
      4,
      "nested block",
    ],
    [
      "grant inside CASE",
      doBlock([`CASE WHEN true THEN`, GRANT, `END CASE;`].join("\n")),
      4,
      "nested block",
    ],
    [
      "grant inside an EXCEPTION handler",
      doBlock([`BEGIN NULL; EXCEPTION WHEN OTHERS THEN`, GRANT, `END;`].join("\n")),
      4,
      "nested block",
    ],
    [
      "no restore",
      doBlock([GRANT, tablesOf("team_members"), `UPDATE team_members SET a = 1;`].join("\n")),
      3,
      "not restored",
    ],
    ["EXECUTE of DML", doBlock(`EXECUTE 'UPDATE team_members SET a = 1';`), 3, "EXECUTE"],
    [
      "EXECUTE of a variable in a body that names a FORCE table",
      doBlock([`SELECT count(*) INTO n FROM team_members;`, `EXECUTE v_sql;`].join("\n")),
      4,
      "EXECUTE",
    ],
    [
      "FORCE ROW LEVEL SECURITY inside a DO",
      doBlock(`ALTER TABLE other_t FORCE ROW LEVEL SECURITY;`),
      3,
      "FORCE ROW LEVEL SECURITY",
    ],
    [
      "unterminated dollar quote",
      `DO $$\nBEGIN\nUPDATE team_members SET a = 1;\nEND;\n`,
      1,
      "unterminated dollar quote",
    ],
    [
      "unterminated Unicode dollar quote",
      `DO $é1$\nBEGIN\nUPDATE team_members SET a = 1;\nEND;\n`,
      1,
      "unterminated dollar quote",
    ],
    ["unrecognised dollar quote", `SELECT $ab-c$ 1 $ab-c$;`, 1, "unrecognised dollar quote"],
    [
      "full DO without a dollar-quoted body",
      `DO 'BEGIN UPDATE team_members SET a = 1; END';`,
      1,
      "DO without a dollar-quoted body",
    ],
  ];

  for (const [name, sql, line, fragment] of failClosed) {
    it(`fails closed: ${name}`, () => {
      addForceBase();
      addMigration(CASE_DIR, sql);

      const r = runGate();

      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`MIGRATION_RLS_DML_UNPARSED: ${CASE_DIR}:${line}: `);
      expect(r.stderr).toContain(fragment);
    });
  }

  it("cannot be baselined away", () => {
    addForceBase();
    addMigration(CASE_DIR, doBlock(`EXECUTE 'UPDATE team_members SET a = 1';`));
    setBaseline(`${CASE_DIR}  # baselined but still fails closed\n`);

    const r = runGate();

    expect(r.status).toBe(1);
    expect(r.stderr).toContain("MIGRATION_RLS_DML_UNPARSED");
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
    [
      "EXECUTE of literal DDL",
      doBlock(`EXECUTE format('ALTER TABLE %I ADD COLUMN x int', 'team_members');`),
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
  // Hits per baselined directory, counted by reading each migration.
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

  const baselineDirs = () =>
    readFileSync(REAL_BASELINE, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "" && !l.trim().startsWith("#"))
      .map((l) => l.split("#")[0].trim());

  const list = () => {
    const r = runGate({ args: ["--list"], real: true });
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split("\n");
    return { hits: lines.slice(0, -1), trailer: lines[lines.length - 1] };
  };

  it("passes with exactly the baseline", () => {
    const r = runGate({ real: true });

    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
  });

  it("--list hits for the two originals equal the hand-written literal", () => {
    const { hits } = list();

    expect(hits.filter((h) => h.startsWith(DEPARTURE) || h.startsWith(REKEY))).toEqual(ORIGINAL_HITS);
  });

  it("the hit directories equal the baseline file's entries, with the literal per-directory counts", () => {
    const { hits } = list();
    const counts = {};
    for (const h of hits) counts[h.split(":")[0]] = (counts[h.split(":")[0]] ?? 0) + 1;

    expect(Object.keys(counts).sort()).toEqual([...baselineDirs()].sort());
    expect(counts).toEqual(COUNTS);
  });

  it("every baseline entry carries a reason of at least 10 characters", () => {
    const entries = readFileSync(REAL_BASELINE, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));

    expect(entries.length).toBe(15);
    for (const e of entries) expect(e.slice(e.indexOf("#") + 1).trim().length).toBeGreaterThanOrEqual(10);
  });

  // C1 is written by a separate change; the cell reads it once it exists.
  const c1Dir = existsSync(REAL_MIGRATIONS)
    ? readdirSync(REAL_MIGRATIONS).find((d) => d.endsWith("_rls_backfill_rerun"))
    : undefined;
  it.skipIf(c1Dir === undefined)("the C1 fix-forward migration yields no hit", () => {
    const { hits } = list();

    expect(hits.filter((h) => h.startsWith(`${c1Dir}:`))).toEqual([]);
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
