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

/**
 * Read the live ACLs for the audited roles at BOTH granularities.
 *
 * Two separate catalogs, and both are required:
 *
 *   TABLE:<role>\t<table>\t<priv>          from role_table_grants
 *   COLUMN:<role>\t<table>.<col>\t<priv>   from column_privileges, EXCLUDING
 *                                          rows implied by a table-level grant
 *
 * `role_table_grants` does NOT contain column-scoped grants — that was a wrong
 * assumption in the first version of this script, and it made the audit blind to
 * every `GRANT UPDATE (col) ON t` in the migrations (13 of them at the time).
 * Conversely `column_privileges` lists every column of a table that has a
 * table-level grant, so taking it wholesale would bury the interesting rows in
 * thousands of implied ones.
 *
 * Keying columns individually matters: a table that legitimately has
 * `UPDATE (fail_count)` must still fail the audit if `UPDATE (secret_col)` is
 * added. Collapsing to "can UPDATE this table" would hide exactly that.
 */
async function readLiveGrants(client) {
  const { rows: tableRows } = await client.query(
    `SELECT grantee, table_name, privilege_type
       FROM information_schema.role_table_grants
      WHERE grantee = ANY($1)
        AND table_schema = 'public'`,
    [AUDITED_ROLES],
  );
  const { rows: columnRows } = await client.query(
    `SELECT cp.grantee, cp.table_name, cp.column_name, cp.privilege_type
       FROM information_schema.column_privileges cp
      WHERE cp.grantee = ANY($1)
        AND cp.table_schema = 'public'
        -- Keep only column grants NOT already implied by a table-level grant of
        -- the same privilege; those are the deliberately column-scoped ones.
        AND NOT EXISTS (
          SELECT 1
            FROM information_schema.role_table_grants tg
           WHERE tg.grantee = cp.grantee
             AND tg.table_schema = cp.table_schema
             AND tg.table_name = cp.table_name
             AND tg.privilege_type = cp.privilege_type
        )`,
    [AUDITED_ROLES],
  );

  const keys = [
    ...tableRows.map((r) => `TABLE:${r.grantee}\t${r.table_name}\t${r.privilege_type}`),
    ...columnRows.map(
      (r) => `COLUMN:${r.grantee}\t${r.table_name}.${r.column_name}\t${r.privilege_type}`,
    ),
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
      "Expected table-level ACLs for the least-privilege DB roles, as " +
      "role<TAB>table<TAB>privilege. Generated by scripts/audit-db-grants.mjs " +
      "--write from a known-good database AFTER migrations. Regenerate ONLY " +
      "when a migration intentionally changes a grant, and review the diff — " +
      "it is the security-relevant part of that migration.",
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
