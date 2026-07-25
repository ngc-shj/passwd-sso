#!/usr/bin/env node
/**
 * Audit the live database ACLs of the least-privilege roles against a
 * version-controlled expected set, and fail on any surplus.
 *
 * Why this is a separate command and not part of bootstrap-rds-roles.mjs:
 * the workers' legitimate table grants are issued by the Prisma migrations that
 * create those tables, and the bootstrap runs BEFORE the first migration. It
 * therefore cannot converge existing-object ACLs — a blanket
 * `REVOKE ALL ON ALL TABLES` on a re-run would strip exactly the grants the
 * migrations installed. So bootstrap owns role ATTRIBUTES/passwords/memberships,
 * the migrations own table ACLs, and THIS command is the detection layer that
 * catches a privilege granted out of band (or a migration that granted more
 * than intended).
 *
 * Run it AFTER migrations, against the deployed database:
 *   MIGRATION_DATABASE_URL=<superuser-url> node scripts/audit-db-grants.mjs
 *
 * Regenerate the manifest after an INTENTIONAL grant change (review the diff —
 * it is the security-relevant part of the migration):
 *   MIGRATION_DATABASE_URL=<url> node scripts/audit-db-grants.mjs --write
 *
 * Exit codes: 0 = live ACLs match the manifest; 1 = drift (surplus or missing).
 *
 * Findings:
 *   UNEXPECTED_GRANT: <role> <table> <privilege>  — live grant not in manifest
 *                                                   (the security-relevant
 *                                                   direction: over-privilege)
 *   MISSING_GRANT:    <role> <table> <privilege>  — manifest grant not live
 *                                                   (migrations not applied, or
 *                                                   a grant was revoked)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Client } from "pg";
import { pathToFileURL } from "node:url";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const MANIFEST_FILE =
  process.env.DB_GRANTS_MANIFEST ?? `${REPO_ROOT}scripts/checks/db-grants-manifest.json`;

/** Roles whose ACLs are audited. Anything not listed here is out of scope. */
const AUDITED_ROLES = [
  "passwd_app",
  "passwd_outbox_worker",
  "passwd_retention_gc_worker",
];

/** Table privileges that matter for these roles. */
const TABLE_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];

/**
 * Read the live EFFECTIVE privileges of the audited roles.
 *
 * Effective, not direct-ACL. An earlier version selected
 * `role_table_grants WHERE grantee = <role>`, which only lists privileges
 * granted DIRECTLY to that role. PostgreSQL reaches a privilege by three paths,
 * and that query saw one of them:
 *
 *   1. direct grant to the role            — visible in role_table_grants
 *   2. grant to PUBLIC                     — role_table_grants EXCLUDES these
 *   3. grant to a role the role is a member of (inheritance) — also excluded
 *
 * So `GRANT SELECT ON accounts TO PUBLIC` in a migration left the worker able to
 * read `accounts` while the audit reported OK. `has_table_privilege` /
 * `has_column_privilege` answer "can this role actually do this?", collapsing
 * all three paths, so they are what the audit compares against the manifest.
 *
 * Keys, all sorted into one list:
 *
 *   TABLE:<role>\t<table>\t<priv>          effective table privilege
 *   COLUMN:<role>\t<table>.<col>\t<priv>   effective column privilege NOT implied
 *                                          by the table-level one
 *   MEMBER:<role>\t<granted_role>          role membership (an inheritance path;
 *                                          none of these roles should have any)
 *   PUBLIC:<table>\t<priv>                 privilege granted to PUBLIC, which
 *                                          every role inherits
 *
 * Columns are keyed individually on purpose: a table that legitimately carries
 * `UPDATE (fail_count)` must still fail when `UPDATE (secret_encrypted)` appears.
 */
