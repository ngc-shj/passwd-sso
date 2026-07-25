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
  for (const r of ROLES) {
    if (!process.env[r.pwEnv]) {
      console.error(`ERROR: ${r.pwEnv} is required (password for ${r.name}).`);
      process.exit(1);
    }
  }

  const client = new Client({ connectionString });
  await client.connect();
  try {
    for (const r of ROLES) {
      await convergeRole(client, r.name, process.env[r.pwEnv]);
    }
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

    console.log("bootstrap-rds-roles: done");
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
