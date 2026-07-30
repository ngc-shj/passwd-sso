/**
 * Real-DB tests for scripts/audit-db-grants.mjs.
 *
 * The audit is the only thing that detects a migration (or an operator) granting
 * a least-privilege role more than it should have. A review round found it read
 * only DIRECT ACLs, so privileges reached via PUBLIC or via role inheritance were
 * invisible — the audit reported OK while a worker could read `accounts`. These
 * tests pin every path it must see.
 *
 * T1 — the audit round-trips (--write then verify agree) on this database
 * T2 — a direct table grant is detected
 * T3 — a column-scoped grant is detected, including on a table that already has
 *      other legitimate column grants
 * T4 — a grant to PUBLIC is detected (role_table_grants excludes these)
 * T5 — a privilege reached through role membership is detected, and the
 *      membership itself is reported
 * T6  — a MISSING grant (manifest entry with no live privilege) is detected
 * T7  — CREATE on a schema is detected
 * T8  — a role attribute re-granted after bootstrap is detected
 * T9  — a default privilege pre-authorising future tables is detected
 * T10 — EXECUTE on a SECURITY DEFINER routine is detected (PostgreSQL grants it
 *       to PUBLIC by default; the routine runs with its owner's privileges)
 * T11 — a grant in a NON-public schema is detected (the audit used to pin every
 *       query to nspname = 'public')
 *
 * Each mutation is undone in a `finally`. They must be COMMITTED, not rolled
 * back: the audit runs in its own process and would not see an open
 * transaction's changes.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { Client } from "pg";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const AUDIT = resolve(REPO_ROOT, "scripts", "audit-db-grants.mjs");

function dbUrl(): string {
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("MIGRATION_DATABASE_URL or DATABASE_URL required");
  return url;
}

/**
 * Environment for a child audit run. Inherits the parent env (this project's
 * ProcessEnv type requires NODE_ENV, and the child needs a working PATH) and
 * pins only what the audit reads.
 */
function auditEnv(manifestPath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    MIGRATION_DATABASE_URL: dbUrl(),
    DB_GRANTS_MANIFEST: manifestPath,
  };
}

/**
 * Run the audit against the live DB with an explicit manifest file.
 * The audit opens its own connection, so mutations under test must be COMMITTED
 * — hence the try/finally cleanup in each test rather than a wrapping
 * transaction (a rolled-back grant would be invisible to a second connection).
 */
function runAudit(manifestPath: string, extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [AUDIT], {
    env: { ...auditEnv(manifestPath), ...extraEnv },
    encoding: "utf8",
    timeout: 60_000,
    cwd: REPO_ROOT,
  });
}

function runAuditWrite(manifestPath: string, extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, [AUDIT, "--write"], {
    env: { ...auditEnv(manifestPath), ...extraEnv },
    encoding: "utf8",
    timeout: 60_000,
    cwd: REPO_ROOT,
  });
}

