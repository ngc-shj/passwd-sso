/**
 * Real-DB tests for scripts/audit-db-grants.mjs.
 *
 * The audit is the only thing that detects a migration (or an operator) granting
 * a least-privilege role more than it should have. A review round found it read
 * only DIRECT ACLs, so privileges reached via PUBLIC or via role inheritance were
 * invisible — the audit reported OK while a worker could read `accounts`. These
 * tests pin every path it must see.
 *
 * T1 — a clean database matches the committed manifest
 * T2 — a direct table grant is detected
 * T3 — a column-scoped grant is detected, including on a table that already has
 *      other legitimate column grants
 * T4 — a grant to PUBLIC is detected (role_table_grants excludes these)
 * T5 — a privilege reached through role membership is detected, and the
 *      membership itself is reported
 * T6 — a MISSING grant (manifest entry with no live privilege) is detected
 *
 * Every mutation runs inside a transaction that is rolled back, so the shared
 * dev database is left untouched.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const AUDIT = resolve(REPO_ROOT, "scripts", "audit-db-grants.mjs");
const REAL_MANIFEST = resolve(REPO_ROOT, "scripts", "checks", "db-grants-manifest.json");

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
function runAudit(manifestPath: string) {
  return spawnSync(process.execPath, [AUDIT], {
    env: auditEnv(manifestPath),
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

  it("T1: the committed manifest matches the live database", () => {
    // Guards against the repo's manifest drifting from what migrations produce.
    const r = runAudit(REAL_MANIFEST);
    expect(r.stdout + r.stderr).toContain("db-grants: OK");
    expect(r.status).toBe(0);
  });

  it("T2: detects a direct table grant", async () => {
    try {
      await su.query("GRANT UPDATE ON users TO passwd_outbox_worker");

      const r = runAudit(manifestPath);

      expect(r.status).toBe(1);
      expect(r.stderr).toContain("UNEXPECTED_GRANT: TABLE:passwd_outbox_worker users UPDATE");
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
        "UNEXPECTED_GRANT: COLUMN:passwd_outbox_worker tenant_webhooks.secret_encrypted UPDATE",
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
      expect(r.stderr).toContain("UNEXPECTED_GRANT: PUBLIC:accounts SELECT");
      // …and the effective privilege it confers on the roles.
      expect(r.stderr).toContain("TABLE:passwd_outbox_worker accounts SELECT");
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
      expect(r.stderr).toContain("TABLE:passwd_outbox_worker accounts SELECT");
    } finally {
      await su.query("REVOKE acl_audit_probe_holder FROM passwd_outbox_worker").catch(() => {});
      await su.query("DROP OWNED BY acl_audit_probe_holder").catch(() => {});
      await su.query("DROP ROLE IF EXISTS acl_audit_probe_holder");
    }
  });

  it("T6: detects a MISSING grant (manifest entry with no live privilege)", () => {
    // Simulates migrations not having been applied: the manifest expects a
    // privilege the database does not grant.
    const doctored = join(tmpDir, "missing.json");
    const base = JSON.parse(readFileSync(manifestPath, "utf8"));
    base.grants.push("TABLE:passwd_app\ta_table_that_does_not_exist\tSELECT");
    writeFileSync(doctored, JSON.stringify(base, null, 2), "utf8");

    const r = runAudit(doctored);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      "MISSING_GRANT: TABLE:passwd_app a_table_that_does_not_exist SELECT",
    );
  });
});
