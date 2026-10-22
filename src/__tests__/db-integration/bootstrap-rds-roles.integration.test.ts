/**
 * Real-DB tests for scripts/bootstrap-rds-roles.mjs convergence logic.
 *
 * The bootstrap script is the ONLY thing that creates the least-privilege roles
 * on a fresh RDS instance, and a review round found it was merely "skip if
 * exists" — so a re-run with a rotated password did nothing, and a role manually
 * escalated to SUPERUSER stayed escalated. These tests pin the convergent
 * behaviour that replaced it.
 *
 * T1 — creates the role with the intended attributes when absent.
 * T2 — a re-run with a DIFFERENT password installs the new password (the old
 *      one stops authenticating and the new one works).
 * T3 — a role escalated to SUPERUSER/BYPASSRLS/CREATEDB/CREATEROLE out of band
 *      is demoted back on re-run.
 * T4 — an inherited role membership is stripped on re-run.
 * T5 — a password containing quotes/backslashes/semicolons is installed
 *      verbatim (escapeLiteral, not string concatenation) and does not inject.
 * T10 — convergeRole as a NOSUPERUSER CREATEROLE role, the RDS master's shape:
 *       converges what it may, and refuses BEFORE sending the password what it
 *       may not.
 *
 * Uses THROWAWAY probe roles — never the real passwd_* roles, which this DB's
 * app and workers depend on.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { Client } from "pg";
import { spawnSync } from "node:child_process";
import {
  convergeRole,
  convergeRoles,
  runBootstrap,
  applyDeniedPrivileges,
  loadDeniedPolicy,
  grantRoutineExecute,
  grantWorkerSchemaPrivileges,
  ROLES,
} from "../../../scripts/bootstrap-rds-roles.mjs";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root, for spawning the CLI under test as a subprocess. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const PROBE = "bootstrap_probe_app";
const GRANTOR = "bootstrap_probe_grantor";
/** NOSUPERUSER CREATEROLE stand-in for the RDS master (T10). */
const STANDIN = "bootstrap_probe_standin";
/** A second converged role, for the all-or-nothing convergeRoles cases. */
const PROBE_B = "bootstrap_probe_app_b";

/** SUPERUSER connection — the same privilege level the migrate task uses. */
function superuserUrl(): string {
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("MIGRATION_DATABASE_URL or DATABASE_URL required");
  return url;
}

/**
 * Effective table privilege for a role, as the audit and the gate both ask it.
 *
 * One helper rather than the four inline copies this file had grown: a bare
 * `holds`, a hardcoded-UPDATE `holdsUpdate`, an anonymous IIFE repeating it, and
 * a two-column variant. Four copies of a two-line query is four places for the
 * probe to be subtly wrong while the tests still look thorough.
 */
async function hasTablePrivilege(
  su: Client,
  role: string,
  table: string,
  privilege: string,
): Promise<boolean> {
  const { rows } = await su.query(
    "SELECT has_table_privilege($1, $2, $3) AS granted",
    [role, table, privilege],
  );
  return rows[0].granted as boolean;
}

/**
 * The policy-file fixture both T6 and T7 need: a temp declaration pointed at by
 * `DB_DENIED_PRIVILEGES`, torn down with the probe table and roles.
 *
 * `vi.stubEnv`, not a direct assignment — check-test-hygiene gate (c) forbids
 * `process.env.X =` in a changed test file, and the integration setup wires no
 * global unstub, so this unstubs its own.
 *
 * Extracted because the two copies were byte-identical apart from the tmpdir
 * prefix and the table name — diffed before merging, so no condition handling
 * was averaged away. Hooks registered from a plain function called at
 * describe-body evaluation time behave identically to writing them inline.
 */
function useDeniedPolicyFixture(tmpPrefix: string, probeTable: string): { file: string } {
  const decl = { file: "" };
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), tmpPrefix));
    decl.file = join(dir, "denied.json");
    vi.stubEnv("DB_DENIED_PRIVILEGES", decl.file);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
    const su = new Client({ connectionString: superuserUrl() });
    await su.connect();
    try {
      await su.query(`DROP TABLE IF EXISTS ${probeTable}`);
      await dropProbeRoles(su);
    } finally {
      await su.end();
    }
  });

  return decl;
}

/**
 * Open a connection AS the probe role to prove a password actually works.
 *
 * Distinguishes an AUTH failure from an AUTHORIZATION failure: this database has
 * CONNECT revoked from PUBLIC (C3 migration), so a role without an explicit
 * GRANT CONNECT is rejected with "permission denied for database" AFTER the
 * password was accepted. Only 28P01 (invalid_password) means the password is
 * wrong — treating the authz error as "bad password" would make this probe
 * always report false and the test vacuous.
 */
async function canAuthenticate(password: string): Promise<boolean> {
  const base = new URL(superuserUrl());
  base.username = PROBE;
  base.password = password;
  const probe = new Client({ connectionString: base.toString() });
  try {
    await probe.connect();
    await probe.end();
    return true;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "28P01") return false; // invalid_password → password rejected
    if (code === "42501") return true; // insufficient_privilege → password OK
    throw e; // anything else is a real problem, not a pass/fail signal
  }
}

/** Grant the probe role CONNECT (revoked from PUBLIC by the C3 migration). */
async function grantConnect(su: Client): Promise<void> {
  await su.query(
    `DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO ${PROBE}', current_database()); END $$`,
  );
}

/**
 * Drop the probe roles. A granted database privilege is a dependency, so the
 * GRANT CONNECT some tests issue must be revoked first or DROP ROLE errors with
 * "cannot be dropped because some objects depend on it".
 */
