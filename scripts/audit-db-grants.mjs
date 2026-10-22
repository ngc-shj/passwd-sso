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
 *   UNEXPECTED_GRANT: <manifest key>  — live privilege not in the manifest (the
 *                                       security-relevant direction: over-privilege)
 *   MISSING_GRANT:    <manifest key>  — manifest entry with no live privilege
 *                                       (migrations not applied, or a grant was
 *                                       revoked)
 *   DENIED_SETTING_HELD / _IN_MANIFEST  — a role or database session default no
 *                                       one may carry (app.*, client_min_messages,
 *                                       log_min_messages, row_security)
 *   ROLE_STATE_VIOLATION / _IN_MANIFEST — a role state that is never legitimate
 *                                       (see roleStateViolations)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Client } from "pg";
import { pathToFileURL } from "node:url";
import {
  loadDeniedPolicy,
  deniedFile,
  subjectOf,
  isSequenceEntry,
  assertSubjectKind,
} from "./lib/denied-privileges.mjs";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const MANIFEST_FILE =
  process.env.DB_GRANTS_MANIFEST ?? `${REPO_ROOT}scripts/checks/db-grants-manifest.json`;

// The PRESCRIPTIVE companion to the manifest above, loaded and validated by the
// SAME module the bootstrap uses. The manifest is a SNAPSHOT of a live database
// (`--write`), so it records whatever is there — including a control that has
// been silently undone, which is exactly how the audit_logs/audit_chain_anchors
// REVOKE from migration 20260522000200 came to be reported as expected.

/** Roles whose ACLs are audited. Anything not listed here is out of scope. */
const AUDITED_ROLES = [
  "passwd_app",
  "passwd_outbox_worker",
  "passwd_retention_gc_worker",
  "passwd_anchor_publisher",
  "passwd_dcr_cleanup_worker",
];

/**
 * Audited roles that must stay retired: NOLOGIN, nothing beyond what PUBLIC
 * holds, and no role able to act as them. Migration
 * 20261023010000_retire_dcr_cleanup_worker_role is what puts them there; this
 * list is what keeps them there (see roleStateViolations).
 */
const RETIRED_ROLES = ["passwd_dcr_cleanup_worker"];

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
 * Keys, all sorted into one list. Object names are SCHEMA-QUALIFIED — every
 * non-system schema is audited, not just `public`, so a migration cannot hide a
 * grant by putting the table somewhere else:
 *
 *   TABLE:<role>\t<schema>.<table>\t<priv>        effective table privilege
 *   COLUMN:<role>\t<schema>.<table>.<col>\t<priv> effective column privilege NOT
 *                                                 implied by the table-level one
 *   MEMBER:<role>\t<granted_role>\tadmin=<t|f>,inherit=<t|f>,set=<t|f>
 *                                                 role membership (an inheritance
 *                                                 path; these roles should have
 *                                                 none), and every membership IN a
 *                                                 retired role
 *   PUBLIC:<schema>.<table>\t<priv>               granted to PUBLIC, so inherited
 *                                                 by every role
 *   SCHEMA:<grantee>\t<schema>\t<priv>            USAGE/CREATE (CREATE lets the
 *                                                 role add its own objects)
 *   SEQUENCE:<grantee>\t<schema>.<seq>\t<priv>    USAGE/SELECT/UPDATE
 *   FUNCTION:<grantee>\t<schema>.<ident>\tEXECUTE routine EXECUTE, suffixed
 *                                                 SECURITY_DEFINER when the routine
 *                                                 runs with its OWNER's privileges
 *   DATABASE:<grantee>\t<db>\t<priv>              CONNECT/CREATE/TEMP
 *   DEFAULTACL:<owner>\t<schema>\t<type>\t<acl>   pre-authorises objects that do
 *                                                 not exist yet
 *   ROLEATTR:<role>\t<attr>\t<value>              SUPERUSER/BYPASSRLS/REPLICATION/
 *                                                 CREATEDB/CREATEROLE/LOGIN
 *   ROLESETTING:<role|*>\t<db|*>\t<name>=<value>  a per-role / per-database
 *                                                 default GUC (ALTER ROLE … SET,
 *                                                 ALTER DATABASE … SET); `*` is
 *                                                 "every role" / "every database"
 *
 * Columns are keyed individually on purpose: a table that legitimately carries
 * `UPDATE (fail_count)` must still fail when `UPDATE (secret_encrypted)` appears.
 *
 * FUNCTION matters because PostgreSQL grants EXECUTE to PUBLIC by DEFAULT: a
 * SECURITY DEFINER routine is callable by every role unless a migration revokes
 * it, and it then runs with its owner's privileges — a direct escalation path no
 * table-level audit can see.
 */