async function readLiveGrants(client) {
  // 1. Effective TABLE privileges.
  const { rows: tableRows } = await client.query(
    `SELECT r.rolname AS role, c.relname AS table_name, p.priv AS privilege_type
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN unnest($2::text[]) AS p(priv)
       CROSS JOIN unnest($1::text[]) AS r(rolname)
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p', 'v', 'm')
        AND has_table_privilege(r.rolname, c.oid, p.priv)`,
    [AUDITED_ROLES, TABLE_PRIVILEGES],
  );

  // 2. Effective COLUMN privileges not already implied by the table-level one.
  const { rows: columnRows } = await client.query(
    `SELECT r.rolname AS role, c.relname AS table_name, a.attname AS column_name,
            p.priv AS privilege_type
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
       CROSS JOIN unnest($2::text[]) AS p(priv)
       CROSS JOIN unnest($1::text[]) AS r(rolname)
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p', 'v', 'm')
        AND p.priv IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
        AND has_column_privilege(r.rolname, c.oid, a.attname, p.priv)
        AND NOT has_table_privilege(r.rolname, c.oid, p.priv)`,
    [AUDITED_ROLES, TABLE_PRIVILEGES],
  );

  // 3. Role MEMBERSHIPS — an inheritance path into arbitrary privileges. None of
  //    these roles is supposed to be a member of anything (bootstrap-rds-roles
  //    strips memberships), so any row here is a finding.
  const { rows: memberRows } = await client.query(
    `SELECT r.rolname AS role, g.rolname AS granted_role
       FROM pg_auth_members m
       JOIN pg_roles r ON r.oid = m.member
       JOIN pg_roles g ON g.oid = m.roleid
      WHERE r.rolname = ANY($1)`,
    [AUDITED_ROLES],
  );

  // 4. Privileges granted to PUBLIC. Every role inherits these, so they are the
  //    quietest way to over-privilege the whole system at once. Audited
  //    independently of the roles.
  const { rows: publicRows } = await client.query(
    `SELECT c.relname AS table_name, p.priv AS privilege_type
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN unnest($1::text[]) AS p(priv)
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p', 'v', 'm')
        AND has_table_privilege('public', c.oid, p.priv)`,
    [TABLE_PRIVILEGES],
  );

  const keys = [
    ...tableRows.map((r) => `TABLE:${r.role}\t${r.table_name}\t${r.privilege_type}`),
    ...columnRows.map(
      (r) => `COLUMN:${r.role}\t${r.table_name}.${r.column_name}\t${r.privilege_type}`,
    ),
    ...memberRows.map((r) => `MEMBER:${r.role}\t${r.granted_role}`),
    ...publicRows.map((r) => `PUBLIC:${r.table_name}\t${r.privilege_type}`),
  ];
  return [...new Set(keys)].sort();
}

function readManifest() {
  if (!existsSync(MANIFEST_FILE)) {
    console.error(
      `MANIFEST_MISSING: ${MANIFEST_FILE}\n` +
        `Generate it from a known-good database with --write, then review and commit it.`,
    );
    process.exit(1);
  }
  const parsed = JSON.parse(readFileSync(MANIFEST_FILE, "utf8"));
  if (!Array.isArray(parsed.grants)) {
    console.error(`MANIFEST_INVALID: ${MANIFEST_FILE} has no "grants" array.`);
    process.exit(1);
  }
  return parsed.grants.slice().sort();
}

function writeManifest(grants) {
  const body = {
    _comment:
      "Expected EFFECTIVE privileges of the least-privilege DB roles. Key forms: " +
      "'TABLE:<role><TAB><table><TAB><priv>', " +
      "'COLUMN:<role><TAB><table>.<column><TAB><priv>' (only where not implied by " +
      "the table-level privilege), 'MEMBER:<role><TAB><granted_role>' (role " +
      "membership — an inheritance path; these roles should have none), and " +
      "'PUBLIC:<table><TAB><priv>' (granted to PUBLIC, therefore inherited by " +
      "every role). Computed with has_table_privilege/has_column_privilege, so " +
      "privileges reached via PUBLIC or via inheritance are included — direct-ACL " +
      "views such as role_table_grants omit both. Generated by " +
      "scripts/audit-db-grants.mjs --write from a known-good database AFTER " +
      "migrations. Regenerate ONLY when a migration intentionally changes a " +
      "grant, and review the diff — it is the security-relevant part of that " +
      "migration.",
    grants,
  };
  writeFileSync(MANIFEST_FILE, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  console.log(`wrote ${grants.length} grants to ${MANIFEST_FILE}`);
}

async function main() {
  const write = process.argv.includes("--write");
  const connectionString = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("ERROR: MIGRATION_DATABASE_URL (or DATABASE_URL) is required.");
    process.exit(1);
  }

  const client = new Client({ connectionString });
  await client.connect();
  let live;
  try {
    live = await readLiveGrants(client);
  } finally {
    await client.end();
  }

  if (write) {
    writeManifest(live);
    return;
  }

  const expected = new Set(readManifest());
  const liveSet = new Set(live);

  const findings = [];
  for (const key of live) {
    if (!expected.has(key)) {
      findings.push(`UNEXPECTED_GRANT: ${key.replace(/\t/g, " ")}`);
    }
  }
  for (const key of expected) {
    if (!liveSet.has(key)) {
      findings.push(`MISSING_GRANT: ${key.replace(/\t/g, " ")}`);
    }
  }

  if (findings.length > 0) {
    console.error("DB grant audit FAILED:\n");
    for (const f of findings) console.error(`  ${f}`);
    console.error(
      `\nAn UNEXPECTED_GRANT means a role holds a table privilege the manifest` +
        `\ndoes not sanction — revoke it, or if a migration granted it` +
        `\nintentionally, regenerate the manifest with --write and review the diff.` +
        `\nA MISSING_GRANT usually means migrations have not been applied.\n`,
    );
    process.exit(1);
  }

  console.log(`db-grants: OK (${live.length} grants match the manifest)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

export { readLiveGrants, AUDITED_ROLES };
