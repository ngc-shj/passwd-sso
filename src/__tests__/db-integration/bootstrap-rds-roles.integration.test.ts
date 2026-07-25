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
 *
 * Uses THROWAWAY probe roles — never the real passwd_* roles, which this DB's
 * app and workers depend on.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Client } from "pg";
import { convergeRole } from "../../../scripts/bootstrap-rds-roles.mjs";

const PROBE = "bootstrap_probe_app";
const GRANTOR = "bootstrap_probe_grantor";

/** SUPERUSER connection — the same privilege level the migrate task uses. */
function superuserUrl(): string {
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("MIGRATION_DATABASE_URL or DATABASE_URL required");
  return url;
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
  for (const role of [PROBE, GRANTOR]) {
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
});