/**
 * SQL predicate selecting the schemas whose objects we audit: every
 * application schema, i.e. everything except PostgreSQL's own catalogs and the
 * per-session temp/toast schemas.
 *
 * Pinning this to `= 'public'` (as an earlier version did) meant a migration
 * could create a schema, put a table in it, grant the worker SELECT, and the
 * audit still reported OK. All object keys below are schema-qualified for the
 * same reason — `secrets` in two schemas must not collapse to one key.
 */
const AUDITABLE_SCHEMAS = `n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg_toast%'
        AND n.nspname NOT LIKE 'pg_temp%'
        AND n.nspname NOT LIKE 'pg_toast_temp%'`;

async function readLiveGrants(client) {
  // 1. Effective TABLE privileges.
  const { rows: tableRows } = await client.query(
    `SELECT r.rolname AS role, n.nspname AS schema_name, c.relname AS table_name,
            p.priv AS privilege_type
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN unnest($2::text[]) AS p(priv)
       CROSS JOIN unnest($1::text[]) AS r(rolname)
      WHERE ${AUDITABLE_SCHEMAS}
        AND c.relkind IN ('r', 'p', 'v', 'm')
        AND has_table_privilege(r.rolname, c.oid, p.priv)`,
    [AUDITED_ROLES, TABLE_PRIVILEGES],
  );

  // 2. Effective COLUMN privileges not already implied by the table-level one.
  const { rows: columnRows } = await client.query(
    `SELECT r.rolname AS role, n.nspname AS schema_name, c.relname AS table_name,
            a.attname AS column_name, p.priv AS privilege_type
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
       CROSS JOIN unnest($2::text[]) AS p(priv)
       CROSS JOIN unnest($1::text[]) AS r(rolname)
      WHERE ${AUDITABLE_SCHEMAS}
        AND c.relkind IN ('r', 'p', 'v', 'm')
        AND p.priv IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
        AND has_column_privilege(r.rolname, c.oid, a.attname, p.priv)
        AND NOT has_table_privilege(r.rolname, c.oid, p.priv)`,
    [AUDITED_ROLES, TABLE_PRIVILEGES],
  );

  // 3. Role MEMBERSHIPS — an inheritance path into arbitrary privileges. None of
  //    these roles is supposed to be a member of anything (bootstrap-rds-roles
  //    strips memberships), so any row here is a finding. Also every role that
  //    is a member OF a retired role, audited or not: that is a way to act as
  //    it. The option bits go into the key because PostgreSQL 16 gives a
  //    creating CREATEROLE role an ADMIN-only membership in what it creates (on
  //    RDS, the master's row in every role a migration created), which confers
  //    none of the role's privileges — roleStateViolations decides on them.
  const { rows: memberRows } = await client.query(
    `SELECT r.rolname AS role, g.rolname AS granted_role,
            m.admin_option, m.inherit_option, m.set_option
       FROM pg_auth_members m
       JOIN pg_roles r ON r.oid = m.member
       JOIN pg_roles g ON g.oid = m.roleid
      WHERE r.rolname = ANY($1) OR g.rolname = ANY($2)`,
    [AUDITED_ROLES, RETIRED_ROLES],
  );

  // 4. Privileges granted to PUBLIC. Every role inherits these, so they are the
  //    quietest way to over-privilege the whole system at once. Audited
  //    independently of the roles.
  const { rows: publicRows } = await client.query(
    `SELECT n.nspname AS schema_name, c.relname AS table_name, p.priv AS privilege_type
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN unnest($1::text[]) AS p(priv)
      WHERE ${AUDITABLE_SCHEMAS}
        AND c.relkind IN ('r', 'p', 'v', 'm')
        AND has_table_privilege('public', c.oid, p.priv)`,
    [TABLE_PRIVILEGES],
  );

  // 5. SCHEMA privileges. CREATE on a schema lets the role add its own objects
  //    there (tables, functions) — a strong privilege that no table-level audit
  //    would ever surface. PUBLIC is included for the same reason as above.
  const { rows: schemaRows } = await client.query(
    `SELECT g.grantee, n.nspname AS schema_name, p.priv AS privilege_type
       FROM pg_namespace n
       CROSS JOIN unnest(ARRAY['USAGE', 'CREATE']::text[]) AS p(priv)
       CROSS JOIN unnest($1::text[] || ARRAY['public']) AS g(grantee)
      WHERE ${AUDITABLE_SCHEMAS}
        AND has_schema_privilege(g.grantee, n.nspname, p.priv)`,
    [AUDITED_ROLES],
  );

  // 6. SEQUENCE privileges. USAGE/UPDATE on a sequence lets a role advance it;
  //    SELECT reads it. Sequences are separate objects from their tables.
  const { rows: sequenceRows } = await client.query(
    `SELECT g.grantee, n.nspname AS schema_name, c.relname AS sequence_name,
            p.priv AS privilege_type
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN unnest(ARRAY['USAGE', 'SELECT', 'UPDATE']::text[]) AS p(priv)
       CROSS JOIN unnest($1::text[] || ARRAY['public']) AS g(grantee)
      WHERE ${AUDITABLE_SCHEMAS}
        AND c.relkind = 'S'
        AND has_sequence_privilege(g.grantee, c.oid, p.priv)`,
    [AUDITED_ROLES],
  );

  // 6b. FUNCTION / PROCEDURE EXECUTE. PostgreSQL grants EXECUTE to PUBLIC by
  //     DEFAULT, so a SECURITY DEFINER routine is callable by every role unless
  //     the migration explicitly revokes it — the routine then runs with its
  //     OWNER's privileges, which is a direct privilege-escalation path that no
  //     table-level audit can see. Keyed by function IDENTITY (name + argument
  //     types) because overloads are distinct objects with distinct ACLs.
  const { rows: functionRows } = await client.query(
    `SELECT g.grantee, n.nspname AS schema_name,
            p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS func_identity,
            p.prosecdef AS security_definer
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       CROSS JOIN unnest($1::text[] || ARRAY['public']) AS g(grantee)
      WHERE ${AUDITABLE_SCHEMAS}
        AND has_function_privilege(g.grantee, p.oid, 'EXECUTE')`,
    [AUDITED_ROLES],
  );

  // 7. DATABASE privileges. CREATE here means "create schemas"; TEMP allows temp
  //    tables. CONNECT is expected; the other two are not.
  const { rows: databaseRows } = await client.query(
    `SELECT g.grantee, d.datname AS database_name, p.priv AS privilege_type
       FROM pg_database d
       CROSS JOIN unnest(ARRAY['CONNECT', 'CREATE', 'TEMP']::text[]) AS p(priv)
       CROSS JOIN unnest($1::text[] || ARRAY['public']) AS g(grantee)
      WHERE d.datname = current_database()
        AND has_database_privilege(g.grantee, d.oid, p.priv)`,
    [AUDITED_ROLES],
  );

  // 8. DEFAULT privileges (pg_default_acl). These apply to objects created
  //    LATER, so they silently pre-authorise access to tables that do not exist
  //    yet — invisible to every "what can this role touch now" query above.
  const { rows: defaultAclRows } = await client.query(
    `SELECT COALESCE(n.nspname, '-') AS schema_name,
            d.defaclobjtype AS obj_type,
            pg_get_userbyid(d.defaclrole) AS owner,
            unnest(d.defaclacl)::text AS acl
       FROM pg_default_acl d
       LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace`,
  );

  // 9. ROLE ATTRIBUTES. bootstrap-rds-roles converges these at bootstrap, but a
  //    migration runs as SUPERUSER and can re-grant them at any time
  //    (`ALTER ROLE … CREATEDB`). Asserting them on every deploy is what makes
  //    the bootstrap-time convergence durable.
  const { rows: attrRows } = await client.query(
    `SELECT rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole,
            rolreplication, rolcanlogin
       FROM pg_roles WHERE rolname = ANY($1)`,
    [AUDITED_ROLES],
  );

  // 10. Session defaults set on a role or a database (pg_db_role_setting). They
  //     apply to every connection, invisibly to the connection's own options: a
  //     role-level `client_min_messages = error` would silence the RLS bypass
  //     reports for every pool of that role (#911). Read for the audited roles,
  //     for every role (setrole = 0), and for this database or every database.
  const { rows: settingRows } = await client.query(
    `SELECT COALESCE(r.rolname, '*') AS role, COALESCE(d.datname, '*') AS db, unnest(s.setconfig) AS setting
       FROM pg_db_role_setting s
       LEFT JOIN pg_roles r ON r.oid = s.setrole
       LEFT JOIN pg_database d ON d.oid = s.setdatabase
      WHERE (s.setrole = 0 OR r.rolname = ANY($1))
        AND (s.setdatabase = 0 OR d.datname = current_database())`,
    [AUDITED_ROLES],
  );

  const keys = [
    ...tableRows.map(
      (r) => `TABLE:${r.role}\t${r.schema_name}.${r.table_name}\t${r.privilege_type}`,
    ),
    ...columnRows.map(
      (r) =>
        `COLUMN:${r.role}\t${r.schema_name}.${r.table_name}.${r.column_name}\t${r.privilege_type}`,
    ),
    ...memberRows.map(
      (r) =>
        `MEMBER:${r.role}\t${r.granted_role}\t` +
        `admin=${tf(r.admin_option)},inherit=${tf(r.inherit_option)},set=${tf(r.set_option)}`,
    ),
    ...publicRows.map((r) => `PUBLIC:${r.schema_name}.${r.table_name}\t${r.privilege_type}`),
    ...schemaRows.map((r) => `SCHEMA:${r.grantee}\t${r.schema_name}\t${r.privilege_type}`),
    ...sequenceRows.map(
      (r) => `SEQUENCE:${r.grantee}\t${r.schema_name}.${r.sequence_name}\t${r.privilege_type}`,
    ),
    ...functionRows.map(
      (r) =>
        `FUNCTION:${r.grantee}\t${r.schema_name}.${r.func_identity}\tEXECUTE` +
        // Flag definer routines in the key itself: converting a routine to
        // SECURITY DEFINER changes its blast radius, so it must be reviewed even
        // if the EXECUTE grants are unchanged.
        (r.security_definer ? "\tSECURITY_DEFINER" : ""),
    ),
    ...databaseRows.map((r) => `DATABASE:${r.grantee}\t${r.database_name}\t${r.privilege_type}`),
    ...defaultAclRows.map((r) => `DEFAULTACL:${r.owner}\t${r.schema_name}\t${r.obj_type}\t${r.acl}`),
    ...attrRows.flatMap((r) =>
      Object.entries(r)
        .filter(([k]) => k !== "rolname")
        .map(([attr, value]) => `ROLEATTR:${r.rolname}\t${attr}\t${value}`),
    ),
    ...settingRows.map((r) => `ROLESETTING:${r.role}\t${r.db}\t${r.setting}`),
  ];
  return [...new Set(keys)].sort();
}

