/**
 * Producer side of the per-grant evidence record (C11). When
 * RLS_GRANT_EVIDENCE_FILE is set, the suite appends one JSON line per
 * (purpose, tables, role) the bypass was set with, and one per role it knows
 * the attributes of; scripts/checks/check-rls-grant-evidence.ts reads the file
 * after the suite has passed. Test harness only: nothing under src/ outside
 * __tests__ may import this.
 *
 * A grant line names the role the statement ran as, never the connection
 * string, a password or a tenant id. That role is the connection's LOGIN user,
 * and only when the connection's startup options set neither `role` nor
 * `session_authorization`; whether the login user can later become another role
 * is a fact about the role (`canSetRole` on its attribute line), which the
 * consumer reads, not something this file infers from statement text.
 */
import { appendFileSync } from "node:fs";

export type RoleAttributes = { name: string; rolsuper: boolean; rolbypassrls: boolean; canSetRole: boolean };

/**
 * The one query behind every attribute line; `$1` is a text[] of role names.
 * `canSetRole`: a session logged in as the role could come to run as another
 * role. True for a superuser, for a membership with SET TRUE, for a membership
 * with ADMIN TRUE (its holder can grant itself SET), and for CREATEROLE (its
 * holder gets ADMIN on the roles it creates). Memberships are followed to
 * every role reachable through them, whatever their INHERIT option: ADMIN held
 * by a role this one inherits can be used by it. The attributes are
 * read once, when the line is written; a change made later in the run is not
 * seen.
 */
export const ROLE_ATTRIBUTES_SQL = `SELECT r.rolname AS name, r.rolsuper, r.rolbypassrls,
  (r.rolsuper OR r.rolcreaterole OR EXISTS (
    WITH RECURSIVE reach(roleid, set_option, admin_option) AS (
      SELECT m.roleid, m.set_option, m.admin_option FROM pg_auth_members m WHERE m.member = r.oid
      UNION
      SELECT m.roleid, m.set_option, m.admin_option FROM pg_auth_members m JOIN reach x ON m.member = x.roleid)
    SELECT 1 FROM reach WHERE set_option OR admin_option)) AS "canSetRole"
  FROM pg_roles r WHERE r.rolname = ANY($1::text[])`;

// The text setBypassGucs (src/lib/tenant-rls-grants.ts) sends; its bound values
// are [purpose, tenantId, tables], in that order.
const SET_BYPASS_GUCS_RE =
  /^SELECT set_config\('app\.bypass_rls', 'on', true\),\s*set_config\('app\.bypass_purpose', \$1, true\),\s*set_config\('app\.tenant_id', \$2, true\),\s*set_config\('app\.bypass_tables', \$3, true\)$/;

// A startup option that sets the session's role or authorization (`-c role=x`,
// `-crole=x`, `--role=x`; names are case-insensitive). The value does not
// matter: any such option means the login user is not who statements run as.
// This is a best-effort match (a backslash-escaped name is not read); a miss
// files the connection under its login user, and a login user that counts as
// restricted cannot make such an option take effect: the server refuses it.
const ROLE_OPTION_RE = /(?:^|\s)(?:-c\s*|--)(?:role|session_authorization)\s*=/i;

// Named so that no pg_roles row can match: the consumer counts it as a role
// with no attribute line, i.e. no evidence.
const ROLE_SET_AT_STARTUP = "<role set in startup options>";

function evidenceFile(): string | undefined {
  return process.env.RLS_GRANT_EVIDENCE_FILE || undefined;
}

function append(line: Record<string, unknown>): void {
  const file = evidenceFile();
  if (file) appendFileSync(file, `${JSON.stringify(line)}\n`);
}

/** The user a connection string logs in as, without reading any other part of it. */
export function connectionUser(connectionString: string): string {
  return decodeURIComponent(new URL(connectionString).username);
}

export function recordRoleAttributes(rows: readonly RoleAttributes[]): void {
  for (const row of rows) {
    append({ kind: "role", name: row.name, rolsuper: row.rolsuper, rolbypassrls: row.rolbypassrls, canSetRole: row.canSetRole });
  }
}

/** The purpose and table list a setBypassGucs statement binds, or null for any other query. */
export function parseSetBypassGucs(args: readonly unknown[]): { purpose: string; tables: string } | null {
  const first = args[0];
  const text = typeof first === "string" ? first : (first as { text?: unknown } | null)?.text;
  const values = typeof first === "string" ? args[1] : (first as { values?: unknown } | null)?.values;
  if (typeof text !== "string" || !Array.isArray(values) || values.length !== 3) return null;
  if (!SET_BYPASS_GUCS_RE.test(text.trim())) return null;
  const [purpose, , tables] = values;
  return typeof purpose === "string" && typeof tables === "string" ? { purpose, tables } : null;
}

/** The role recorded for a connection: its login user, unless its startup options set a role. */
export function connectionRole(params: { user?: string; options?: string }): string {
  return ROLE_OPTION_RE.test(params.options ?? "") ? ROLE_SET_AT_STARTUP : (params.user ?? "");
}

const recorded = new Set<string>();

/** Called from setup.ts's `Client.prototype.query` wrapper; issues no query of its own. */
export function recordGrantEvidence(
  connection: { user?: string; options?: string } | undefined,
  args: readonly unknown[],
): void {
  if (!evidenceFile() || !connection) return;
  const grant = parseSetBypassGucs(args);
  if (!grant) return;
  const role = connectionRole(connection);
  // One line per distinct triple per test file; the consumer reads sets.
  const key = `${grant.purpose}\0${grant.tables}\0${role}`;
  if (recorded.has(key)) return;
  recorded.add(key);
  append({ kind: "grant", purpose: grant.purpose, tables: grant.tables, role });
}
