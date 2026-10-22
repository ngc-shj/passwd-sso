/**
 * Real-DB tests for migration 20261023010000_retire_dcr_cleanup_worker_role.
 *
 * The migration retires passwd_dcr_cleanup_worker in place: NOLOGIN, no
 * password, no membership either way that confers it, no ACL entry naming it,
 * owning nothing. These cases re-arm the pre-migration state on the REAL role
 * and run the migration's own body against it.
 *
 * The migration file is wrapped in `BEGIN; … COMMIT;`, and that COMMIT would
 * commit an outer test transaction. So the file is first checked with the
 * migration-transaction gate's own analyze() to have exactly one BEGIN, one
 * COMMIT and no ROLLBACK, then its first and last statements are stripped and
 * the body runs inside a transaction that is always rolled back. The real role
 * is never dropped; after each case it must be back at rest.
 *
 *   (a) pre-migration state (LOGIN, password, the original grants, a column
 *       grant, a membership each way, default ACLs) → fully retired
 *   (b) the role owns an object → the body raises
 *   (c) the role was created by a NOSUPERUSER CREATEROLE role (the RDS
 *       master's shape) → that creator's ADMIN-only row is left, and the
 *       audit predicate accepts it
 *   (d) the role does not exist → no-op
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { Client } from "pg";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze } from "../../../scripts/checks/check-migration-transaction.mjs";
import {
  readLiveGrants,
  roleStateViolations,
  AUDITED_ROLES,
  RETIRED_ROLES,
} from "../../../scripts/audit-db-grants.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MIGRATION_SQL = resolve(
  REPO_ROOT,
  "prisma/migrations/20261023010000_retire_dcr_cleanup_worker_role/migration.sql",
);

const ROLE = "passwd_dcr_cleanup_worker";
const PROBE_HOLDER = "retire_dcr_probe_holder";
const PROBE_MEMBER = "retire_dcr_probe_member";
const PROBE_STANDIN = "retire_dcr_probe_standin";
const PROBE_ASIDE = "retire_dcr_probe_aside";
const PROBE_TABLE = "retire_dcr_probe_owned";
// PROBE_ASIDE is the REAL role under another name, so it is never swept: a
// leaked rename must fail the residue check, not be dropped.
const PROBE_ROLES = [PROBE_HOLDER, PROBE_MEMBER, PROBE_STANDIN];

/** SUPERUSER connection, resolved the way helpers.ts resolves "superuser". */
function superuserUrl(): string {
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("MIGRATION_DATABASE_URL or DATABASE_URL required");
  return url;
}

/**
 * Run `fn` inside a transaction on a dedicated superuser connection, rolled
 * back whatever happens — the body's own effects and the re-armed state both.
 */
async function inRolledBackTransaction(fn: (c: Client) => Promise<void>): Promise<void> {
  const c = new Client({ connectionString: superuserUrl() });
  await c.connect();
  try {
    await c.query("BEGIN");
    try {
      await fn(c);
    } finally {
      await c.query("ROLLBACK");
    }
  } finally {
    await c.end();
  }
}

/**
 * Probe roles live only inside rolled-back transactions; this is the
 * leak-safe sweep in case one ever commits.
 */
async function dropProbeRoles(c: Client): Promise<void> {
  for (const role of PROBE_ROLES) {
    await c.query(
      `DO $$ BEGIN
         IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
           EXECUTE format('REVOKE ALL ON DATABASE %I FROM ${role}', current_database());
           EXECUTE 'DROP OWNED BY ${role}';
           EXECUTE 'DROP ROLE ${role}';
         END IF;
       END $$`,
    );
  }
}

type RetiredState = {
  can_login: boolean;
  has_password: boolean;
  member_of: number;
  conferring_members: number;
  class_acl: number;
  column_acl: number;
  routine_acl: number;
  schema_acl: number;
  database_acl: number;
  default_acl: number;
  shdepend_acl: number;
  owned: number;
  can_connect: boolean;
};

/**
 * Everything C2's acceptance names, for this database. The same probe is read
 * before the body (every field armed) and after it (every field cleared), so
 * it is shown able to see what it later reports absent.
 */