/**
 * Every key in `keys` that a denied entry forbids.
 *
 * Table-level AND column-level, because PostgreSQL lets the two disagree:
 *
 *   GRANT UPDATE (metadata) ON audit_logs TO passwd_app;
 *   has_table_privilege (…, 'UPDATE')                 -> false
 *   has_column_privilege(…, 'metadata', 'UPDATE')     -> true
 *
 * Verified against the live database. An exact-key comparison against the
 * `TABLE:` form alone therefore passes a role that can rewrite the one column an
 * attacker cares about — `audit_logs.metadata` is where the claim, the reason and
 * the identifier hash live. The manifest already carries `COLUMN:` keys for this
 * exact reason (13 legitimate ones today), so the shape was available and simply
 * not matched on.
 *
 * Two entry kinds beyond that plain table-level shape:
 *
 *   - `columnGrants` names the columns an entry SANCTIONS for one privilege.
 *     Those `COLUMN:` keys are expected; every other column of that privilege
 *     is still a finding, so the declaration narrows the denial rather than
 *     suspending it. The opposite direction — a sanctioned column grant that
 *     has gone MISSING — is `missingDeclaredColumnGrants` below, not this
 *     function.
 *   - a `sequence` entry matches `SEQUENCE:` keys. Sequences carry their own
 *     ACL, so nothing about a table entry constrains them.
 */
