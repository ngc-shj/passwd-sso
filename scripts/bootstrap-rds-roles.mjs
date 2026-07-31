#!/usr/bin/env node
// Create the least-privilege DB roles on a fresh RDS instance BEFORE the first
// `prisma migrate deploy`. RDS does NOT run infra/postgres/initdb/*.sql (those
// are for the Docker Postgres image only), so the roles that the app + workers
// log in as — and that some migrations conditionally GRANT to — must be created
// out of band. `passwd_app` in particular MUST exist before the migration.
//
// Runs INSIDE the VPC (RDS's SG admits 5432 only from the ECS SG), launched via
// the migrate task + ECS Exec — see infra/terraform/README.md "Creating the DB
// roles on RDS". The node:alpine app image has no `psql` binary, but it ships
// the `pg` module, which is all this needs.
//
// CONVERGENT for role ATTRIBUTES, passwords and memberships: re-running does
// not just skip work, it forces every role back to the intended state. For each
// role it CREATEs when absent and then ALWAYS applies
// `ALTER ROLE ... <fixed attrs> PASSWORD <new>`, strips any inherited role
// membership, and asserts the resulting pg_roles attributes. So a re-run with a
// rotated password installs it, and a role manually escalated to
// SUPERUSER/BYPASSRLS/REPLICATION is demoted back.
//
// NOT convergent for existing-object ACLs on the WORKER roles — those are owned
// by the Prisma migrations and this script runs before them; see the scope note
// at the worker loop below, and `scripts/audit-db-grants.mjs` for detecting
// surplus grants. (passwd_app's schema/table ACLs ARE converged here, because
// this script is their sole owner.)
//
// The schema-level GRANT/REVOKE statements are safe to re-run, so a
// partially-failed run can simply be re-executed.
//
// DDL (CREATE ROLE) cannot use bind parameters — `CREATE ROLE x PASSWORD $1` is
// a syntax error in Postgres. Passwords are therefore quoted with pg's
// escapeLiteral() (server-correct string-literal escaping) and interpolated.
// Role NAMES are a fixed hardcoded allowlist below (never user input), so they
// are interpolated directly.
//
// Required env (the operator exports these in the ECS Exec shell; they are the
// SAME passwords used to build the DATABASE_URL / *_WORKER_DATABASE_URL secrets):
//   MIGRATION_DATABASE_URL          — SUPERUSER (RDS master) connection string
//   PASSWD_APP_PASSWORD             — passwd_app role password
//   PASSWD_OUTBOX_WORKER_PASSWORD   — passwd_outbox_worker role password
//   PASSWD_RETENTION_GC_WORKER_PASSWORD — passwd_retention_gc_worker role password

import { Client } from "pg";
import { pathToFileURL } from "node:url";
// ONE loader/validator, shared with scripts/audit-db-grants.mjs. Two copies of
// a security policy converge on the weaker one — which had already happened
// here: this file validated every entry and the audit validated only that a
// `denied` array existed.
import {
  loadDeniedPolicy,
  subjectOf,
  isSequenceEntry,
  assertSubjectKind,
} from "./lib/denied-privileges.mjs";
// Re-exported so the integration test drives the SAME loader the script uses,
// rather than a second import path that could diverge from it.
export { loadDeniedPolicy };

// The prescriptive must-never-be-granted declaration, shared with
// scripts/audit-db-grants.mjs. See applyDeniedPrivileges below.

// Roles created here. Table-specific GRANTs for the worker roles are issued by
// the Prisma migrations that create those tables (they carry IF NOT EXISTS role
// guards) — mirror ONLY what infra/postgres/initdb/02-create-app-role.sql does
// at initdb time (role creation + schema-level privileges).
const ROLES = [
  { name: "passwd_app", pwEnv: "PASSWD_APP_PASSWORD" },
  { name: "passwd_outbox_worker", pwEnv: "PASSWD_OUTBOX_WORKER_PASSWORD" },
  { name: "passwd_retention_gc_worker", pwEnv: "PASSWD_RETENTION_GC_WORKER_PASSWORD" },
];

// The attribute set every role above must END UP with, applied on both CREATE
// and ALTER so a pre-existing (possibly privilege-escalated) role converges.
// NOREPLICATION matters as much as NOSUPERUSER: REPLICATION lets a role open a
// replication connection and stream the entire database (and create/drop
// replication slots) — a full data-exfiltration path that none of these roles
// needs. Every attribute listed here is asserted in ROLE_ATTR_EXPECTATIONS
// below, so the two cannot drift apart silently.
const ROLE_ATTRS =
  "LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION";