async function retiredState(c: Client): Promise<RetiredState> {
  const named = `a.grantee = '${ROLE}'::regrole`;
  const { rows } = await c.query(
    `SELECT
       (SELECT rolcanlogin FROM pg_authid WHERE rolname = '${ROLE}') AS can_login,
       (SELECT rolpassword IS NOT NULL FROM pg_authid WHERE rolname = '${ROLE}') AS has_password,
       (SELECT count(*)::int FROM pg_auth_members WHERE member = '${ROLE}'::regrole) AS member_of,
       (SELECT count(*)::int FROM pg_auth_members
         WHERE roleid = '${ROLE}'::regrole AND (inherit_option OR set_option)) AS conferring_members,
       (SELECT count(*)::int FROM pg_class x, aclexplode(x.relacl) a WHERE ${named}) AS class_acl,
       (SELECT count(*)::int FROM pg_attribute x, aclexplode(x.attacl) a WHERE ${named}) AS column_acl,
       (SELECT count(*)::int FROM pg_proc x, aclexplode(x.proacl) a WHERE ${named}) AS routine_acl,
       (SELECT count(*)::int FROM pg_namespace x, aclexplode(x.nspacl) a WHERE ${named}) AS schema_acl,
       (SELECT count(*)::int FROM pg_database x, aclexplode(x.datacl) a
         WHERE x.datname = current_database() AND ${named}) AS database_acl,
       (SELECT count(*)::int FROM pg_default_acl x, aclexplode(x.defaclacl) a WHERE ${named}) AS default_acl,
       -- Catch-all over every catalog of this database: any ACL naming the role
       -- is recorded as an 'a' dependency.
       (SELECT count(*)::int FROM pg_shdepend
         WHERE refclassid = 'pg_authid'::regclass AND refobjid = '${ROLE}'::regrole AND deptype = 'a'
           AND dbid = (SELECT oid FROM pg_database WHERE datname = current_database())) AS shdepend_acl,
       (SELECT count(*)::int FROM pg_shdepend
         WHERE refclassid = 'pg_authid'::regclass AND refobjid = '${ROLE}'::regrole AND deptype = 'o') AS owned,
       has_database_privilege('${ROLE}', current_database(), 'CONNECT') AS can_connect`,
  );
  return rows[0] as RetiredState;
}

/** The migration's body: the file minus its own BEGIN and COMMIT. */
function migrationBody(): string {
  const sql = readFileSync(MIGRATION_SQL, "utf8");
  const whole = analyze(sql);
  expect(whole.beginCount).toBe(1);
  expect(whole.commitCount).toBe(1);
  expect(whole.rollbackCount).toBe(0);

  const trimmed = sql.trim();
  expect(trimmed.startsWith("BEGIN;"), "migration starts with BEGIN;").toBe(true);
  expect(trimmed.endsWith("COMMIT;"), "migration ends with COMMIT;").toBe(true);
  const body = trimmed.slice("BEGIN;".length, trimmed.length - "COMMIT;".length);

  // Guarded extraction: what is left is the DO block and nothing that could
  // end the test's transaction.
  const stripped = analyze(body);
  expect(stripped.beginCount).toBe(0);
  expect(stripped.commitCount).toBe(0);
  expect(stripped.rollbackCount).toBe(0);
  expect(stripped.ddlCount).toBeGreaterThan(0);
  return body;
}