/**
 * Session defaults no role or database may carry, whatever their value: the
 * application's own context GUCs (`app.*`, so a role default cannot turn the
 * RLS bypass on for every connection), and the settings that silence or
 * redirect the RLS bypass reports or disable RLS. Refused live AND in the
 * manifest, and `--write` refuses to record one, as for a denied privilege.
 */
const DENIED_SETTING_RE = /^ROLESETTING:[^\t]+\t[^\t]+\t(?:app\.[^=]*|client_min_messages|log_min_messages|row_security)=/i;

function deniedSettings(keys) {
  return keys.filter((k) => DENIED_SETTING_RE.test(k));
}

function violatesDenied(keys, denied) {
  const out = [];
  for (const d of denied) {
    const subject = subjectOf(d);
    for (const priv of d.privileges) {
      if (isSequenceEntry(d)) {
        // A sequence is a separate object with its own ACL, so a table entry
        // says nothing about it. `bootstrap-rds-roles.mjs` grants
        // `USAGE, SELECT ON ALL SEQUENCES`, which is as table-blind as its
        // `ON ALL TABLES` sibling and re-granted what a migration had revoked
        // for exactly the same reason.
        const sequence = `SEQUENCE:${d.role}\t${subject}\t${priv}`;
        for (const k of keys) if (k === sequence) out.push(k);
        continue;
      }
      // Columns the entry SANCTIONS for this privilege. They are the point of
      // the declaration, not an exemption from it: the privilege is denied at
      // table level precisely so that it is held on these columns and no
      // others, which is why a COLUMN key outside the set is still a finding.
      const sanctioned = new Set(d.columnGrants?.[priv] ?? []);
      const table = `TABLE:${d.role}\t${subject}\t${priv}`;
      const columnPrefix = `COLUMN:${d.role}\t${subject}.`;
      const columnSuffix = `\t${priv}`;
      for (const k of keys) {
        if (k === table) out.push(k);
        else if (k.startsWith(columnPrefix) && k.endsWith(columnSuffix)) {
          const column = k.slice(columnPrefix.length, k.length - columnSuffix.length);
          if (!sanctioned.has(column)) out.push(k);
        }
      }
    }
  }
  return [...new Set(out)];
}