describe("audit-db-grants (real DB)", () => {
  let su: Client;
  let tmpDir: string;
  let manifestPath: string;

  beforeAll(async () => {
    su = new Client({ connectionString: dbUrl() });
    await su.connect();
    tmpDir = mkdtempSync(resolve(tmpdir(), "acl-audit-"));
    manifestPath = join(tmpDir, "manifest.json");
    // Snapshot the CURRENT state as the expected baseline, so these tests assert
    // "the audit notices a change", independent of migration drift in the dev DB.
    const gen = spawnSync(process.execPath, [AUDIT, "--write"], {
      env: auditEnv(manifestPath),
      encoding: "utf8",
      timeout: 60_000,
      cwd: REPO_ROOT,
    });
    if (gen.status !== 0) throw new Error(`manifest generation failed: ${gen.stderr}`);
  });

  afterAll(async () => {
    rmSync(tmpDir, { recursive: true, force: true });
    await su.end();
  });

  it("T1: the audit reports OK against a manifest generated from this database", () => {
    // Deliberately NOT asserted against the COMMITTED manifest
    // (scripts/checks/db-grants-manifest.json). That file describes a deployed
    // environment; an ephemeral CI database legitimately differs from it in ways
    // that say nothing about security — different database name (passwd_test vs
    // passwd_sso), different object owner (postgres vs passwd_user), and no
    // initdb role grants. Comparing the two produced ~20 findings in CI that were
    // all environmental noise.
    //
    // The committed manifest is verified where it means something: the migrate
    // task runs `node scripts/audit-db-grants.mjs` against the DEPLOYED database
    // on every deploy (infra/terraform/ecs.tf), and that is what gates a rollout.
    //
    // What this test pins is the audit's own round-trip: --write then verify must
    // agree. Every other test here mutates a privilege and asserts the audit
    // notices, which is the behaviour that actually protects us.
    const r = runAudit(manifestPath);
    expect(r.stdout + r.stderr).toContain("db-grants: OK");
    expect(r.status).toBe(0);
  });

  it("T2: detects a direct table grant", async () => {
    try {
      await su.query("GRANT UPDATE ON users TO passwd_outbox_worker");

      const r = runAudit(manifestPath);

      expect(r.status).toBe(1);
      expect(r.stderr).toContain("UNEXPECTED_GRANT: TABLE:passwd_outbox_worker public.users UPDATE");
    } finally {
      await su.query("REVOKE UPDATE ON users FROM passwd_outbox_worker");
    }
  });

  it("T3: detects a column-scoped grant on an already column-granted table", async () => {
    // tenant_webhooks legitimately carries UPDATE on six columns; adding a
    // seventh (a secret) must still fail. Collapsing to "can UPDATE the table"
    // would hide this.
    try {
      await su.query("GRANT UPDATE (secret_encrypted) ON tenant_webhooks TO passwd_outbox_worker");

      const r = runAudit(manifestPath);

      expect(r.status).toBe(1);
      expect(r.stderr).toContain(
        "UNEXPECTED_GRANT: COLUMN:passwd_outbox_worker public.tenant_webhooks.secret_encrypted UPDATE",
      );
    } finally {
      await su.query(
        "REVOKE UPDATE (secret_encrypted) ON tenant_webhooks FROM passwd_outbox_worker",
      );
    }
  });

  it("T4: detects a grant to PUBLIC that every role inherits", async () => {
    // information_schema.role_table_grants EXCLUDES privileges held via PUBLIC,
    // so a direct-ACL audit reports OK while the workers can read the table.
    try {
      await su.query("GRANT SELECT ON accounts TO PUBLIC");

      const r = runAudit(manifestPath);

      expect(r.status).toBe(1);
      expect(r.stderr).toContain("UNEXPECTED_GRANT: PUBLIC:public.accounts SELECT");
      // …and the effective privilege it confers on the roles.
      expect(r.stderr).toContain("TABLE:passwd_outbox_worker public.accounts SELECT");
    } finally {
      await su.query("REVOKE SELECT ON accounts FROM PUBLIC");
    }
  });

  it("T5: detects a privilege reached through role membership", async () => {
    try {
      await su.query("DROP ROLE IF EXISTS acl_audit_probe_holder");
      await su.query("CREATE ROLE acl_audit_probe_holder NOLOGIN");
      await su.query("GRANT SELECT ON accounts TO acl_audit_probe_holder");
      await su.query("GRANT acl_audit_probe_holder TO passwd_outbox_worker");

      const r = runAudit(manifestPath);

      expect(r.status).toBe(1);
      // The membership itself is a finding — it is an open inheritance path.
      expect(r.stderr).toContain(
        "UNEXPECTED_GRANT: MEMBER:passwd_outbox_worker acl_audit_probe_holder",
      );
      // …as is the privilege it confers.
      expect(r.stderr).toContain("TABLE:passwd_outbox_worker public.accounts SELECT");
    } finally {
      await su.query("REVOKE acl_audit_probe_holder FROM passwd_outbox_worker").catch(() => {});
      await su.query("DROP OWNED BY acl_audit_probe_holder").catch(() => {});
      await su.query("DROP ROLE IF EXISTS acl_audit_probe_holder");
    }
  });

  it("T7: detects CREATE granted on the schema", async () => {
    // CREATE on a schema lets the role add its own tables/functions there. No
    // table-level query surfaces it, so it needs its own audit dimension.
    try {
      await su.query("GRANT CREATE ON SCHEMA public TO passwd_outbox_worker");

      const r = runAudit(manifestPath);

      expect(r.status).toBe(1);
      expect(r.stderr).toContain("UNEXPECTED_GRANT: SCHEMA:passwd_outbox_worker public CREATE");
    } finally {
      await su.query("REVOKE CREATE ON SCHEMA public FROM passwd_outbox_worker");
    }
  });

  it("T8: detects a role attribute re-granted after bootstrap", async () => {
    // bootstrap-rds-roles converges role attributes, but migrations run as
    // SUPERUSER and can re-grant them at any time. Asserting on every deploy is
    // what makes the bootstrap-time convergence durable.
    try {
      await su.query("ALTER ROLE passwd_outbox_worker CREATEDB");

      const r = runAudit(manifestPath);

      expect(r.status).toBe(1);
      expect(r.stderr).toContain("UNEXPECTED_GRANT: ROLEATTR:passwd_outbox_worker rolcreatedb true");
    } finally {
      await su.query("ALTER ROLE passwd_outbox_worker NOCREATEDB");
    }
  });

  it("T9: detects a default privilege pre-authorising future tables", async () => {
    // Default ACLs apply to objects created LATER, so they grant access to
    // tables that do not exist yet — invisible to any "what can this role touch
    // now" query.
    try {
      await su.query(
        "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO passwd_outbox_worker",
      );

      const r = runAudit(manifestPath);

      expect(r.status).toBe(1);
      expect(r.stderr).toContain("UNEXPECTED_GRANT: DEFAULTACL:");
      expect(r.stderr).toContain("passwd_outbox_worker=r");
    } finally {
      await su.query(
        "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM passwd_outbox_worker",
      );
    }
  });

  it("T10: detects EXECUTE on a SECURITY DEFINER routine", async () => {
    // PostgreSQL grants EXECUTE to PUBLIC by default, so a definer routine is
    // callable by every role unless revoked — and it runs with its OWNER's
    // privileges. audit_log_purge deletes audit records, so the outbox worker
    // holding EXECUTE would be able to erase any tenant's audit trail.
    try {
      await su.query(
        "GRANT EXECUTE ON FUNCTION audit_log_purge(UUID, TIMESTAMPTZ) TO passwd_outbox_worker",
      );

      const r = runAudit(manifestPath);

      expect(r.status).toBe(1);
      expect(r.stderr).toContain("UNEXPECTED_GRANT: FUNCTION:passwd_outbox_worker");
      expect(r.stderr).toContain("audit_log_purge");
      // The key records that the routine is definer-owned, since that is what
      // makes the grant dangerous.
      expect(r.stderr).toContain("SECURITY_DEFINER");
    } finally {
      await su.query(
        "REVOKE EXECUTE ON FUNCTION audit_log_purge(UUID, TIMESTAMPTZ) FROM passwd_outbox_worker",
      );
    }
  });

  it("T11: detects a grant in a NON-public schema", async () => {
    // The audit used to pin every query to `nspname = 'public'`, so a migration
    // could put a table in another schema, grant the worker SELECT, and the
    // audit still reported OK.
    try {
      await su.query("CREATE SCHEMA IF NOT EXISTS acl_audit_probe_ns");
      await su.query("CREATE TABLE IF NOT EXISTS acl_audit_probe_ns.secrets(id int)");
      await su.query("GRANT USAGE ON SCHEMA acl_audit_probe_ns TO passwd_outbox_worker");
      await su.query("GRANT SELECT ON acl_audit_probe_ns.secrets TO passwd_outbox_worker");

      const r = runAudit(manifestPath);

      expect(r.status).toBe(1);
      expect(r.stderr).toContain(
        "UNEXPECTED_GRANT: TABLE:passwd_outbox_worker acl_audit_probe_ns.secrets SELECT",
      );
    } finally {
      await su.query("DROP SCHEMA IF EXISTS acl_audit_probe_ns CASCADE");
    }
  });

  it("T6: detects a MISSING grant (manifest entry with no live privilege)", () => {
    // Simulates migrations not having been applied: the manifest expects a
    // privilege the database does not grant.
    const doctored = join(tmpDir, "missing.json");
    const base = JSON.parse(readFileSync(manifestPath, "utf8"));
    base.grants.push("TABLE:passwd_app\tpublic.a_table_that_does_not_exist\tSELECT");
    writeFileSync(doctored, JSON.stringify(base, null, 2), "utf8");

    const r = runAudit(doctored);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      "MISSING_GRANT: TABLE:passwd_app public.a_table_that_does_not_exist SELECT",
    );
  });

  /**
   * The PRESCRIPTIVE half, driven through the real subprocess.
   *
   * The declaration in `scripts/checks/app-role-denied-privileges.json` states
   * privileges that must never be held whatever the live database says. It is
   * what stops `--write` recording a database whose control has been undone as
   * the expected state — which is how the audit_logs REVOKE became invisible.
   *
   * Driven against a THROWAWAY probe role and table with an overridden policy
   * file, so the cases prove the MECHANISM rather than the current contents of
   * the committed declaration, and never touch the real roles.
   */
  describe("prescriptive deny policy", () => {
    // The AUDITED role, against a THROWAWAY table. It has to be an audited role
    // or the audit reads no keys for it and the deny check is inert (see
    // DENIED_POLICY_UNAUDITED_ROLE); it must be a throwaway TABLE so nothing the
    // app depends on is touched.
    const PROBE = "passwd_app";
    const PROBE_TABLE = "audit_denied_probe_tbl";
    let policyPath: string;

    const policy = (privileges: string[]) =>
      JSON.stringify({
        denied: [
          { role: PROBE, table: `public.${PROBE_TABLE}`, privileges, reason: "test" },
        ],
      });

    beforeEach(async () => {
      policyPath = join(tmpDir, "denied.json");
      await su.query(`DROP TABLE IF EXISTS ${PROBE_TABLE}`);
      await su.query(`CREATE TABLE ${PROBE_TABLE} (id int, metadata jsonb)`);
      // The default ACL grants the app role arwd on any new table, so start from
      // a known-empty state.
      await su.query(`REVOKE ALL ON ${PROBE_TABLE} FROM ${PROBE}`);
    });

    afterEach(async () => {
      await su.query(`DROP TABLE IF EXISTS ${PROBE_TABLE}`);
      rmSync(policyPath, { force: true });
    });

    it("fails closed when the policy file is absent", () => {
      // The production shape: the Dockerfile shipped the scripts and the
      // descriptive manifest but not the declaration, and an absent file used to
      // read as "nothing is forbidden".
      const r = runAudit(manifestPath, { DB_DENIED_PRIVILEGES: join(tmpDir, "no-such.json") });
      expect(r.status).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toContain("DENIED_POLICY_MISSING");
    });

    it.each([
      ["no privileges", JSON.stringify({ denied: [{ role: "r", table: "public.t", privileges: [] }] })],
      ["unknown privilege", JSON.stringify({ denied: [{ role: "r", table: "public.t", privileges: ["DROP"] }] })],
      ["not an array", JSON.stringify({ denied: "nope" })],
    ])("fails closed on a %s policy", (_label, body) => {
      // The Low this closes: the audit used to validate only that a `denied`
      // array existed, while the bootstrap validated every entry — so a policy
      // that stopped a bootstrap run passed a deploy-time audit. One loader now
      // serves both.
      writeFileSync(policyPath, body);
      const r = runAudit(manifestPath, { DB_DENIED_PRIVILEGES: policyPath });
      expect(r.status).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toContain("DENIED_POLICY_INVALID");
    });

    it("reports DENIED_PRIVILEGE_HELD for a table-level grant", async () => {
      writeFileSync(policyPath, policy(["UPDATE"]));
      await su.query(`GRANT UPDATE ON ${PROBE_TABLE} TO ${PROBE}`);
      const r = runAudit(manifestPath, { DB_DENIED_PRIVILEGES: policyPath });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain(
        `DENIED_PRIVILEGE_HELD: TABLE:${PROBE} public.${PROBE_TABLE} UPDATE`,
      );
    });

    it("reports DENIED_PRIVILEGE_HELD for a COLUMN-level grant", async () => {
      // PostgreSQL lets table and column privileges disagree:
      //   GRANT UPDATE (metadata)  ->  has_table_privilege  = false
      //                                has_column_privilege = true
      // Matching only the TABLE key therefore passed a role that can rewrite the
      // one column that matters.
      writeFileSync(policyPath, policy(["UPDATE"]));
      await su.query(`GRANT UPDATE (metadata) ON ${PROBE_TABLE} TO ${PROBE}`);
      const [{ granted }] = (
        await su.query(
          `SELECT has_table_privilege($1, $2, 'UPDATE') AS granted`,
          [PROBE, `public.${PROBE_TABLE}`],
        )
      ).rows;
      // Anti-vacuity: the table-level privilege really is absent, so the finding
      // below can only come from the column sweep.
      expect(granted).toBe(false);

      const r = runAudit(manifestPath, { DB_DENIED_PRIVILEGES: policyPath });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain(
        `DENIED_PRIVILEGE_HELD: COLUMN:${PROBE} public.${PROBE_TABLE}.metadata UPDATE`,
      );
    });

    it("refuses --write while a denied privilege is held, and writes nothing", async () => {
      writeFileSync(policyPath, policy(["UPDATE"]));
      await su.query(`GRANT UPDATE ON ${PROBE_TABLE} TO ${PROBE}`);
      const target = join(tmpDir, "would-be-laundered.json");
      rmSync(target, { force: true });

      const r = runAuditWrite(target, { DB_DENIED_PRIVILEGES: policyPath });

      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("REFUSING to regenerate the manifest");
      // The point: a regeneration must not record the loss of the control as the
      // expected state.
      expect(existsSync(target)).toBe(false);
    });

    it("passes and allows --write once the denied privilege is gone", async () => {
      // The allow side — the policy must not make a clean database unauditable.
      writeFileSync(policyPath, policy(["UPDATE"]));
      const target = join(tmpDir, "clean-write.json");
      rmSync(target, { force: true });

      const r = runAuditWrite(target, { DB_DENIED_PRIVILEGES: policyPath });
      expect(r.status, r.stderr).toBe(0);
      expect(existsSync(target)).toBe(true);
    });
  });
});
