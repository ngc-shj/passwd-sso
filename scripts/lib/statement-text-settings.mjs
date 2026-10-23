// The PostgreSQL settings under which the TEXT of a statement — or its parse
// tree, which carries its literals — is recorded somewhere other than the
// session itself, with the value that turns each off. A role-password statement
// runs after all of these are set, so neither a cleartext password (initdb) nor
// a verifier (the bootstrap, scripts/set-*-password.sh) is recorded.
//
// One list, three spellings: scripts/bootstrap-rds-roles.mjs imports it;
// scripts/lib/set-role-password.sh and infra/postgres/initdb/0{1,2,4}*.sql
// cannot import, so scripts/__tests__/statement-text-settings.test.mjs pins
// their SET lines to it. The member set is derived, not remembered:
// src/__tests__/db-integration/statement-text-settings.integration.test.ts
// fails when the server has a logging setting this file neither lists here nor
// excludes with a reason.
//
// All are session settings on a one-shot connection: a transaction-scoped
// `SET LOCAL` would come too late for log_transaction_sample_rate, which is
// decided when the transaction starts. MIGRATION_DATABASE_URL is a direct or
// session-pooled superuser URL (prisma migrate requires that), so a session SET
// cannot leak onto another client's statements.

/** @type {ReadonlyArray<readonly [name: string, value: string]>} */
export const STATEMENT_TEXT_SETTINGS = Object.freeze([
  ["log_statement", "'none'"],
  ["log_min_error_statement", "'panic'"],
  ["log_min_duration_statement", "-1"],
  ["log_min_duration_sample", "-1"],
  ["log_transaction_sample_rate", "0"],
  ["debug_print_parse", "off"],
  ["debug_print_rewritten", "off"],
  ["debug_print_plan", "off"],
  // A placeholder is accepted when the library is not loaded.
  ["pg_stat_statements.track_utility", "off"],
]);

/** One `SET name = value;` statement per setting, in list order. */
export function statementTextSetStatements() {
  return STATEMENT_TEXT_SETTINGS.map(([name, value]) => `SET ${name} = ${value};`);
}