/**
 * Declared column grants the database does NOT hold.
 *
 * The complement of `violatesDenied`, and it exists because the two directions
 * are caught by different things. Surplus is over-privilege and is a finding
 * everywhere. A `columnGrants` entry that has gone missing is the opposite —
 * the writer it exists for cannot write, and since that writer is fail-closed
 * the symptom is denied sign-ins. In COMPARE mode the manifest already reports
 * it as `MISSING_GRANT`. In `--write` mode nothing did: `violatesDenied` only
 * looks for surplus, so a regeneration against a database whose column grants
 * had been erased would have recorded the erasure as the expectation — the same
 * laundering `violatesDenied` blocks in the other direction, and the reason
 * `--write` has a refusal gate at all.
 *
 * A table-level grant of the same privilege makes these keys absent too
 * (`readLiveGrants` emits `COLUMN:` only where the table level does not already
 * imply it). That state is separately a `DENIED_PRIVILEGE_HELD`, so both fire
 * and neither is misleading.
 *
 * `existingSubjects` is required, not optional: the other two consumers of this
 * declaration both treat an ABSENT subject as the pre-migration state and skip
 * it (`assertSubjectKind` returns, `applyDeniedPrivileges` logs and continues).
 * Without the same treatment here, a database where the table does not exist
 * yet would be refused with advice — re-run the bootstrap — that cannot work,
 * because the bootstrap skips the absent table too.
 */
function missingDeclaredColumnGrants(keys, denied, existingSubjects) {
  const held = new Set(keys);
  const out = [];
  for (const d of denied) {
    const subject = subjectOf(d);
    if (!existingSubjects.has(subject)) continue;
    for (const [priv, columns] of Object.entries(d.columnGrants ?? {})) {
      for (const column of columns) {
        const key = `COLUMN:${d.role}\t${subject}.${column}\t${priv}`;
        if (!held.has(key)) out.push(key);
      }
    }
  }
  return out;
}

function tf(value) {
  return value ? "t" : "f";
}

/** Attributes no audited role may ever hold; LOGIN is per role (see below). */
const ELEVATED_ATTRS = ["rolsuper", "rolbypassrls", "rolreplication", "rolcreatedb", "rolcreaterole"];

const MEMBER_FLAGS_RE = /^admin=[tf],inherit=[tf],set=[tf]$/;

/** Object kinds whose PUBLIC counterpart is a `<KIND>:public\t…` key. */
const PUBLIC_GRANTEE_KINDS = ["SCHEMA", "SEQUENCE", "FUNCTION", "DATABASE"];

/**
 * The grantee of one `aclitem` text (`grantee=privs/grantor`, `=privs/grantor`
 * for PUBLIC). A name that needs quoting is double-quoted with `""` escapes.
 */
function aclGrantee(acl) {
  if (acl.startsWith('"')) {
    let name = "";
    for (let i = 1; i < acl.length; i++) {
      if (acl[i] === '"') {
        if (acl[i + 1] === '"') {
          name += '"';
          i++;
          continue;
        }
        return name;
      }
      name += acl[i];
    }
    return null;
  }
  const eq = acl.indexOf("=");
  return eq === -1 ? null : acl.slice(0, eq);
}

/**
 * Keys describing a role state that is never legitimate, so that `--write`
 * cannot record it as expected. The manifest is DESCRIPTIVE: everything else it
 * holds is whatever the database held when it was generated.
 *
 *   - every audited role: an elevated attribute, or any membership;
 *   - any `PUBLIC:` table grant (it reaches every role, jackson_user included);
 *   - a retired role: LOGIN; any membership IN it that can confer it
 *     (inherit or set — an ADMIN-only row is PostgreSQL 16's creator grant and
 *     confers nothing); a default ACL naming it; and any object privilege PUBLIC
 *     does not also hold (PUBLIC's own grants reach every role, retired or not).
 *
 * A MEMBER key that does not parse as exactly three tab-separated fields with
 * the expected flag shape is itself a violation: role names may contain a tab,
 * and an unparsed key must not fall through to "allowed".
 */
