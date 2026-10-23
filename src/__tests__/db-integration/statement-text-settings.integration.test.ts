/**
 * The member set of scripts/lib/statement-text-settings.mjs, derived from the
 * server rather than remembered: every setting PostgreSQL files under "What to
 * Log" or "When to Log" is either on the list (it can put a statement's text or
 * parse tree in the log) or excluded here with the reason it cannot. A setting a
 * new server version adds fails this test until someone classifies it — the
 * list grew twice by review before it was derived (#941).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import { STATEMENT_TEXT_SETTINGS } from "../../../scripts/lib/statement-text-settings.mjs";

/** Settings in those categories that never carry statement text, and why. */
const EXCLUDED: Record<string, string> = {
  application_name: "a label, set by the client",
  debug_pretty_print: "formats the debug_print_* output, which the list turns off",
  log_autovacuum_min_duration: "autovacuum runs, not client statements",
  log_checkpoints: "checkpoint statistics",
  log_connections: "connection metadata, no statement",
  log_disconnections: "session duration, no statement",
  log_duration: "logs the duration alone; with a statement only through log_min_duration_*",
  log_error_verbosity: "how much context an error line carries; the STATEMENT line is log_min_error_statement's",
  log_hostname: "client host name",
  log_line_prefix: "prefix format",
  log_lock_waits: "a lock-wait message; its STATEMENT line is log_min_error_statement's",
  log_min_messages: "message level; statement text is attached only through log_min_error_statement",
  log_parameter_max_length: "bind parameters; no password statement here uses one",
  log_parameter_max_length_on_error: "bind parameters on error; no password statement here uses one",
  log_recovery_conflict_waits: "recovery conflicts on a standby",
  log_replication_commands: "replication protocol commands, not SQL",
  log_startup_progress_interval: "startup progress",
  log_statement_sample_rate: "only acts through log_min_duration_sample, which the list sets to -1",
  log_temp_files: "temp-file sizes; its STATEMENT line is log_min_error_statement's",
  log_timezone: "timestamp zone",
};

const CATEGORIES = ["Reporting and Logging / What to Log", "Reporting and Logging / When to Log"];

function superuserUrl(): string {
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("MIGRATION_DATABASE_URL or DATABASE_URL required");
  return url;
}

describe("statement-text settings against the server's own list", () => {
  let su: Client;
  let serverSettings: string[];

  beforeAll(async () => {
    su = new Client({ connectionString: superuserUrl() });
    await su.connect();
    const { rows } = await su.query<{ name: string }>(
      "SELECT name FROM pg_settings WHERE category = ANY($1) ORDER BY name",
      [CATEGORIES],
    );
    serverSettings = rows.map((r) => r.name);
  });

  afterAll(async () => {
    await su.end();
  });

  it("reads a non-empty set (the categories still exist under these names)", () => {
    expect(serverSettings).toContain("log_statement");
    expect(serverSettings.length).toBeGreaterThan(10);
  });

  it("classifies every logging setting the server has", () => {
    const listed = new Set(STATEMENT_TEXT_SETTINGS.map(([name]) => name));
    const unclassified = serverSettings.filter((n) => !listed.has(n) && !(n in EXCLUDED));
    expect(unclassified, "classify each: add it to statement-text-settings.mjs or EXCLUDED here").toEqual([]);
  });

  it("lists only settings the server knows, and every SET it issues is accepted", async () => {
    for (const [name, value] of STATEMENT_TEXT_SETTINGS) {
      // pg_stat_statements is an extension; its setting is a placeholder
      // unless the library is loaded, and the SET must work either way.
      if (!name.startsWith("pg_stat_statements.")) expect(serverSettings, name).toContain(name);
      await su.query("BEGIN");
      try {
        await su.query(`SET LOCAL ${name} = ${value}`);
      } finally {
        await su.query("ROLLBACK");
      }
    }
  });
});