async function dropProbeRoles(su: Client): Promise<void> {
  for (const role of [PROBE, PROBE_B, GRANTOR, STANDIN]) {
    await su.query(
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

async function roleAttrs(su: Client, name: string) {
  const { rows } = await su.query(
    `SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication, rolcanlogin
       FROM pg_roles WHERE rolname = $1`,
    [name],
  );
  return rows[0];
}

/**
 * Run `fn` on a dedicated superuser connection inside a transaction that is
 * always rolled back, so roles created and altered there (the stand-in, the
 * target, an escalated attribute) never reach the shared database.
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
 * A client that records every statement text and passes it through to `c`.
 * convergeRole uses `query` and `escapeLiteral` only; its JSDoc types the
 * parameter as pg.Client, hence the cast.
 */
function recordingClient(c: Client): { client: Client; statements: string[] } {
  const statements: string[] = [];
  const recorder = {
    escapeLiteral: (value: string) => c.escapeLiteral(value),
    query: (text: string, params?: unknown[]) => {
      statements.push(text);
      return c.query(text, params);
    },
  };
  return { client: recorder as unknown as Client, statements };
}

/** The preflight's ADMIN OPTION check — the positive control for the recorder. */
const ADMIN_PREFLIGHT_RE = /pg_has_role\(current_user, oid, 'MEMBER WITH ADMIN OPTION'\)/;

async function memberRows(c: Client, member: string, granted: string): Promise<number> {
  const { rowCount } = await c.query(
    `SELECT 1 FROM pg_auth_members m
       JOIN pg_roles r ON r.oid = m.member
       JOIN pg_roles g ON g.oid = m.roleid
      WHERE r.rolname = $1 AND g.rolname = $2`,
    [member, granted],
  );
  return rowCount ?? 0;
}

describe("bootstrap-rds-roles convergeRole (real DB)", () => {
  let su: Client;

  beforeAll(async () => {
    su = new Client({ connectionString: superuserUrl() });
    await su.connect();
  });

  afterAll(async () => {
    await dropProbeRoles(su);
    await su.end();
  });

  beforeEach(async () => {
    // Each test starts from a clean slate (leak-safe on prior failures).
    await dropProbeRoles(su);
  });

  it("T1: creates the role with the intended least-privilege attributes", async () => {
    await convergeRole(su, PROBE, "initial-pw");

    const a = await roleAttrs(su, PROBE);
    expect(a.rolsuper).toBe(false);
    expect(a.rolbypassrls).toBe(false);
    expect(a.rolcreatedb).toBe(false);
    expect(a.rolcreaterole).toBe(false);
    expect(a.rolreplication).toBe(false);
    expect(a.rolcanlogin).toBe(true);
  });

  it("T2: a re-run with a different password installs the NEW password", async () => {
    await convergeRole(su, PROBE, "old-password");
    // Let the probe actually complete a connection, so the assertion below is a
    // real end-to-end auth check rather than only a catalog inspection.
    await grantConnect(su);
    expect(await canAuthenticate("old-password")).toBe(true);

    // Re-run with a rotated password — the pre-fix script skipped this entirely.
    await convergeRole(su, PROBE, "new-password");

    expect(await canAuthenticate("new-password")).toBe(true);
    expect(await canAuthenticate("old-password")).toBe(false);
  });

  it("T3: demotes a role that was escalated out of band", async () => {
    await convergeRole(su, PROBE, "pw");
    // Simulate an operator (or attacker) escalating the role. REPLICATION is
    // included deliberately: it lets a role stream the whole database, and an
    // earlier revision of the attribute list omitted NOREPLICATION, so a
    // re-run demoted SUPERUSER/BYPASSRLS but silently left REPLICATION set.
    await su.query(
      `ALTER ROLE ${PROBE} WITH SUPERUSER BYPASSRLS CREATEDB CREATEROLE REPLICATION`,
    );
    const escalated = await roleAttrs(su, PROBE);
    expect(escalated.rolsuper).toBe(true);
    expect(escalated.rolbypassrls).toBe(true);
    expect(escalated.rolreplication).toBe(true);

    await convergeRole(su, PROBE, "pw");

    const a = await roleAttrs(su, PROBE);
    expect(a.rolsuper).toBe(false);
    expect(a.rolbypassrls).toBe(false);
    expect(a.rolcreatedb).toBe(false);
    expect(a.rolcreaterole).toBe(false);
    expect(a.rolreplication).toBe(false);
  });

  it("T4: strips an inherited role membership", async () => {
    await convergeRole(su, PROBE, "pw");
    await su.query(`CREATE ROLE ${GRANTOR} NOLOGIN`);
    await su.query(`GRANT ${GRANTOR} TO ${PROBE}`);

    const before = await su.query(
      `SELECT 1 FROM pg_auth_members m
         JOIN pg_roles r ON r.oid = m.member
        WHERE r.rolname = $1`,
      [PROBE],
    );
    expect(before.rowCount).toBe(1);

    await convergeRole(su, PROBE, "pw");

    const after = await su.query(
      `SELECT 1 FROM pg_auth_members m
         JOIN pg_roles r ON r.oid = m.member
        WHERE r.rolname = $1`,
      [PROBE],
    );
    expect(after.rowCount).toBe(0);
  });

  it("T5: installs a password with quotes/backslashes/semicolons verbatim", async () => {
    // Adversarial: a naive string concat would either break the DDL or inject.
    const nasty = "p'w\\x\"; DROP ROLE postgres;--";

    await convergeRole(su, PROBE, nasty);
    await grantConnect(su);

    expect(await canAuthenticate(nasty)).toBe(true);
    // The injected statement must NOT have run — the superuser role still exists
    // and our own connection is still usable.
    const { rows } = await su.query("SELECT 1 AS ok");
    expect(rows[0].ok).toBe(1);
  });

  /**
   * T10 — the RDS master is not a superuser. It may CREATE a role with every
   * attribute, but `ALTER ROLE … NOSUPERUSER / NOBYPASSRLS / NOREPLICATION` is
   * refused even as a no-op, and a refused statement carrying the password is
   * written to the server log.
   *
   * Reproduced with a NOSUPERUSER CREATEROLE stand-in that creates the target
   * itself (`SET LOCAL ROLE`), so it holds ADMIN OPTION on it exactly as the
   * master does over the roles it created. Each case runs inside a rolled-back
   * transaction on its own superuser connection; the real superuser sets
   * whatever the stand-in could not.
   */
  describe("T10: convergeRole as a non-superuser CREATEROLE role", () => {
    async function createStandIn(c: Client): Promise<void> {
      await c.query(`CREATE ROLE ${STANDIN} WITH NOLOGIN NOSUPERUSER CREATEROLE CREATEDB`);
    }

    it("converges an existing target it created, without a SUPERUSER-class clause", async () => {
      await inRolledBackTransaction(async (c) => {
        await createStandIn(c);
        await c.query(`SET LOCAL ROLE ${STANDIN}`);
        await c.query(`CREATE ROLE ${PROBE} WITH NOLOGIN CREATEDB PASSWORD 'old-pw'`);

        // The environment reproduces RDS: the statement the previous
        // convergeRole sent is refused here (without its PASSWORD clause, so
        // no password reaches the server log).
        await c.query("SAVEPOINT old_alter");
        let refused: { code?: string; message?: string; detail?: string } | undefined;
        try {
          await c.query(
            `ALTER ROLE ${PROBE} WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`,
          );
        } catch (e) {
          refused = e as typeof refused;
        }
        await c.query("ROLLBACK TO SAVEPOINT old_alter");
        expect(refused?.code).toBe("42501");
        expect(`${refused?.message} ${refused?.detail}`).toContain(
          "Only roles with the SUPERUSER attribute may change the SUPERUSER attribute",
        );

        const { client, statements } = recordingClient(c);
        await convergeRole(client, PROBE, "new-pw");

        const alters = statements.filter((s) => s.startsWith("ALTER ROLE"));
        expect(alters).toHaveLength(1);
        expect(alters[0]).toContain(`ALTER ROLE ${PROBE} WITH LOGIN NOCREATEDB NOCREATEROLE PASSWORD`);
        expect(alters[0]).not.toMatch(/SUPERUSER|BYPASSRLS|REPLICATION/);

        await c.query("RESET ROLE");
        const a = await roleAttrs(c, PROBE);
        expect(a).toEqual({
          rolsuper: false,
          rolbypassrls: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolreplication: false,
          rolcanlogin: true,
        });
      });
    });

    it.each(["rolsuper", "rolbypassrls", "rolreplication"] as const)(
      "refuses a target with %s set, before sending the password",
      async (attr) => {
        const clause = { rolsuper: "SUPERUSER", rolbypassrls: "BYPASSRLS", rolreplication: "REPLICATION" }[attr];
        await inRolledBackTransaction(async (c) => {
          await createStandIn(c);
          await c.query(`SET LOCAL ROLE ${STANDIN}`);
          await c.query(`CREATE ROLE ${PROBE} WITH LOGIN`);
          await c.query("RESET ROLE");
          // Only a real superuser can set it — and only one can clear it.
          await c.query(`ALTER ROLE ${PROBE} WITH ${clause}`);
          await c.query(`SET LOCAL ROLE ${STANDIN}`);

          const { client, statements } = recordingClient(c);
          await expect(convergeRole(client, PROBE, "pw")).rejects.toThrow(
            `role ${PROBE} has ${attr} set. Only a real superuser can clear it (on RDS, AWS support)`,
          );

          expect(statements.some((s) => ADMIN_PREFLIGHT_RE.test(s))).toBe(true);
          expect(statements.filter((s) => /PASSWORD/i.test(s))).toEqual([]);

          await c.query("RESET ROLE");
          expect((await roleAttrs(c, PROBE))[attr]).toBe(true);
        });
      },
    );

    it("refuses a target it lacks ADMIN OPTION on, before sending the password", async () => {
      await inRolledBackTransaction(async (c) => {
        await createStandIn(c);
        // Created by the real superuser, not the stand-in.
        await c.query(`CREATE ROLE ${PROBE} WITH NOLOGIN`);
        await c.query(`SET LOCAL ROLE ${STANDIN}`);

        const { client, statements } = recordingClient(c);
        await expect(convergeRole(client, PROBE, "pw")).rejects.toThrow(
          `role ${PROBE}: the current role lacks ADMIN OPTION on it`,
        );

        // Positive control: the recorder saw the preflight, so the empty
        // PASSWORD list below is about what was sent, not about a recorder
        // that saw nothing.
        expect(statements.some((s) => ADMIN_PREFLIGHT_RE.test(s))).toBe(true);
        expect(statements.filter((s) => /PASSWORD/i.test(s))).toEqual([]);

        await c.query("RESET ROLE");
        expect((await roleAttrs(c, PROBE)).rolcanlogin).toBe(false);
      });
    });

    it("throws naming a membership another grantor gave in a role it has no ADMIN on", async () => {
      await inRolledBackTransaction(async (c) => {
        await createStandIn(c);
        await c.query(`CREATE ROLE ${GRANTOR} WITH NOLOGIN`);
        await c.query(`SET LOCAL ROLE ${STANDIN}`);
        await c.query(`CREATE ROLE ${PROBE} WITH LOGIN`);
        await c.query("RESET ROLE");
        await c.query(`GRANT ${GRANTOR} TO ${PROBE}`);
        expect(await memberRows(c, PROBE, GRANTOR)).toBe(1);
        await c.query(`SET LOCAL ROLE ${STANDIN}`);

        // PostgreSQL 16 refuses the REVOKE (42501), which aborts the
        // transaction; the savepoint lets the row be read back afterwards.
        await c.query("SAVEPOINT converge");
        let caught: (Error & { cause?: { code?: string } }) | undefined;
        try {
          await convergeRole(c, PROBE, "pw");
        } catch (e) {
          caught = e as typeof caught;
        }
        await c.query("ROLLBACK TO SAVEPOINT converge");

        expect(caught?.message).toContain(
          `role ${PROBE}: could not revoke its membership in ${GRANTOR} (granted by `,
        );
        expect(caught?.cause?.code).toBe("42501");

        await c.query("RESET ROLE");
        expect(await memberRows(c, PROBE, GRANTOR)).toBe(1);
      });
    });

    it("creates an absent role with CREATE alone, then converges it with the narrowed ALTER", async () => {
      // The fresh-RDS path: the master creates every role. An ALTER right
      // after the CREATE (what convergeRole used to send) is refused here and
      // would log the password.
      await inRolledBackTransaction(async (c) => {
        await createStandIn(c);
        await c.query(`SET LOCAL ROLE ${STANDIN}`);
        // Precondition: this really runs as a non-superuser, and the role is absent.
        const { rows: me } = await c.query(
          "SELECT rolsuper FROM pg_roles WHERE rolname = current_user",
        );
        expect(me).toEqual([{ rolsuper: false }]);
        expect((await c.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [PROBE])).rowCount).toBe(0);

        const first = recordingClient(c);
        await convergeRole(first.client, PROBE, "pw1");
        expect(first.statements.filter((s) => s.startsWith("CREATE ROLE"))).toHaveLength(1);
        expect(first.statements.filter((s) => s.startsWith("ALTER ROLE"))).toEqual([]);

        const second = recordingClient(c);
        await convergeRole(second.client, PROBE, "pw2");
        expect(second.statements.some((s) => ADMIN_PREFLIGHT_RE.test(s))).toBe(true);
        const alters = second.statements.filter((s) => s.startsWith("ALTER ROLE"));
        expect(alters).toHaveLength(1);
        expect(alters[0]).toContain(`ALTER ROLE ${PROBE} WITH LOGIN NOCREATEDB NOCREATEROLE PASSWORD`);
        expect(alters[0]).not.toMatch(/SUPERUSER|BYPASSRLS|REPLICATION/);

        await c.query("RESET ROLE");
        expect(await roleAttrs(c, PROBE)).toEqual({
          rolsuper: false,
          rolbypassrls: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolreplication: false,
          rolcanlogin: true,
        });
        // The membership strip touches only rows where the role is the MEMBER:
        // the stand-in's ADMIN-only creator row in it survives both runs.
        expect(await memberRows(c, STANDIN, PROBE)).toBe(1);
      });
    });

    it("throws when a membership is still there after the revokes", async () => {
      // A REVOKE that removes nothing — what PostgreSQL 16 does for another
      // grantor's row when GRANTED BY is missing — must not pass silently.
      await inRolledBackTransaction(async (c) => {
        await createStandIn(c);
        await c.query(`SET LOCAL ROLE ${STANDIN}`);
        await c.query(`CREATE ROLE ${GRANTOR} WITH NOLOGIN`);
        await c.query(`CREATE ROLE ${PROBE} WITH LOGIN`);
        await c.query(`GRANT ${GRANTOR} TO ${PROBE}`);
        const dropsRevokes = {
          escapeLiteral: (value: string) => c.escapeLiteral(value),
          query: (text: string, params?: unknown[]) =>
            /^REVOKE /.test(text) ? Promise.resolve({ rows: [], rowCount: 0 }) : c.query(text, params),
        } as unknown as Client;

        await expect(convergeRole(dropsRevokes, PROBE, "pw")).rejects.toThrow(
          `role ${PROBE} is still a member of: ${GRANTOR} (granted by ${STANDIN})`,
        );
      });
    });

    it.each(["CREATEDB", "CREATEROLE"] as const)(
      "refuses, without sending the password, a caller holding only %s of CREATEROLE/CREATEDB",
      async (has) => {
      await inRolledBackTransaction(async (c) => {
        // The target exists and the caller holds ADMIN OPTION on it, so only
        // the caller's own attribute is missing.
        await c.query(`CREATE ROLE ${PROBE} WITH NOLOGIN`);
        await c.query(`CREATE ROLE ${STANDIN} WITH NOLOGIN NOSUPERUSER ${has}`);
        await c.query(`GRANT ${PROBE} TO ${STANDIN} WITH ADMIN OPTION, INHERIT FALSE, SET FALSE`);
        await c.query(`SET LOCAL ROLE ${STANDIN}`);

        const { client, statements } = recordingClient(c);
        await expect(convergeRole(client, PROBE, "pw")).rejects.toThrow(
          "the current role needs CREATEROLE and CREATEDB to converge roles",
        );
        expect(statements.some((s) => /rolcreaterole, rolcreatedb/.test(s))).toBe(true);
        expect(statements.filter((s) => /PASSWORD/i.test(s))).toEqual([]);
      });
      },
    );

    it("refuses to CREATE as a caller without CREATEDB, without sending the password", async () => {
      await inRolledBackTransaction(async (c) => {
        await c.query(`CREATE ROLE ${STANDIN} WITH NOLOGIN NOSUPERUSER CREATEROLE`);
        await c.query(`SET LOCAL ROLE ${STANDIN}`);

        const { client, statements } = recordingClient(c);
        await expect(convergeRole(client, PROBE, "pw")).rejects.toThrow(
          "the current role needs CREATEROLE and CREATEDB to converge roles",
        );
        expect(statements.filter((s) => /PASSWORD/i.test(s))).toEqual([]);
        await c.query("RESET ROLE");
        expect((await c.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [PROBE])).rowCount).toBe(0);
      });
    });

    it("revokes a membership it granted itself, in a role it created", async () => {
      await inRolledBackTransaction(async (c) => {
        await createStandIn(c);
        await c.query(`SET LOCAL ROLE ${STANDIN}`);
        await c.query(`CREATE ROLE ${GRANTOR} WITH NOLOGIN`);
        await c.query(`CREATE ROLE ${PROBE} WITH LOGIN`);
        await c.query(`GRANT ${GRANTOR} TO ${PROBE}`);
        expect(await memberRows(c, PROBE, GRANTOR)).toBe(1);

        await convergeRole(c, PROBE, "pw");

        expect(await memberRows(c, PROBE, GRANTOR)).toBe(0);
      });
    });
  });

  /**
   * convergeRoles runs every role in one transaction, so a refusal on a later
   * role or a failed membership strip leaves no role with a new password or
   * LOGIN. These cases COMMIT their fixtures (convergeRoles opens its own
   * transaction); beforeEach/afterAll drop every probe role.
   */
  describe("convergeRoles: all or nothing", () => {
    async function passwordHash(name: string): Promise<string | null> {
      const { rows } = await su.query("SELECT rolpassword FROM pg_authid WHERE rolname = $1", [name]);
      return rows[0]?.rolpassword ?? null;
    }

    async function asStandIn<T>(fn: (c: Client) => Promise<T>): Promise<T> {
      const c = new Client({ connectionString: superuserUrl() });
      await c.connect();
      try {
        await c.query(`SET ROLE ${STANDIN}`);
        return await fn(c);
      } finally {
        await c.end();
      }
    }

    beforeEach(async () => {
      await su.query(`CREATE ROLE ${STANDIN} WITH NOLOGIN NOSUPERUSER CREATEROLE CREATEDB`);
      // PROBE: created by the stand-in, so it holds ADMIN OPTION on it. On the
      // stand-in's own connection, so the shared `su` never leaves the superuser.
      await asStandIn((c) => c.query(`CREATE ROLE ${PROBE} WITH NOLOGIN PASSWORD 'old-a'`));
    });

    afterEach(async () => {
      // A local failure must not leave `su` as someone else for later tests.
      await su.query("RESET ROLE");
      const { rows } = await su.query("SELECT rolsuper FROM pg_roles WHERE rolname = current_user");
      expect(rows).toEqual([{ rolsuper: true }]);
    });

    it("refuses before any password is sent when a later role cannot be converged", async () => {
      // PROBE_B is the superuser's, so the stand-in lacks ADMIN OPTION on it.
      await su.query(`CREATE ROLE ${PROBE_B} WITH NOLOGIN`);
      const before = await passwordHash(PROBE);

      const statements = await asStandIn(async (c) => {
        const { client, statements } = recordingClient(c);
        await expect(
          convergeRoles(client, [
            { name: PROBE, password: "new-a" },
            { name: PROBE_B, password: "new-b" },
          ]),
        ).rejects.toThrow(`role ${PROBE_B}: the current role lacks ADMIN OPTION on it`);
        return statements;
      });

      expect(statements.filter((s) => /PASSWORD/i.test(s))).toEqual([]);
      expect(await passwordHash(PROBE)).toBe(before);
      expect((await roleAttrs(su, PROBE)).rolcanlogin).toBe(false);
    });

    it("rolls a role's new LOGIN and password back when its membership cannot be stripped", async () => {
      // Granted by the superuser into a role the stand-in has no ADMIN on.
      await su.query(`CREATE ROLE ${GRANTOR} WITH NOLOGIN`);
      await su.query(`GRANT ${GRANTOR} TO ${PROBE}`);
      const before = await passwordHash(PROBE);

      await asStandIn(async (c) => {
        await expect(convergeRoles(c, [{ name: PROBE, password: "new-a" }])).rejects.toThrow(
          `role ${PROBE}: could not revoke its membership in ${GRANTOR}`,
        );
      });

      expect(await passwordHash(PROBE)).toBe(before);
      expect((await roleAttrs(su, PROBE)).rolcanlogin).toBe(false);
      expect(await memberRows(su, PROBE, GRANTOR)).toBe(1);
    });

    it("runBootstrap rolls role convergence back when the privilege sequence fails", async () => {
      // One transaction for both phases: a failure after convergence must not
      // leave the roles with new passwords while the run reads as failed.
      const before = await passwordHash(PROBE);
      let loginInsideTx: boolean | undefined;

      await asStandIn(async (c) => {
        const failsAfterConvergence = {
          escapeLiteral: (value: string) => c.escapeLiteral(value),
          query: async (text: string, params?: unknown[]) => {
            if (text === "REVOKE CREATE ON SCHEMA public FROM PUBLIC") {
              // Positive control: convergence really ran inside the transaction.
              const { rows } = await c.query("SELECT rolcanlogin FROM pg_roles WHERE rolname = $1", [PROBE]);
              loginInsideTx = rows[0]?.rolcanlogin;
              throw new Error("simulated privilege-sequence failure");
            }
            return c.query(text, params);
          },
        } as unknown as Client;

        await expect(
          runBootstrap(failsAfterConvergence, [{ name: PROBE, password: "new-a" }], loadDeniedPolicy()),
        ).rejects.toThrow("simulated privilege-sequence failure");
      });

      expect(loginInsideTx).toBe(true);
      expect(await passwordHash(PROBE)).toBe(before);
      expect((await roleAttrs(su, PROBE)).rolcanlogin).toBe(false);
    });

    it("commits every role when all of them converge", async () => {
      await asStandIn((c) => c.query(`CREATE ROLE ${PROBE_B} WITH NOLOGIN`));
      const before = await passwordHash(PROBE);

      await asStandIn((c) =>
        convergeRoles(c, [
          { name: PROBE, password: "new-a" },
          { name: PROBE_B, password: "new-b" },
        ]),
      );

      expect(await passwordHash(PROBE)).not.toBe(before);
      expect((await roleAttrs(su, PROBE)).rolcanlogin).toBe(true);
      expect((await roleAttrs(su, PROBE_B)).rolcanlogin).toBe(true);
    });
  });

  it("grantWorkerSchemaPrivileges defaults to every converged role except passwd_app", async () => {
    const statements: string[] = [];
    const recorder = {
      query: async (text: string) => {
        statements.push(text);
        return { rows: [] };
      },
    };
    await grantWorkerSchemaPrivileges(recorder);

    const usageGrantees = statements
      .map((s) => /^GRANT USAGE ON SCHEMA public TO (\S+)$/.exec(s)?.[1])
      .filter((g): g is string => g !== undefined)
      .sort();
    expect(usageGrantees).toEqual(
      ROLES.map((r) => r.name).filter((n) => n !== "passwd_app").sort(),
    );
    // Named, so the derivation above cannot pass by ROLES losing the role.
    expect(usageGrantees).toContain("passwd_anchor_publisher");
    expect(statements.filter((s) => /\bpasswd_app\b/.test(s))).toEqual([]);
  });

  it("exits 1 before connecting when PASSWD_ANCHOR_PUBLISHER_PASSWORD is empty", () => {
    const r = spawnSync(process.execPath, [resolve(REPO_ROOT, "scripts/bootstrap-rds-roles.mjs")], {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        // Unreachable: reaching it would print a connection error instead.
        MIGRATION_DATABASE_URL: "postgresql://nobody:nothing@127.0.0.1:1/nothing",
        PASSWD_APP_PASSWORD: "a",
        PASSWD_OUTBOX_WORKER_PASSWORD: "b",
        PASSWD_RETENTION_GC_WORKER_PASSWORD: "c",
        // Explicitly empty: CI sets it job-wide.
        PASSWD_ANCHOR_PUBLISHER_PASSWORD: "",
      },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("PASSWD_ANCHOR_PUBLISHER_PASSWORD is required");
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/ECONNREFUSED|ETIMEDOUT|connect/i);
  });

  /**
   * T6 — the declared must-never-be-granted set survives the blanket grant.
   *
   * This is the defect that motivated `applyDeniedPrivileges`: the passwd_app
   * convergence above runs a table-blind
   * `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES ... TO passwd_app`,
   * which re-granted exactly what migration
   * `20260522000200_audit_log_revoke_via_definer` had revoked on `audit_logs`
   * and `audit_chain_anchors`. Because the script is convergent and re-runnable,
   * every run reopened it.
   *
   * Driven against a THROWAWAY probe role and a throwaway table, following this
   * file's rule — the real passwd_* roles and the real audit tables are what
   * this database's app and workers depend on, and a test must not converge
   * them. The declaration is supplied through DB_DENIED_PRIVILEGES so the case
   * proves the MECHANISM rather than the current contents of the committed file.
   */
  describe("T6: applyDeniedPrivileges", () => {
    const PROBE_TABLE = "bootstrap_probe_denied_tbl";
    const decl = useDeniedPolicyFixture("denied-privs-", PROBE_TABLE);

    async function setup(su: Client): Promise<void> {
      await su.query(`CREATE TABLE IF NOT EXISTS ${PROBE_TABLE} (id int)`);
      await convergeRole(su, PROBE, "probe-pw-denied");
      // The state the blanket GRANT leaves behind.
      await su.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${PROBE_TABLE} TO ${PROBE}`);
    }

    const holds = (su: Client, priv: string) =>
      hasTablePrivilege(su, PROBE, `public.${PROBE_TABLE}`, priv);



    it("revokes the declared privileges and leaves the others alone", async () => {
      writeFileSync(
        decl.file,
        JSON.stringify({
          denied: [
            {
              role: PROBE,
              table: `public.${PROBE_TABLE}`,
              privileges: ["UPDATE", "DELETE"],
              reason: "test",
            },
          ],
        }),
      );
      const su = new Client({ connectionString: superuserUrl() });
      await su.connect();
      try {
        await setup(su);
        // Anti-vacuity: the blanket grant really did grant them, so the
        // assertions below cannot pass by the privileges never existing.
        expect(await holds(su, "UPDATE")).toBe(true);
        expect(await holds(su, "DELETE")).toBe(true);

        await applyDeniedPrivileges(su);

        expect(await holds(su, "UPDATE")).toBe(false);
        expect(await holds(su, "DELETE")).toBe(false);
        // Narrow, not blanket: the privileges the declaration does NOT name must
        // survive, or convergence would break the app instead of hardening it.
        expect(await holds(su, "SELECT")).toBe(true);
        expect(await holds(su, "INSERT")).toBe(true);
      } finally {
        await su.end();
      }
    });

    it("is idempotent and tolerates a table that does not exist yet", async () => {
      // The script is documented to run BEFORE the first migration, where the
      // named table is absent — that must be a no-op, not an error, or bootstrap
      // fails on a fresh RDS instance.
      writeFileSync(
        decl.file,
        JSON.stringify({
          denied: [
            { role: PROBE, table: "public.no_such_table_yet", privileges: ["UPDATE"], reason: "t" },
            {
              role: PROBE,
              table: `public.${PROBE_TABLE}`,
              privileges: ["UPDATE"],
              reason: "t",
            },
          ],
        }),
      );
      const su = new Client({ connectionString: superuserUrl() });
      await su.connect();
      try {
        await setup(su);
        await applyDeniedPrivileges(su);
        await applyDeniedPrivileges(su);
        expect(await holds(su, "UPDATE")).toBe(false);
        expect(await holds(su, "SELECT")).toBe(true);
      } finally {
        await su.end();
      }
    });
  });

  /**
   * T6b — the two entry shapes added for `tenant_claim_events` (20260731190000):
   * a column-scoped exception, and a sequence subject.
   *
   * The column case is not a variation on T6, it is the case T6's shape cannot
   * express. Measured on a throwaway database: `REVOKE <priv> ON TABLE` erases
   * the COLUMN-level grants of that privilege as well, so declaring
   * "INSERT denied at table level" and expecting a migration's
   * `GRANT INSERT (…)` to survive convergence is exactly wrong — the revoke
   * takes the column grants with it, and the app role ends up unable to append
   * a routing event at all. Since that writer is fail-closed, the symptom is
   * denied sign-ins. This case pins the re-grant that makes the declaration
   * converge to the intended state instead.
   */
  describe("T6b: column-scoped exceptions and sequence subjects", () => {
    const PROBE_TABLE = "bootstrap_probe_colacl_tbl";
    const decl = useDeniedPolicyFixture("denied-colacl-", PROBE_TABLE);
    // An IDENTITY column, so its backing sequence is created and dropped with
    // the table — the fixture's teardown drops the table only.
    const PROBE_SEQUENCE = `public.${PROBE_TABLE}_seq_seq`;

    async function setup(su: Client): Promise<void> {
      await su.query(
        `CREATE TABLE IF NOT EXISTS ${PROBE_TABLE} (
           payload text,
           attribution text,
           seq bigint GENERATED ALWAYS AS IDENTITY
         )`,
      );
      await convergeRole(su, PROBE, "probe-pw-colacl");
      // The state the blanket GRANTs leave behind — both of them, because the
      // sequence grant is a separate statement with the same table-blindness.
      await su.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${PROBE_TABLE} TO ${PROBE}`);
      await su.query(`GRANT USAGE, SELECT ON SEQUENCE ${PROBE_SEQUENCE} TO ${PROBE}`);
    }

    const columnHolds = async (su: Client, column: string, priv: string): Promise<boolean> => {
      const { rows } = await su.query(
        "SELECT has_column_privilege($1, $2, $3, $4) AS granted",
        [PROBE, `public.${PROBE_TABLE}`, column, priv],
      );
      return rows[0].granted as boolean;
    };
    const sequenceHolds = async (su: Client, priv: string): Promise<boolean> => {
      const { rows } = await su.query("SELECT has_sequence_privilege($1, $2, $3) AS granted", [
        PROBE,
        PROBE_SEQUENCE,
        priv,
      ]);
      return rows[0].granted as boolean;
    };

    it("re-grants the declared columns after the revoke that erases them, and converges on a re-run", async () => {
      writeFileSync(
        decl.file,
        JSON.stringify({
          denied: [
            {
              role: PROBE,
              table: `public.${PROBE_TABLE}`,
              privileges: ["SELECT", "INSERT", "UPDATE", "DELETE"],
              columnGrants: { INSERT: ["payload"] },
              reason: "test",
            },
          ],
        }),
      );
      const su = new Client({ connectionString: superuserUrl() });
      await su.connect();
      try {
        await setup(su);
        // Anti-vacuity, and the property that makes this whole entry shape
        // necessary: with a TABLE-level INSERT the role reaches every column,
        // including the identity one.
        expect(await hasTablePrivilege(su, PROBE, `public.${PROBE_TABLE}`, "INSERT")).toBe(true);
        expect(await columnHolds(su, "seq", "INSERT")).toBe(true);

        // Twice, because a single run cannot distinguish "the re-grant works"
        // from "the revoke happened not to erase anything yet". The second run
        // starts from the state the first produced — which is where a
        // re-grant-less implementation loses the column grant for good.
        for (const pass of [1, 2]) {
          await applyDeniedPrivileges(su);
          expect(
            await hasTablePrivilege(su, PROBE, `public.${PROBE_TABLE}`, "INSERT"),
            `pass ${pass}: table-level INSERT must be revoked`,
          ).toBe(false);
          expect(await columnHolds(su, "payload", "INSERT"), `pass ${pass}: declared column`).toBe(
            true,
          );
          expect(
            await columnHolds(su, "seq", "INSERT"),
            `pass ${pass}: identity column must stay out of reach`,
          ).toBe(false);
          expect(
            await columnHolds(su, "attribution", "INSERT"),
            `pass ${pass}: undeclared column`,
          ).toBe(false);
          // The other denied privileges are not resurrected column-wise by the
          // re-grant.
          expect(await columnHolds(su, "payload", "SELECT"), `pass ${pass}: SELECT`).toBe(false);
        }
      } finally {
        await su.end();
      }
    });

    it("throws on an entry whose declared subject kind disagrees with the object", async () => {
      // The bootstrap's own call site, which the audit's end-to-end case cannot
      // cover. The check is placed ABOVE the existence branch deliberately:
      // moved below it, a wrong-kind entry would go unreported on exactly the
      // run the placement is for — the pre-migration FULL run, where the role
      // may not exist yet and the entry is skipped.
      writeFileSync(
        decl.file,
        JSON.stringify({
          denied: [
            {
              role: PROBE,
              table: PROBE_SEQUENCE, // a sequence declared as a table
              privileges: ["SELECT"],
              reason: "test",
            },
          ],
        }),
      );
      const su = new Client({ connectionString: superuserUrl() });
      await su.connect();
      try {
        await setup(su);
        await expect(applyDeniedPrivileges(su)).rejects.toThrow(/DENIED_POLICY_SUBJECT_KIND/);
      } finally {
        await su.end();
      }
    });

    it("revokes a declared sequence privilege, which no table entry can reach", async () => {
      writeFileSync(
        decl.file,
        JSON.stringify({
          denied: [
            {
              role: PROBE,
              sequence: PROBE_SEQUENCE,
              privileges: ["USAGE", "SELECT", "UPDATE"],
              reason: "test",
            },
          ],
        }),
      );
      const su = new Client({ connectionString: superuserUrl() });
      await su.connect();
      try {
        await setup(su);
        expect(await sequenceHolds(su, "USAGE")).toBe(true);
        expect(await sequenceHolds(su, "SELECT")).toBe(true);

        await applyDeniedPrivileges(su);

        expect(await sequenceHolds(su, "USAGE")).toBe(false);
        expect(await sequenceHolds(su, "SELECT")).toBe(false);
        expect(await sequenceHolds(su, "UPDATE")).toBe(false);
        // The table's own privileges are untouched — a sequence entry must not
        // be a disguised table entry.
        expect(await hasTablePrivilege(su, PROBE, `public.${PROBE_TABLE}`, "SELECT")).toBe(true);
      } finally {
        await su.end();
      }
    });
  });

  /**
   * T7 — the policy is validated BEFORE any database change, and a failure
   * inside the privilege sequence rolls back rather than leaving the widening
   * half committed.
   *
   * The defect: `main()` ran the blanket
   * `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES ... TO passwd_app` and
   * the deny REVOKEs as separate autocommit statements. An exception, a lost
   * connection or a process kill between them commits only the grant, and the
   * immutable audit tables stay writable until someone happens to re-run the
   * script. "Convergent and re-runnable" describes the steady state, not the
   * window.
   *
   * Scope, stated rather than implied: these cases do NOT drive `main()`'s full
   * sequence. That sequence converges the real `passwd_*` roles, which this
   * database's app and workers depend on — the same reason every case above uses
   * throwaway probes. What is covered is the three properties the fix rests on:
   * validation happens before the client is used, the helper THROWS instead of
   * killing the process (a `process.exit` there would skip the caller's
   * ROLLBACK), and GRANT/REVOKE really do roll back for these statements.
   */
  describe("T7: fail-closed policy load + transactional privilege changes", () => {
    const PROBE_TABLE = "bootstrap_probe_tx_tbl";
    const decl = useDeniedPolicyFixture("denied-tx-", PROBE_TABLE);



    it("THROWS when the policy file is absent, instead of treating it as an empty policy", () => {
      // The production shape of this bug: the Dockerfile shipped the scripts and
      // the descriptive manifest but not the declaration, and both consumers
      // read "absent" as "nothing is forbidden" — so the deploy runner would
      // have applied the blanket grant with no revoke behind it.
      //
      // Distinct from "the table does not exist yet", which IS normal on a
      // pre-migration run and is handled per entry by the to_regclass guard.
      rmSync(decl.file, { force: true });
      expect(() => loadDeniedPolicy()).toThrow(/DENIED_POLICY_MISSING/);
    });

    it.each([
      ["not an array", JSON.stringify({ denied: "nope" })],
      ["malformed table", JSON.stringify({ denied: [{ role: "r", table: "a; DROP", privileges: ["UPDATE"] }] })],
      ["malformed privilege", JSON.stringify({ denied: [{ role: "r", table: "public.t", privileges: ["DROP"] }] })],
      ["no privileges", JSON.stringify({ denied: [{ role: "r", table: "public.t", privileges: [] }] })],
    ])("THROWS on a %s policy, before any database change", (_label, body) => {
      writeFileSync(decl.file, body);
      // Throwing, not `process.exit`: the helper runs inside the caller's
      // transaction, and killing the process there skips the ROLLBACK — which
      // commits the blanket grant without the revokes, i.e. exactly the state
      // the transaction exists to prevent.
      expect(() => loadDeniedPolicy()).toThrow(/DENIED_POLICY_INVALID/);
    });

    it("rolls the blanket grant back when the sequence fails after it", async () => {
      writeFileSync(
        decl.file,
        JSON.stringify({
          denied: [
            { role: PROBE, table: `public.${PROBE_TABLE}`, privileges: ["UPDATE"], reason: "test" },
          ],
        }),
      );
      const su = new Client({ connectionString: superuserUrl() });
      await su.connect();
      try {
        await su.query(`CREATE TABLE ${PROBE_TABLE} (id int)`);
        await convergeRole(su, PROBE, "probe-pw-tx");
        await su.query(`REVOKE ALL ON ${PROBE_TABLE} FROM ${PROBE}`);

        const holdsUpdate = () =>
          hasTablePrivilege(su, PROBE, `public.${PROBE_TABLE}`, "UPDATE");
        expect(await holdsUpdate()).toBe(false);

        // main()'s shape: BEGIN -> blanket grant -> (failure) -> ROLLBACK.
        await su.query("BEGIN");
        try {
          await su.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${PROBE_TABLE} TO ${PROBE}`);
          // Anti-vacuity: the grant is real and visible INSIDE the transaction,
          // so the assertion after the rollback is about the rollback and not
          // about the grant never having happened.
          expect(await holdsUpdate()).toBe(true);
          throw new Error("simulated failure between the grant and the deny revokes");
        } catch (e) {
          await su.query("ROLLBACK");
          expect((e as Error).message).toMatch(/simulated failure/);
        }

        // The widening half must not have survived on its own.
        expect(await holdsUpdate()).toBe(false);
      } finally {
        await su.end();
      }
    });

    it("applies the revoke and commits when the sequence completes", async () => {
      // The allow side: the transaction must not be so defensive that the
      // intended state never lands.
      writeFileSync(
        decl.file,
        JSON.stringify({
          denied: [
            { role: PROBE, table: `public.${PROBE_TABLE}`, privileges: ["UPDATE"], reason: "test" },
          ],
        }),
      );
      const su = new Client({ connectionString: superuserUrl() });
      await su.connect();
      try {
        await su.query(`CREATE TABLE ${PROBE_TABLE} (id int)`);
        await convergeRole(su, PROBE, "probe-pw-tx");

        await su.query("BEGIN");
        await su.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${PROBE_TABLE} TO ${PROBE}`);
        await applyDeniedPrivileges(su, loadDeniedPolicy());
        await su.query("COMMIT");

        const table = `public.${PROBE_TABLE}`;
        expect(await hasTablePrivilege(su, PROBE, table, "UPDATE")).toBe(false);
        // Narrow, not blanket: what the declaration does NOT name must survive.
        expect(await hasTablePrivilege(su, PROBE, table, "SELECT")).toBe(true);
      } finally {
        await su.end();
      }
    });
  });

  /**
   * T8 — the `--denied-only` CLI mode, which is what CI now depends on.
   *
   * `.github/workflows/ci-integration.yml` runs `prisma migrate deploy` and THEN
   * a table-blind `GRANT ... ON ALL TABLES ... TO passwd_app`, so every
   * integration run re-granted what migration 20260522000200 revoked and tested a
   * database whose audit tables the app role could rewrite. The workflow now
   * calls this mode instead of spelling the policy a fourth time in YAML.
   *
   * Driven as a SUBPROCESS, because the property under test is the CLI entry
   * point — argv parsing, the transaction, the exit code — not the helper the
   * other cases already cover. Pointed at a throwaway policy naming a probe role
   * and table so it never touches the real roles.
   */
  describe("T8: --denied-only", () => {
    const PROBE_TABLE = "bootstrap_probe_cli_tbl";
    const decl = useDeniedPolicyFixture("denied-cli-", PROBE_TABLE);

    function runDeniedOnly() {
      return spawnSync(
        process.execPath,
        [resolve(REPO_ROOT, "scripts/bootstrap-rds-roles.mjs"), "--denied-only"],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            MIGRATION_DATABASE_URL: superuserUrl(),
            DB_DENIED_PRIVILEGES: decl.file,
          },
        },
      );
    }

    it("revokes the declared privileges without needing role passwords", async () => {
      // The full run requires every ROLES password; this mode must not, or CI
      // would have to carry secrets it has no other use for.
      writeFileSync(
        decl.file,
        JSON.stringify({
          denied: [
            { role: PROBE, table: `public.${PROBE_TABLE}`, privileges: ["UPDATE"], reason: "t" },
          ],
        }),
      );
      const su = new Client({ connectionString: superuserUrl() });
      await su.connect();
      try {
        await su.query(`CREATE TABLE ${PROBE_TABLE} (id int)`);
        await convergeRole(su, PROBE, "probe-pw-cli");
        // Reproduce CI's shape: the blanket grant lands AFTER the migrations.
        await su.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${PROBE_TABLE} TO ${PROBE}`);
        const table = `public.${PROBE_TABLE}`;
        expect(await hasTablePrivilege(su, PROBE, table, "UPDATE")).toBe(true);

        const r = runDeniedOnly();
        expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);

        expect(await hasTablePrivilege(su, PROBE, table, "UPDATE")).toBe(false);
        // Narrow, not blanket.
        expect(await hasTablePrivilege(su, PROBE, table, "SELECT")).toBe(true);
      } finally {
        await su.end();
      }
    });

    it.each([
      ["a mistyped table", { role: PROBE, table: "public.no_such_table_at_all", privileges: ["UPDATE"], reason: "t" }],
      ["a renamed role", { role: "no_such_role_at_all", table: `public.${PROBE_TABLE}`, privileges: ["UPDATE"], reason: "t" }],
    ])("exits non-zero when the policy names %s", async (_label, entry) => {
      // The FULL run tolerates an absent target — it is documented to happen
      // before the first migration, where the audit tables do not exist yet.
      // This mode is post-migration by definition, so an absent target means the
      // POLICY is wrong, and skipping it printed "policy applied" and exited 0:
      // a green CI step that revoked nothing.
      writeFileSync(decl.file, JSON.stringify({ denied: [entry] }));
      const su = new Client({ connectionString: superuserUrl() });
      await su.connect();
      try {
        await su.query(`CREATE TABLE ${PROBE_TABLE} (id int)`);
        await convergeRole(su, PROBE, "probe-pw-cli");
      } finally {
        await su.end();
      }
      const r = runDeniedOnly();
      expect(r.status).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toContain("DENIED_POLICY_TARGET_MISSING");
    });

    it("rolls back an already-applied entry when a later one names a missing target", async () => {
      // The transaction boundary, exercised rather than asserted: entry 1 is
      // valid and IS revoked, entry 2 then throws. A partial apply would leave a
      // policy half-enforced and the run reported as failed, which is the worst
      // of both.
      writeFileSync(
        decl.file,
        JSON.stringify({
          denied: [
            { role: PROBE, table: `public.${PROBE_TABLE}`, privileges: ["UPDATE"], reason: "t" },
            { role: PROBE, table: "public.no_such_table_at_all", privileges: ["UPDATE"], reason: "t" },
          ],
        }),
      );
      const su = new Client({ connectionString: superuserUrl() });
      await su.connect();
      try {
        await su.query(`CREATE TABLE ${PROBE_TABLE} (id int)`);
        await convergeRole(su, PROBE, "probe-pw-cli");
        await su.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${PROBE_TABLE} TO ${PROBE}`);
        const table = `public.${PROBE_TABLE}`;
        expect(await hasTablePrivilege(su, PROBE, table, "UPDATE")).toBe(true);

        const r = runDeniedOnly();
        expect(r.status).not.toBe(0);
        // Entry 1's REVOKE really was issued — the log says so — and is gone
        // again, which is what makes this a rollback rather than a no-op.
        expect(r.stdout).toContain(`REVOKE UPDATE ON ${table}`);
        expect(await hasTablePrivilege(su, PROBE, table, "UPDATE")).toBe(true);
      } finally {
        await su.end();
      }
    });

    it("exits non-zero on a missing policy rather than silently doing nothing", () => {
      // A CI step that quietly succeeds without applying anything is how the
      // control would go missing again, this time with a green pipeline.
      rmSync(decl.file, { force: true });
      const r = runDeniedOnly();
      expect(r.status).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toContain("DENIED_POLICY_MISSING");
    });
  });

  /**
   * T9 — EXECUTE on routines for a role created after the migrations. The
   * migrations grant only to roles that exist when they run; a role created
   * later (CI's bootstrap, a re-created role) was left unable to call the
   * SECURITY DEFINER audit routines (#922 surfaced it).
   */
  describe("T9: grantRoutineExecute", () => {
    const PURGE = "public.audit_log_purge(uuid, timestamptz)";
    const MIGRATE = "public.audit_log_tenant_migrate(uuid, uuid, uuid)";
    const canExecute = async (signature: string) => {
      const { rows } = await su.query("SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok", [PROBE, signature]);
      return rows[0].ok as boolean;
    };

    it("grants EXECUTE on a function and a procedure to a role created after them", async () => {
      await convergeRole(su, PROBE, "probe-pw-exec");
      expect(await canExecute(PURGE)).toBe(false);
      expect(await canExecute(MIGRATE)).toBe(false);

      await grantRoutineExecute(su, [
        { kind: "FUNCTION", signature: PURGE, roles: [PROBE] },
        { kind: "PROCEDURE", signature: MIGRATE, roles: [PROBE] },
      ]);

      expect(await canExecute(PURGE)).toBe(true);
      expect(await canExecute(MIGRATE)).toBe(true);
    });

    it("skips a routine that does not exist yet", async () => {
      await convergeRole(su, PROBE, "probe-pw-exec");
      await expect(
        grantRoutineExecute(su, [{ kind: "FUNCTION", signature: "public.bootstrap_probe_missing_fn()", roles: [PROBE] }]),
      ).resolves.toBeUndefined();
    });

    it("names the definer audit routines for the roles that call them", async () => {
      // The default set is what main() applies; the roles here are the ones
      // db-grants-manifest.json records as holding EXECUTE.
      const granted: string[] = [];
      const recorder = {
        query: async (text: string, params?: unknown[]) => {
          if (text.startsWith("GRANT")) granted.push(text);
          return text.startsWith("SELECT") ? su.query(text, params) : { rows: [] };
        },
      };
      await grantRoutineExecute(recorder);
      expect(granted).toEqual(expect.arrayContaining([
        `GRANT EXECUTE ON FUNCTION ${PURGE} TO passwd_app`,
        `GRANT EXECUTE ON FUNCTION ${PURGE} TO passwd_retention_gc_worker`,
        `GRANT EXECUTE ON PROCEDURE ${MIGRATE} TO passwd_app`,
      ]));
      expect(granted.filter((g) => g.includes("audit_log_tenant_migrate"))).toEqual([
        `GRANT EXECUTE ON PROCEDURE ${MIGRATE} TO passwd_app`,
      ]);
    });

    it("grants EXECUTE on the rls_bypass_* functions to every converged role, the anchor publisher included", async () => {
      // The RLS policies call these for every role that reads an RLS table, so
      // a converged role without them cannot read tenants at all.
      const granted: string[] = [];
      const recorder = {
        query: async (text: string, params?: unknown[]) => {
          if (text.startsWith("GRANT")) granted.push(text);
          return text.startsWith("SELECT") ? su.query(text, params) : { rows: [] };
        },
      };
      await grantRoutineExecute(recorder);
      const bypassFunctions = ["public.rls_bypass_enforced()", "public.rls_bypass_admits(text)"];
      for (const signature of bypassFunctions) {
        for (const { name } of ROLES) {
          expect(granted).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO ${name}`);
        }
        expect(granted).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO passwd_anchor_publisher`);
      }
      // The definer audit routines stay with the roles that call them.
      expect(granted.filter((g) => g.endsWith(" TO passwd_anchor_publisher"))).toEqual(
        bypassFunctions.map((s) => `GRANT EXECUTE ON FUNCTION ${s} TO passwd_anchor_publisher`),
      );
    });
  });
});