export function roleStateViolations(keys, { auditedRoles, retiredRoles }) {
  const audited = new Set(auditedRoles);
  const retired = new Set(retiredRoles);
  const publicHeld = new Set();
  for (const k of keys) {
    if (k.startsWith("PUBLIC:")) publicHeld.add(`TABLE\t${k.slice("PUBLIC:".length)}`);
    for (const kind of PUBLIC_GRANTEE_KINDS) {
      const prefix = `${kind}:public\t`;
      if (k.startsWith(prefix)) publicHeld.add(`${kind}\t${k.slice(prefix.length)}`);
    }
  }

  const out = [];
  for (const k of keys) {
    if (k.startsWith("ROLEATTR:")) {
      const [role, attr, value] = k.slice("ROLEATTR:".length).split("\t");
      if (value !== "true") continue;
      if (audited.has(role) && ELEVATED_ATTRS.includes(attr)) out.push(k);
      else if (retired.has(role) && attr === "rolcanlogin") out.push(k);
      continue;
    }
    if (k.startsWith("MEMBER:")) {
      const fields = k.slice("MEMBER:".length).split("\t");
      if (fields.length !== 3 || !MEMBER_FLAGS_RE.test(fields[2])) {
        out.push(k);
        continue;
      }
      const [member, granted, flags] = fields;
      if (audited.has(member)) out.push(k);
      else if (retired.has(granted) && !flags.endsWith(",inherit=f,set=f")) out.push(k);
      continue;
    }
    if (k.startsWith("PUBLIC:")) {
      out.push(k);
      continue;
    }
    if (k.startsWith("DEFAULTACL:")) {
      const acl = k.split("\t").at(-1);
      if (retired.has(aclGrantee(acl))) out.push(k);
      continue;
    }
    for (const role of retired) {
      if (k.startsWith(`COLUMN:${role}\t`)) {
        // No PUBLIC column counterpart is collected, so none is exempt.
        out.push(k);
        break;
      }
      const kind = ["TABLE", ...PUBLIC_GRANTEE_KINDS].find((c) => k.startsWith(`${c}:${role}\t`));
      if (kind) {
        const rest = k.slice(`${kind}:${role}\t`.length);
        if (!publicHeld.has(`${kind}\t${rest}`)) out.push(k);
        break;
      }
    }
  }
  return [...new Set(out)];
}

