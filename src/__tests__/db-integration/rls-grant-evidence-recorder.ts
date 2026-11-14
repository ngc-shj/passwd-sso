/**
 * Producer side of the per-grant evidence record (C11). When
 * RLS_GRANT_EVIDENCE_FILE is set, the suite appends one JSON line per
 * (purpose, tables, role) the bypass was set with, and one per role it knows
 * the attributes of; scripts/checks/check-rls-grant-evidence.ts reads the file
 * after the suite has passed. Test harness only: nothing under src/ outside
 * __tests__ may import this.
 *
 * A grant line names the role the statement ran as, never the connection
 * string, a password or a tenant id.
 */
import { appendFileSync } from "node:fs";

export type RoleAttributes = { name: string; rolsuper: boolean; rolbypassrls: boolean };

// The text setBypassGucs (src/lib/tenant-rls-grants.ts) sends; its bound values
// are [purpose, tenantId, tables], in that order.
const SET_BYPASS_GUCS_RE =
  /^SELECT set_config\('app\.bypass_rls', 'on', true\),\s*set_config\('app\.bypass_purpose', \$1, true\),\s*set_config\('app\.tenant_id', \$2, true\),\s*set_config\('app\.bypass_tables', \$3, true\)$/;

// PostgreSQL applies startup options in order, so the last `role=` wins.
const ROLE_OPTION_RE = /(?:^|\s)(?:-c\s*|--)role=(\S+)/g;

// A statement that can change the role a connection runs as. Over-matching (a
// string literal that happens to contain the words) only drops evidence.
const ROLE_SWITCH_RE =
  /(?:^|;)\s*(?:SET\s+(?:(?:LOCAL|SESSION)\s+)?(?:ROLE|SESSION\s+AUTHORIZATION)\b|RESET\s+(?:ROLE|SESSION\s+AUTHORIZATION)\b)|set_config\s*\(\s*'(?:role|session_authorization)'/i;

// Named so that no pg_roles row can match: the consumer counts it as a role
// with no attribute line, i.e. no evidence.
const SWITCHED_ROLE = "<role switched after connect>";

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
    append({ kind: "role", name: row.name, rolsuper: row.rolsuper, rolbypassrls: row.rolbypassrls });
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

/** The role a connection's statements run as: its `-c role=` startup option, else its login user. */
export function effectiveRole(params: { user?: string; options?: string }): string {
  const set = params.options ? [...params.options.matchAll(ROLE_OPTION_RE)].at(-1)?.[1] : undefined;
  return set ?? params.user ?? "";
}

function statementText(args: readonly unknown[]): string | null {
  const first = args[0];
  const text = typeof first === "string" ? first : (first as { text?: unknown } | null)?.text;
  return typeof text === "string" ? text : null;
}

// Connections that ran a role-switching statement: their startup role no longer
// says who later statements ran as.
const switchedConnections = new WeakSet<object>();

const recorded = new Set<string>();

/** Called from setup.ts's `Client.prototype.query` wrapper; issues no query of its own. */
export function recordGrantEvidence(
  client: { connectionParameters?: { user?: string; options?: string } },
  args: readonly unknown[],
): void {
  const connection = client.connectionParameters;
  if (!evidenceFile() || !connection) return;
  const text = statementText(args);
  if (text !== null && ROLE_SWITCH_RE.test(text)) switchedConnections.add(client);
  const grant = parseSetBypassGucs(args);
  if (!grant) return;
  const role = switchedConnections.has(client) ? SWITCHED_ROLE : effectiveRole(connection);
  // One line per distinct triple per test file; the consumer reads sets.
  const key = `${grant.purpose}\0${grant.tables}\0${role}`;
  if (recorded.has(key)) return;
  recorded.add(key);
  append({ kind: "grant", purpose: grant.purpose, tables: grant.tables, role });
}
