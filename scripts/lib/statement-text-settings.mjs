// The PostgreSQL settings under which the TEXT of a statement — or its parse
// tree, which carries its literals — is recorded somewhere other than the
// session itself, with the value that turns each off. A role-password statement
// runs after all of these are set, so neither a cleartext password (initdb) nor
// a verifier (the bootstrap, scripts/set-*-password.sh) is recorded.
//
// One list, three spellings: scripts/bootstrap-rds-roles.mjs imports it;
// scripts/lib/set-role-password.sh and infra/postgres/initdb/0{1,2,4}*.sql
// cannot import, so scripts/__tests__/statement-text-settings.test.mjs pins
// their SET lines to it.
//
// Derived over PostgreSQL's own logging settings:
// src/__tests__/db-integration/statement-text-settings.integration.test.ts fails
// when the server has a setting under "What to Log" / "When to Log" that this
// file neither lists nor excludes with a reason. pg_stat_statements is listed by
// hand. Not covered — residuals, since they are opt-in and some are meant to
// record exactly this: other extensions in shared_preload_libraries (pgaudit's
// ROLE/DDL classes, auto_explain for plannable statements), and
// pg_stat_activity.query, which shows a session's current statement to itself
// and to pg_read_all_stats while it runs.
//
// The bootstrap scopes them to the password statements (SET before, RESET
// after), so its GRANTs and REVOKEs stay logged; log_transaction_sample_rate is
// the exception, set for the session before BEGIN because sampling is decided
// when a transaction starts. The rotation scripts' session runs only the
// password statement. initdb sets them for the whole file: it runs once on an
// empty volume, and its grants are the repository's own files.

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

/** Decided at transaction start, so it is set for the session before BEGIN. */
export const TRANSACTION_START_SETTING = "log_transaction_sample_rate";

/** One `SET name = value;` statement per setting, in list order. */
export function statementTextSetStatements() {
  return STATEMENT_TEXT_SETTINGS.map(([name, value]) => `SET ${name} = ${value};`);
}

/** The SETs that take effect within a transaction (all but TRANSACTION_START_SETTING). */
export function statementScopedSetStatements() {
  return STATEMENT_TEXT_SETTINGS.filter(([name]) => name !== TRANSACTION_START_SETTING)
    .map(([name, value]) => `SET ${name} = ${value};`);
}

/** RESETs undoing statementScopedSetStatements, in reverse order. */
export function statementScopedResetStatements() {
  return STATEMENT_TEXT_SETTINGS.filter(([name]) => name !== TRANSACTION_START_SETTING)
    .map(([name]) => `RESET ${name};`).reverse();
}