/** A retired role the audit does not read would be asserted by nothing. */
export function assertRetiredSubset(auditedRoles, retiredRoles) {
  const missing = retiredRoles.filter((r) => !auditedRoles.includes(r));
  if (missing.length > 0) {
    throw new Error(
      `RETIRED_ROLE_UNAUDITED: ${missing.join(", ")} — add to AUDITED_ROLES in ` +
        "scripts/audit-db-grants.mjs, or the retired state is checked by nothing.",
    );
  }
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
      "Expected EFFECTIVE privileges of the least-privilege DB roles. Object " +
      "names are schema-qualified and every NON-SYSTEM schema is audited, not " +
      "just public (pg_catalog, information_schema and temp/toast schemas are " +
      "excluded). " +
      "Key forms: 'TABLE:<role><TAB><schema>.<table><TAB><priv>', " +
      "'COLUMN:<role><TAB><schema>.<table>.<column><TAB><priv>' (only where not " +
      "implied by the table-level privilege), " +
      "'MEMBER:<role><TAB><granted_role><TAB>admin=<t|f>,inherit=<t|f>,set=<t|f>' " +
      "(role membership — an inheritance path; these roles should have none — and " +
      "every membership in a retired role; an ADMIN-only row into a retired role " +
      "is PostgreSQL 16's creator grant and confers none of its privileges), " +
      "'PUBLIC:<schema>.<table><TAB><priv>' (granted to PUBLIC, therefore " +
      "inherited by every role), 'SCHEMA:<grantee><TAB><schema><TAB><priv>' " +
      "(CREATE lets the role add its own objects), " +
      "'SEQUENCE:<grantee><TAB><schema>.<sequence><TAB><priv>', " +
      "'FUNCTION:<grantee><TAB><schema>.<identity><TAB>EXECUTE' (suffixed " +
      "SECURITY_DEFINER when the routine runs with its owner's privileges — " +
      "PostgreSQL grants EXECUTE to PUBLIC by default, so such a routine is an " +
      "escalation path unless explicitly revoked), " +
      "'DATABASE:<grantee><TAB><database><TAB><priv>', " +
      "'DEFAULTACL:<owner><TAB><schema><TAB><objtype><TAB><acl>' (pre-authorises " +
      "objects that do not exist yet), and " +
      "'ROLEATTR:<role><TAB><attribute><TAB><value>' (SUPERUSER/BYPASSRLS/" +
      "REPLICATION/CREATEDB/CREATEROLE/LOGIN — bootstrap converges these, but a " +
      "migration runs as SUPERUSER and can re-grant them, so they are asserted " +
      "on every deploy), and 'ROLESETTING:<role|*><TAB><db|*><TAB><name>=<value>' " +
      "(a session default set by ALTER ROLE/DATABASE … SET; it applies to every " +
      "connection, e.g. a role-level client_min_messages would silence the RLS " +
      "bypass reports). Computed with has_*_privilege, so privileges reached " +
      "via PUBLIC or via inheritance are included — direct-ACL views such as " +
      "role_table_grants omit both. Generated by " +
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

  // Loaded and validated BEFORE the connection, so a malformed policy stops the
  // run rather than being reported alongside live findings.
  const denied = loadDeniedPolicy();
  assertRetiredSubset(AUDITED_ROLES, RETIRED_ROLES);
  const roleScope = { auditedRoles: AUDITED_ROLES, retiredRoles: RETIRED_ROLES };

  const client = new Client({ connectionString });
  await client.connect();
  let live;
  let subjectKinds;
  try {
    live = await readLiveGrants(client);
    // The kind of each declared subject, so an entry that names a sequence as a
    // table (or the reverse) is a hard error rather than an entry that quietly
    // matches no key. `assertSubjectKind` holds the rule; this only fetches.
    const { rows } = await client.query(
      `SELECT s.subject, (SELECT relkind FROM pg_class WHERE oid = to_regclass(s.subject)) AS relkind
         FROM unnest($1::text[]) AS s(subject)`,
      [[...new Set(denied.map((d) => subjectOf(d)))]],
    );
    subjectKinds = new Map(rows.map((r) => [r.subject, r.relkind]));
  } finally {
    await client.end();
  }

  for (const d of denied) {
    assertSubjectKind(d, subjectKinds.get(subjectOf(d)) ?? null);
  }
  // A subject with no relkind does not exist. Same meaning the bootstrap gives
  // it — the pre-migration state — so the required-column check below skips it
  // rather than demanding a grant on a table nothing has created.
  const existingSubjects = new Set(
    [...subjectKinds.entries()].filter(([, kind]) => kind !== null).map(([subject]) => subject),
  );

  // A policy entry naming a role this audit does not READ is inert: `readLiveGrants`
  // only emits keys for AUDITED_ROLES, so `violatesDenied` would find nothing and
  // the entry would look enforced while enforcing nothing. That is the same
  // silently-ineffective-control shape this whole file exists to close, so it is
  // a hard error rather than a shrug. Surfaced by writing the subprocess test:
  // the first version used a throwaway role and the audit reported no finding.
  const unaudited = [...new Set(denied.map((d) => d.role))].filter(
    (r) => !AUDITED_ROLES.includes(r),
  );
  if (unaudited.length > 0) {
    console.error(
      `DENIED_POLICY_UNAUDITED_ROLE: ${unaudited.join(", ")}\n` +
        `${deniedFile()} forbids privileges for role(s) this audit does not read. ` +
        `Add them to AUDITED_ROLES in ${"scripts/audit-db-grants.mjs"}, or the ` +
        "entry is enforced by the bootstrap alone and invisible here.",
    );
    process.exit(1);
  }

  if (write) {
    // A regeneration against a database where a declared control is not in
    // effect would record the breakage AS the expectation — which is how the
    // audit_logs REVOKE became invisible. Refuse instead.
    const laundered = violatesDenied(live, denied);
    // Both directions, because a regeneration can launder either one. The
    // second is the availability side: a database whose declared column grants
    // have been erased is one where the fail-closed event writer cannot write,
    // and recording that as the expectation makes the outage the baseline.
    const erased = missingDeclaredColumnGrants(live, denied, existingSubjects);
    const settings = deniedSettings(live);
    const roleState = roleStateViolations(live, roleScope);
    if (
      laundered.length > 0 ||
      erased.length > 0 ||
      settings.length > 0 ||
      roleState.length > 0
    ) {
      console.error("REFUSING to regenerate the manifest:\n");
      for (const k of laundered) {
        console.error(`  DENIED_PRIVILEGE_HELD: ${k.replace(/\t/g, " ")}`);
      }
      for (const k of roleState) {
        console.error(`  ROLE_STATE_VIOLATION: ${k.replace(/\t/g, " ")}`);
      }
      for (const k of settings) {
        console.error(`  DENIED_SETTING_HELD: ${k.replace(/\t/g, " ")}`);
      }
      for (const k of erased) {
        console.error(`  DECLARED_COLUMN_GRANT_MISSING: ${k.replace(/\t/g, " ")}`);
      }
      console.error(
        `\nThese privileges are declared in` +
          `\n${deniedFile()}, and the database disagrees. Writing the manifest` +
          `\nnow would record that disagreement as the expected state.` +
          `\nA DENIED_PRIVILEGE_HELD means the database holds something the` +
          `\ndeclaration forbids; repair it (see that file for the sanctioned` +
          `\nmutation paths). A DECLARED_COLUMN_GRANT_MISSING means a column` +
          `\ngrant the declaration REQUIRES is absent — re-run` +
          `\nscripts/bootstrap-rds-roles.mjs, which re-grants them after its` +
          `\nrevokes. A ROLE_STATE_VIOLATION is a role state that is never` +
          `\nlegitimate (an elevated attribute, a membership, a PUBLIC table` +
          `\ngrant, or a retired role able to act); repair it. Then regenerate.\n`,
      );
      process.exit(1);
    }
    writeManifest(live);
    return;
  }

  const expected = new Set(readManifest());
  const liveSet = new Set(live);

  const findings = [];
  // Checked FIRST and against both sides. A denied privilege that is merely
  // absent from the manifest already shows up as UNEXPECTED_GRANT below; what
  // that check cannot see is a denied privilege the manifest SANCTIONS, which
  // is the state this whole file exists to make impossible.
  for (const key of violatesDenied(live, denied)) {
    findings.push(`DENIED_PRIVILEGE_HELD: ${key.replace(/\t/g, " ")}`);
  }
  for (const key of deniedSettings(live)) {
    findings.push(`DENIED_SETTING_HELD: ${key.replace(/\t/g, " ")}`);
  }
  for (const key of deniedSettings([...expected])) {
    findings.push(`DENIED_SETTING_IN_MANIFEST: ${key.replace(/\t/g, " ")}`);
  }
  for (const key of violatesDenied([...expected], denied)) {
    findings.push(`DENIED_PRIVILEGE_IN_MANIFEST: ${key.replace(/\t/g, " ")}`);
  }
  for (const key of roleStateViolations(live, roleScope)) {
    findings.push(`ROLE_STATE_VIOLATION: ${key.replace(/\t/g, " ")}`);
  }
  for (const key of roleStateViolations([...expected], roleScope)) {
    findings.push(`ROLE_STATE_IN_MANIFEST: ${key.replace(/\t/g, " ")}`);
  }
  // The REQUIRED direction, against both sides for the same reason the denied
  // direction is. Live-only would be nearly covered by MISSING_GRANT below —
  // but only while the manifest still lists the keys. A manifest that lost them
  // too (hand-edited, or generated before this declaration existed) makes every
  // other check pass on a database where the fail-closed event writer cannot
  // append at all, which is denied first-ever sign-ins with a green audit.
  for (const key of missingDeclaredColumnGrants(live, denied, existingSubjects)) {
    findings.push(`DECLARED_COLUMN_GRANT_MISSING: ${key.replace(/\t/g, " ")}`);
  }
  for (const key of missingDeclaredColumnGrants([...expected], denied, existingSubjects)) {
    findings.push(`DECLARED_COLUMN_GRANT_MISSING_IN_MANIFEST: ${key.replace(/\t/g, " ")}`);
  }
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
      `\nAn UNEXPECTED_GRANT means a role holds a privilege the manifest` +
        `\ndoes not sanction — revoke it, or if a migration granted it` +
        `\nintentionally, regenerate the manifest with --write and review the diff.` +
        `\nA MISSING_GRANT usually means migrations have not been applied.` +
        `\nA DENIED_PRIVILEGE_HELD means a declared control is NOT in effect on` +
        `\nthis database; re-run scripts/bootstrap-rds-roles.mjs, which now` +
        `\nre-applies these revokes, or issue the REVOKE directly.` +
        `\nA DENIED_PRIVILEGE_IN_MANIFEST means the manifest sanctions something` +
        `\n${deniedFile()} forbids — the manifest was regenerated against a broken` +
        `\ndatabase. Repair the database, then regenerate.` +
        `\nA ROLE_STATE_VIOLATION is a role state that is never legitimate: an` +
        `\nelevated attribute or a membership on an audited role, a PUBLIC table` +
        `\ngrant, or a retired role that can log in, be acted as, or hold anything` +
        `\nbeyond PUBLIC's privileges. _IN_MANIFEST means the manifest records one.\n`,
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

export { readLiveGrants, AUDITED_ROLES, RETIRED_ROLES };