// pg_roles column -> the value convergence must produce. Asserted after ALTER.
const ROLE_ATTR_EXPECTATIONS = {
  rolsuper: false,
  rolbypassrls: false,
  rolcreatedb: false,
  rolcreaterole: false,
  rolreplication: false,
  rolcanlogin: true,
};

// Double-quote a Postgres identifier (doubling embedded quotes). Used for role
// names read back from pg_roles, which are not part of our hardcoded allowlist.
function quoteIdent(name) {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Apply `scripts/checks/app-role-denied-privileges.json`.
 *
 * Kept as data rather than statements in this file so that the SAME declaration
 * drives both this script and `scripts/audit-db-grants.mjs`'s
 * DENIED_PRIVILEGE_HELD / DENIED_PRIVILEGE_IN_MANIFEST checks. Two copies of a
 * security policy is how the first one came to be undone without anything
 * noticing.
 *
 * Exported for the same reason `convergeRole` is: the integration test drives
 * the real function against a throwaway probe role and table.
 */
/**
 * Re-apply the declared must-never-be-granted set.
 *
 * THROWS rather than calling `process.exit` — it runs inside the caller's
 * transaction, and killing the process there skips the ROLLBACK, committing the
 * blanket grant without the revokes.
 */
export async function applyDeniedPrivileges(
  client,
  denied = loadDeniedPolicy(),
  { requireTargets = false } = {},
) {
  for (const d of denied) {
    const privs = d.privileges.join(", ");
    // `to_regclass` resolves sequences as well as tables, so one guard covers
    // both entry kinds; the REVOKE below needs the `SEQUENCE` keyword because
    // the bare form defaults to TABLE and errors on a sequence.
    const subject = subjectOf(d);
    const target = isSequenceEntry(d) ? `SEQUENCE ${subject}` : subject;

    const { rows } = await client.query(
      `SELECT to_regclass($1) IS NOT NULL AS table_exists,
              (SELECT relkind FROM pg_class WHERE oid = to_regclass($1)) AS relkind,
              EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $2) AS role_exists`,
      [subject, d.role],
    );
    const { table_exists: tableExists, relkind, role_exists: roleExists } = rows[0];
    // Before the existence branch below, so a wrong-kind entry is a hard error
    // rather than something the pre-migration skip can hide on a fresh database.
    assertSubjectKind(d, relkind);

    if (!tableExists || !roleExists) {
      // Tolerated in the FULL run, which is documented to happen before the
      // first migration — the audit tables genuinely do not exist yet.
      //
      // Refused in `--denied-only`, which is post-migration by definition. There,
      // a target that is missing means the POLICY is wrong (a mistyped table, a
      // renamed role), and skipping it silently printed "policy applied" and
      // exited 0 — a green CI step that revoked nothing. A mode whose entire job
      // is to apply the policy must not succeed without applying it.
      if (requireTargets) {
        throw new Error(
          `DENIED_POLICY_TARGET_MISSING: ${d.role} / ${subject} — ` +
            `${tableExists ? "role" : "object"} does not exist. This mode runs AFTER ` +
            "the migrations, so a missing target is a policy error, not the " +
            "pre-migration state. Nothing was applied; the transaction is rolled back.",
        );
      }
      console.log(`  denied: SKIPPED (target absent) ${subject} — pre-migration run`);
      continue;
    }

    await client.query(`REVOKE ${privs} ON ${target} FROM ${d.role}`);
    console.log(`  denied: REVOKE ${privs} ON ${target} FROM ${d.role}`);

    // Re-grant the column-scoped exceptions, AFTER the revoke and never before
    // it. Measured on a throwaway database: `REVOKE <priv> ON TABLE` erases the
    // COLUMN-level grants of that privilege too (`pg_attribute.attacl` goes
    // empty), so the revoke above undoes the migration's `GRANT INSERT (…)`
    // every time this runs. Without this loop the convergence run that is
    // supposed to RESTORE a control would instead leave `passwd_app` unable to
    // append a routing event at all — and that writer is fail-closed, so the
    // symptom is denied first-ever sign-ins rather than a missing history row.
    for (const [priv, columns] of Object.entries(d.columnGrants ?? {})) {
      const cols = columns.join(", ");
      await client.query(`GRANT ${priv} (${cols}) ON ${subject} TO ${d.role}`);
      console.log(`  denied: GRANT ${priv} (${cols}) ON ${subject} TO ${d.role}`);
    }
  }
}

/**
 * Converge one role to the intended attributes + password, stripping any
 * inherited membership. Exported so the integration test can exercise the exact
 * production convergence logic against throwaway probe roles instead of the
 * real passwd_* roles.
 *
 * @param {import("pg").Client} client SUPERUSER connection
 * @param {string} name role name (caller-controlled allowlist, not user input)
 * @param {string} password plaintext password to install
 */
export async function convergeRole(client, name, password) {
  const { rowCount } = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [name]);
  // escapeLiteral wraps + escapes for the server's string-literal syntax.
  const pw = client.escapeLiteral(password);
  if (rowCount === 0) {
    await client.query(`CREATE ROLE ${name} WITH ${ROLE_ATTRS} PASSWORD ${pw}`);
    console.log(`created role ${name}`);
  } else {
    console.log(`role ${name} exists — converging attributes + password`);
  }
  // ALWAYS converge, existing or not. A pre-existing role may carry the WRONG
  // password (the operator supplied a new one) or have been altered to
  // SUPERUSER/BYPASSRLS/CREATEDB/CREATEROLE out of band — skipping this for
  // existing roles silently leaves a privilege-escalated role in place and an
  // unusable password. ALTER ROLE is the convergence point; it is idempotent.
  await client.query(`ALTER ROLE ${name} WITH ${ROLE_ATTRS} PASSWORD ${pw}`);

  // Role MEMBERSHIP is not covered by ALTER ROLE's attribute list: an inherited
  // grant (e.g. GRANT rds_superuser TO passwd_app) re-introduces privileges the
  // attributes above just removed. Strip every membership — none of these roles
  // is supposed to inherit from anything.
  const { rows: memberships } = await client.query(
    `SELECT g.rolname AS grantor
       FROM pg_auth_members m
       JOIN pg_roles g ON g.oid = m.roleid
       JOIN pg_roles r ON r.oid = m.member
      WHERE r.rolname = $1`,
    [name],
  );
  for (const { grantor } of memberships) {
    // Role names come from pg_roles (server-side); re-quoted as identifiers.
    await client.query(`REVOKE ${quoteIdent(grantor)} FROM ${name}`);
    console.log(`  revoked membership ${grantor} from ${name}`);
  }

  // Fail loudly if convergence did not actually take (defence against a future
  // Postgres/RDS quirk silently ignoring one of the attributes). Driven by
  // ROLE_ATTR_EXPECTATIONS so every asserted attribute is checked by name and a
  // newly added one cannot be forgotten here.
  const columns = Object.keys(ROLE_ATTR_EXPECTATIONS);
  const { rows } = await client.query(
    `SELECT ${columns.join(", ")} FROM pg_roles WHERE rolname = $1`,
    [name],
  );
  const actual = rows[0];
  const mismatched = columns.filter((c) => actual[c] !== ROLE_ATTR_EXPECTATIONS[c]);
  if (mismatched.length > 0) {
    throw new Error(
      `role ${name} did not converge — ${mismatched.join(", ")} unexpected: ${JSON.stringify(actual)}`,
    );
  }
}

