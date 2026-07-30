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

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { Client } from "pg";
import { spawnSync } from "node:child_process";
import {
  convergeRole,
  applyDeniedPrivileges,
  loadDeniedPolicy,
} from "../../../scripts/bootstrap-rds-roles.mjs";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root, for spawning the CLI under test as a subprocess. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const PROBE = "bootstrap_probe_app";
const GRANTOR = "bootstrap_probe_grantor";

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
});