describe("migration 20261023010000 retires passwd_dcr_cleanup_worker (real DB)", () => {
  let body: string;

  beforeAll(async () => {
    body = migrationBody();
    const c = new Client({ connectionString: superuserUrl() });
    await c.connect();
    try {
      await dropProbeRoles(c);
    } finally {
      await c.end();
    }
  });

  afterAll(async () => {
    const c = new Client({ connectionString: superuserUrl() });
    await c.connect();
    try {
      await dropProbeRoles(c);
    } finally {
      await c.end();
    }
  });

  // Residue check: every case rolled back, so the real role is exactly where
  // the migration left it and no probe survived.
  afterEach(async () => {
    const c = new Client({ connectionString: superuserUrl() });
    await c.connect();
    try {
      const { rows } = await c.query(
        `SELECT rolcanlogin, rolpassword IS NULL AS no_password,
                has_database_privilege(rolname, current_database(), 'CONNECT') AS can_connect
           FROM pg_authid WHERE rolname = $1`,
        [ROLE],
      );
      expect(rows, `${ROLE} must still exist`).toHaveLength(1);
      expect(rows[0]).toEqual({ rolcanlogin: false, no_password: true, can_connect: false });
      const probes = await c.query("SELECT rolname FROM pg_roles WHERE rolname = ANY($1)", [
        [...PROBE_ROLES, PROBE_ASIDE],
      ]);
      expect(probes.rows).toEqual([]);
    } finally {
      await c.end();
    }
  });

  it("(a) retires a role re-armed to its pre-migration state", async () => {
    await inRolledBackTransaction(async (c) => {
      await c.query(`ALTER ROLE ${ROLE} WITH LOGIN PASSWORD 'retire-dcr-test-only'`);
      await c.query(`GRANT SELECT, DELETE ON mcp_clients TO ${ROLE}`);
      await c.query(`GRANT UPDATE (id) ON mcp_clients TO ${ROLE}`);
      await c.query(`GRANT SELECT, INSERT ON audit_outbox TO ${ROLE}`);
      await c.query(`GRANT SELECT ON tenants TO ${ROLE}`);
      await c.query(
        `DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO ${ROLE}', current_database()); END $$`,
      );
      await c.query(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
      await c.query(
        `GRANT EXECUTE ON FUNCTION public.rls_bypass_enforced(), public.rls_bypass_admits(text) TO ${ROLE}`,
      );
      await c.query(`CREATE ROLE ${PROBE_HOLDER} NOLOGIN`);
      await c.query(`GRANT ${PROBE_HOLDER} TO ${ROLE}`);
      await c.query(`CREATE ROLE ${PROBE_MEMBER} NOLOGIN`);
      await c.query(`GRANT ${ROLE} TO ${PROBE_MEMBER}`);
      // Both shapes of default ACL: schema-scoped and global (no schema).
      await c.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${ROLE}`);
      await c.query(`ALTER DEFAULT PRIVILEGES GRANT USAGE ON SEQUENCES TO ${ROLE}`);

      const armed = await retiredState(c);
      expect(armed).toEqual({
        can_login: true,
        has_password: true,
        member_of: 1,
        conferring_members: 1,
        class_acl: expect.any(Number),
        column_acl: expect.any(Number),
        routine_acl: expect.any(Number),
        schema_acl: expect.any(Number),
        database_acl: 1,
        default_acl: 2,
        shdepend_acl: expect.any(Number),
        owned: 0,
        can_connect: true,
      });
      for (const field of ["class_acl", "column_acl", "routine_acl", "schema_acl", "shdepend_acl"] as const) {
        expect(armed[field], `${field} armed`).toBeGreaterThan(0);
      }

      await c.query(body);

      expect(await retiredState(c)).toEqual({
        can_login: false,
        has_password: false,
        member_of: 0,
        conferring_members: 0,
        class_acl: 0,
        column_acl: 0,
        routine_acl: 0,
        schema_acl: 0,
        database_acl: 0,
        default_acl: 0,
        shdepend_acl: 0,
        owned: 0,
        can_connect: false,
      });
    });
  });

  it("(b) raises when the role owns an object", async () => {
    await inRolledBackTransaction(async (c) => {
      await c.query(`CREATE TABLE ${PROBE_TABLE} (id int)`);
      await c.query(`ALTER TABLE ${PROBE_TABLE} OWNER TO ${ROLE}`);

      await expect(c.query(body)).rejects.toThrow(
        "passwd_dcr_cleanup_worker owns objects; reassign them before retiring it",
      );
    });
  });

  it("(b2) raises on a grant whose grantor is not the object's owner", async () => {
    // A REVOKE, even a superuser's, removes the owner's grants only, so a grant
    // made through a GRANT OPTION chain survives the loops.
    await inRolledBackTransaction(async (c) => {
      await c.query(`CREATE ROLE ${PROBE_HOLDER} NOLOGIN`);
      await c.query(`GRANT SELECT ON mcp_clients TO ${PROBE_HOLDER} WITH GRANT OPTION`);
      await c.query(`SET LOCAL ROLE ${PROBE_HOLDER}`);
      await c.query(`GRANT SELECT ON mcp_clients TO ${ROLE}`);
      await c.query("RESET ROLE");

      await expect(c.query(body)).rejects.toThrow(
        "passwd_dcr_cleanup_worker still holds a grant or user mapping the retirement could not revoke",
      );
    });
  });

  /**
   * (b3) Object kinds the revoke loops do not enumerate. Each row grants one to
   * the role inside the rolled-back transaction, asserts the catalog row now
   * names it (so a failed setup reads as a failure, not a pass), and expects
   * the postcondition to refuse. The audit reads none of these kinds, so the
   * postcondition is the only control on them.
   */
  const STILL_HOLDS =
    "passwd_dcr_cleanup_worker still holds a grant or user mapping the retirement could not revoke";
  // A user mapping is recorded as an OWNER dependency in pg_shdepend, so the
  // ownership guard refuses it before the postcondition is reached.
  const OWNS = "passwd_dcr_cleanup_worker owns objects; reassign them before retiring it";
  const unrevokedKinds: [string, string[], string, string][] = [
    [
      "a parameter",
      [`GRANT SET ON PARAMETER work_mem TO ${ROLE}`],
      `SELECT 1 FROM pg_parameter_acl pa, aclexplode(pa.paracl) x WHERE x.grantee = '${ROLE}'::regrole`,
      STILL_HOLDS,
    ],
    [
      "a type",
      ["CREATE TYPE retire_dcr_probe_t AS (a int)", `GRANT USAGE ON TYPE retire_dcr_probe_t TO ${ROLE}`],
      `SELECT 1 FROM pg_type t, aclexplode(t.typacl) x WHERE x.grantee = '${ROLE}'::regrole`,
      STILL_HOLDS,
    ],
    [
      "a language",
      [`GRANT USAGE ON LANGUAGE plpgsql TO ${ROLE}`],
      `SELECT 1 FROM pg_language l, aclexplode(l.lanacl) x WHERE x.grantee = '${ROLE}'::regrole`,
      STILL_HOLDS,
    ],
    [
      "a large object",
      [
        `DO $$ BEGIN EXECUTE format('GRANT SELECT ON LARGE OBJECT %s TO ${ROLE}', lo_create(0)); END $$`,
      ],
      `SELECT 1 FROM pg_largeobject_metadata o, aclexplode(o.lomacl) x WHERE x.grantee = '${ROLE}'::regrole`,
      STILL_HOLDS,
    ],
    [
      "a foreign-data wrapper",
      ["CREATE FOREIGN DATA WRAPPER retire_dcr_probe_fdw", `GRANT USAGE ON FOREIGN DATA WRAPPER retire_dcr_probe_fdw TO ${ROLE}`],
      `SELECT 1 FROM pg_foreign_data_wrapper w, aclexplode(w.fdwacl) x WHERE x.grantee = '${ROLE}'::regrole`,
      STILL_HOLDS,
    ],
    [
      "a foreign server",
      [
        "CREATE FOREIGN DATA WRAPPER retire_dcr_probe_fdw",
        "CREATE SERVER retire_dcr_probe_srv FOREIGN DATA WRAPPER retire_dcr_probe_fdw",
        `GRANT USAGE ON FOREIGN SERVER retire_dcr_probe_srv TO ${ROLE}`,
      ],
      `SELECT 1 FROM pg_foreign_server f, aclexplode(f.srvacl) x WHERE x.grantee = '${ROLE}'::regrole`,
      STILL_HOLDS,
    ],
    [
      "a user mapping",
      [
        "CREATE FOREIGN DATA WRAPPER retire_dcr_probe_fdw",
        "CREATE SERVER retire_dcr_probe_srv FOREIGN DATA WRAPPER retire_dcr_probe_fdw",
        `CREATE USER MAPPING FOR ${ROLE} SERVER retire_dcr_probe_srv`,
      ],
      `SELECT 1 FROM pg_user_mappings um WHERE um.umuser = '${ROLE}'::regrole`,
      OWNS,
    ],
    [
      "a tablespace",
      [`GRANT CREATE ON TABLESPACE pg_default TO ${ROLE}`],
      `SELECT 1 FROM pg_tablespace ts, aclexplode(ts.spcacl) x WHERE x.grantee = '${ROLE}'::regrole`,
      STILL_HOLDS,
    ],
  ];

  it.each(unrevokedKinds)("(b3) raises on %s, which the loops do not revoke", async (_kind, setup, named, expected) => {
    await inRolledBackTransaction(async (c) => {
      for (const statement of setup) await c.query(statement);
      expect((await c.query(named)).rowCount).toBeGreaterThan(0);

      await expect(c.query(body)).rejects.toThrow(expected);
    });
  });

  it("(f) the postcondition's catalogs are readable by a NOSUPERUSER CREATEROLE CREATEDB role", async () => {
    // On RDS the migration runs as the master, not a superuser; a catalog it
    // cannot read would fail the migrate task. The postcondition is taken from
    // the migration file itself, not restated here.
    const sql = readFileSync(MIGRATION_SQL, "utf8");
    // The IF EXISTS block immediately before its RAISE — the file has others.
    const raiseAt = sql.indexOf("RAISE EXCEPTION 'passwd_dcr_cleanup_worker still holds");
    const open = sql.lastIndexOf("  IF EXISTS (\n", raiseAt);
    const close = sql.lastIndexOf("\n  ) THEN", raiseAt);
    expect(raiseAt > 0 && open > 0 && open < close, "postcondition block found in the migration").toBe(true);
    const block = sql.slice(open + "  IF EXISTS (\n".length, close);
    expect(block).not.toContain("IF EXISTS");
    const probe = `SELECT EXISTS (${block.replace(/\btarget\b/g, `'${ROLE}'::regrole`)}) AS held`;

    await inRolledBackTransaction(async (c) => {
      await c.query(`CREATE ROLE ${PROBE_STANDIN} WITH NOLOGIN NOSUPERUSER CREATEROLE CREATEDB`);

      await c.query(`SET LOCAL ROLE ${PROBE_STANDIN}`);
      expect((await c.query(probe)).rows).toEqual([{ held: false }]);
      await c.query("RESET ROLE");

      await c.query(`GRANT SET ON PARAMETER work_mem TO ${ROLE}`);
      await c.query(`SET LOCAL ROLE ${PROBE_STANDIN}`);
      expect((await c.query(probe)).rows).toEqual([{ held: true }]);
    });
  });

  it("(c) leaves the ADMIN-only row of a NOSUPERUSER CREATEROLE creator, which the audit accepts", async () => {
    await inRolledBackTransaction(async (c) => {
      // Never DROP the real role: move it aside and let the stand-in create a
      // fresh one under the same name, as the RDS master did.
      await c.query(`ALTER ROLE ${ROLE} RENAME TO ${PROBE_ASIDE}`);
      await c.query(`CREATE ROLE ${PROBE_STANDIN} WITH NOLOGIN NOSUPERUSER CREATEROLE`);
      await c.query(`SET LOCAL ROLE ${PROBE_STANDIN}`);
      await c.query(`CREATE ROLE ${ROLE} WITH LOGIN`);
      await c.query("RESET ROLE");

      const creatorRow = `SELECT m.admin_option, m.inherit_option, m.set_option
                            FROM pg_auth_members m
                           WHERE m.roleid = '${ROLE}'::regrole AND m.member = '${PROBE_STANDIN}'::regrole`;
      // Precondition: PostgreSQL 16 gave the creator exactly this row.
      expect((await c.query(creatorRow)).rows).toEqual([
        { admin_option: true, inherit_option: false, set_option: false },
      ]);

      await c.query(body);

      expect((await c.query(creatorRow)).rows).toEqual([
        { admin_option: true, inherit_option: false, set_option: false },
      ]);

      const keys: string[] = await readLiveGrants(c);
      // Positive control: the audit sees the row the predicate must accept.
      expect(keys).toContain(`MEMBER:${PROBE_STANDIN}\t${ROLE}\tadmin=t,inherit=f,set=f`);
      const violations = roleStateViolations(keys, {
        auditedRoles: AUDITED_ROLES,
        retiredRoles: RETIRED_ROLES,
      }).filter((k: string) => k.includes(ROLE));
      expect(violations).toEqual([]);
    });
  });

  it("(d) is a no-op when the role does not exist", async () => {
    await inRolledBackTransaction(async (c) => {
      await c.query(`ALTER ROLE ${ROLE} RENAME TO ${PROBE_ASIDE}`);
      // Armed under its new name, so a body that reached it some other way
      // would show.
      await c.query(`ALTER ROLE ${PROBE_ASIDE} WITH LOGIN`);

      await c.query(body);

      const { rows } = await c.query(
        "SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname",
        [[ROLE, PROBE_ASIDE]],
      );
      expect(rows).toEqual([{ rolname: PROBE_ASIDE, rolcanlogin: true }]);
    });
  });
});