async function main() {
  const connectionString = process.env.MIGRATION_DATABASE_URL;
  if (!connectionString) {
    console.error("ERROR: MIGRATION_DATABASE_URL is required (SUPERUSER connection).");
    process.exit(1);
  }

  // `--denied-only` applies the must-never-be-granted policy and nothing else.
  //
  // It exists because of an ORDERING property that is easy to get wrong: this
  // script's full run happens BEFORE the first migration, where the audit tables
  // do not exist yet and the `to_regclass` guard correctly skips them. Any
  // pipeline that issues a blanket `GRANT ... ON ALL TABLES` AFTER the migrations
  // therefore re-grants what migration 20260522000200 revoked, with nothing left
  // to take it back.
  //
  // `.github/workflows/ci-integration.yml` did exactly that on every run — the
  // third instance of this class after the RDS bootstrap itself. Rather than
  // spell the policy a fourth time in YAML, that step now calls this mode, so
  // there is still one source for what may never be granted.
  const deniedOnly = process.argv.includes("--denied-only");

  if (!deniedOnly) {
    for (const r of ROLES) {
      if (!process.env[r.pwEnv]) {
        console.error(`ERROR: ${r.pwEnv} is required (password for ${r.name}).`);
        process.exit(1);
      }
    }
  }

  // Validated BEFORE the client is even built: a malformed or missing policy
  // must stop the run while the database is still untouched.
  const denied = loadDeniedPolicy();

  if (deniedOnly) {
    const client = new Client({ connectionString });
    await client.connect();
    try {
      await client.query("BEGIN");
      // requireTargets: this mode is post-migration, so a missing target is a
      // policy error rather than the pre-migration state.
      await applyDeniedPrivileges(client, denied, { requireTargets: true });
      await client.query("COMMIT");
      console.log("bootstrap-rds-roles: denied-privilege policy applied");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      await client.end();
    }
    return;
  }

  const client = new Client({ connectionString });
  await client.connect();
  try {
    for (const r of ROLES) {
      await convergeRole(client, r.name, process.env[r.pwEnv]);
    }

    // ONE transaction for the whole privilege sequence.
    //
    // The blanket `GRANT ... ON ALL TABLES` and the deny REVOKEs that narrow it
    // back are two ends of a single intended state. Run as autocommit
    // statements, a crash, a lost connection or a thrown error between them
    // commits only the widening half — leaving the immutable audit tables
    // writable until someone happens to re-run this script. "Convergent and
    // re-runnable" is not sufficient for a security control: it describes the
    // steady state, not the window.
    //
    // Every statement below is transactional DDL in PostgreSQL (GRANT, REVOKE,
    // ALTER DEFAULT PRIVILEGES), so the rollback is real.
    await client.query("BEGIN");
    // Schema-level privileges — mirror 02-create-app-role.sql. Safe to re-run.
    await client.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");

    // passwd_app: CONNECT + USAGE + full DML on current + future tables/sequences.
    // Revoke FIRST so a role that was over-granted out of band (extra table
    // privileges such as TRUNCATE/REFERENCES, or CREATE on the schema) converges
    // down to exactly this set rather than keeping the surplus — same
    // revoke-then-grant shape used for the worker roles below.
    await client.query("REVOKE ALL ON SCHEMA public FROM passwd_app");
    await client.query("REVOKE ALL ON ALL TABLES IN SCHEMA public FROM passwd_app");
    await client.query("REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM passwd_app");
    await client.query(
      "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM passwd_app",
    );
    await client.query(
      "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM passwd_app",
    );
    await client.query(
      "DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO passwd_app', current_database()); END $$",
    );
    await client.query("GRANT USAGE ON SCHEMA public TO passwd_app");
    await client.query(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO passwd_app",
    );
    await client.query(
      "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO passwd_app",
    );
    await client.query(
      "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO passwd_app",
    );
    await client.query(
      "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO passwd_app",
    );

    // Re-apply the declared must-never-be-granted set, AFTER the blanket grant
    // above and derived from a single prescriptive file rather than spelled
    // here.
    //
    // The blanket `GRANT ... ON ALL TABLES` is table-blind, so on any run that
    // happens AFTER the migrations it re-granted exactly what migration
    // 20260522000200_audit_log_revoke_via_definer had revoked: UPDATE/DELETE on
    // audit_logs and audit_chain_anchors. The comment on the worker block below
    // shows the authors reasoned carefully about grants the migrations ADD; what
    // was missed is that a migration can also install a NEGATIVE grant, and this
    // script is documented as convergent and re-runnable — so every convergence
    // run silently reopened an OWASP A04-2 control.
    //
    // Idempotent, and safe on a pre-migration run: REVOKE on a table that does
    // not exist yet is skipped by the to_regclass guard.
    await applyDeniedPrivileges(client, denied);

    // Worker roles: SCHEMA-level and DEFAULT privileges only.
    //
    // Scope note (do not over-read this as convergence): unlike passwd_app
    // above, existing-object ACLs are deliberately NOT revoked here. The
    // workers' legitimate table grants are issued by the Prisma migrations that
    // create those tables (13 migrations at present), and this script runs
    // BEFORE the first migration — so at this point those grants do not exist
    // yet, and a blanket `REVOKE ALL ON ALL TABLES` on a re-run would strip the
    // legitimate ACLs the migrations installed. Consequence: a table privilege
    // granted to a worker out of band is NOT removed by re-running this script.
    // Detecting that surplus is the job of `scripts/audit-db-grants.mjs`, which
    // diffs the live ACLs against the expected set after the migrations have
    // run.
    for (const worker of ["passwd_outbox_worker", "passwd_retention_gc_worker"]) {
      await client.query(`REVOKE ALL ON SCHEMA public FROM ${worker}`);
      await client.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM ${worker}`,
      );
      await client.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM ${worker}`,
      );
      await client.query(
        `DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO ${worker}', current_database()); END $$`,
      );
      await client.query(`GRANT USAGE ON SCHEMA public TO ${worker}`);
      // Prevent SUPERUSER's ALTER DEFAULT PRIVILEGES from implicitly granting
      // REFERENCES on future tables to the worker (defense-in-depth).
      await client.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE REFERENCES ON TABLES FROM ${worker}`,
      );
    }

    await client.query("COMMIT");
    console.log("bootstrap-rds-roles: done");
  } catch (e) {
    // Nothing partial survives: without this, a failure after the blanket GRANT
    // leaves the audit tables writable.
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await client.end();
  }
}

// Run only when invoked as a CLI, so the integration test can import
// convergeRole() without the script connecting to a DB on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
