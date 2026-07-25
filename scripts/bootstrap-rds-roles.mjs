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
// Idempotent: each role is guarded by a pg_roles existence check, and the
// schema-level GRANT/REVOKE statements are themselves idempotent, so a partial
// run can be re-executed safely.
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

// Roles created here. Table-specific GRANTs for the worker roles are issued by
// the Prisma migrations that create those tables (they carry IF NOT EXISTS role
// guards) — mirror ONLY what infra/postgres/initdb/02-create-app-role.sql does
// at initdb time (role creation + schema-level privileges).
const ROLES = [
  { name: "passwd_app", pwEnv: "PASSWD_APP_PASSWORD" },
  { name: "passwd_outbox_worker", pwEnv: "PASSWD_OUTBOX_WORKER_PASSWORD" },
  { name: "passwd_retention_gc_worker", pwEnv: "PASSWD_RETENTION_GC_WORKER_PASSWORD" },
];

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
      const { rowCount } = await client.query(
        "SELECT 1 FROM pg_roles WHERE rolname = $1",
        [r.name],
      );
      if (rowCount > 0) {
        console.log(`role ${r.name} already exists — skipping CREATE`);
        continue;
      }
      // escapeLiteral wraps + escapes for the server's string-literal syntax.
      const pw = client.escapeLiteral(process.env[r.pwEnv]);
      await client.query(
        `CREATE ROLE ${r.name} WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD ${pw}`,
      );
      console.log(`created role ${r.name}`);
    }

    // Schema-level privileges — mirror 02-create-app-role.sql. Idempotent:
    // REVOKE/GRANT/ALTER DEFAULT PRIVILEGES are safe to re-run.
    await client.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");

    // passwd_app: CONNECT + USAGE + full DML on current + future tables/sequences.
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

    // Worker roles: CONNECT + USAGE only here; deny-by-default on everything
    // else. Their table-specific grants come from the Prisma migrations.
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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
