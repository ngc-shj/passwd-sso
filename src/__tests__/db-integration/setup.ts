/**
 * Setup file for real-DB integration tests.
 * Loads .env (canonical) then .env.local (per-developer override) — matches
 * the project convention documented in CLAUDE.md and src/lib/load-env.ts.
 * Does NOT set up mocks — integration tests run against a real database.
 */
import { config } from "dotenv";
config({ path: ".env" });
config({ path: ".env.local", override: true });

// For integration tests, superuser must be the default DATABASE_URL
// so that createTestContext() can create tenants and manage test data.
if (!process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.MIGRATION_DATABASE_URL;
}

/**
 * Refuse to run against a database a background worker is also draining.
 *
 * These tests drive worker functions (processWebhookDeliveryBatch, the outbox
 * drain, the reapers) directly against real rows. Those claims are
 * `FOR UPDATE SKIP LOCKED` over the whole table, not scoped to a tenant, and
 * the retention sweep deletes delivery rows outright — so a live worker on the
 * same database competes for the very rows a test just inserted. It wins some
 * of the time, and the test then observes a partial result and fails on an
 * assertion that has nothing to do with the code under test.
 *
 * `npm run docker:up` starts audit-outbox-worker against the dev database,
 * which is the same one .env points these tests at, so the normal local state
 * is the racing one. CI runs no worker container, so this check is silent there.
 *
 * A ~50% flake that blames an unrelated assertion is worse than a refusal: it
 * teaches people to re-run until green. Fail fast and name the fix instead.
 */
/**
 * Each worker's pool application_name, mapped to how you actually stop it.
 * Naming only the outbox worker would leave someone who tripped the check on
 * the retention GC following an instruction that does not apply to them.
 */
const WORKERS: ReadonlyArray<{
  applicationName: string;
  stop: string;
  /** Undefined when there is nothing to restart with a command. */
  restart?: string;
}> = [
  {
    applicationName: "passwd-sso-outbox-worker",
    stop: "docker compose stop audit-outbox-worker",
    restart: "docker compose start audit-outbox-worker",
  },
  {
    applicationName: "passwd-sso-retention-gc-worker",
    stop: "docker compose stop retention-gc-worker",
    restart: "docker compose start retention-gc-worker",
  },
  {
    // No compose service — run directly, so there is no container to stop and
    // no `docker compose start` to hand back.
    applicationName: "passwd-sso-audit-anchor-publisher",
    stop: "stop the audit-anchor-publisher process you started",
  },
];

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL (or MIGRATION_DATABASE_URL) must be set to run integration tests.",
  );
}

const { Client } = await import("pg");
const probe = new Client({ connectionString: databaseUrl });
try {
  await probe.connect();
  const { rows } = await probe.query<{ application_name: string; count: string }>(
    `SELECT application_name, count(*) AS count
       FROM pg_stat_activity
      WHERE datname = current_database()
        AND application_name = ANY($1::text[])
      GROUP BY application_name`,
    [WORKERS.map((w) => w.applicationName)],
  );
  if (rows.length > 0) {
    const detected = rows.map((r) => ({
      row: r,
      worker: WORKERS.find((w) => w.applicationName === r.application_name),
    }));
    const restarts = detected
      .map((d) => d.worker?.restart)
      .filter((cmd): cmd is string => Boolean(cmd));
    throw new Error(
      [
        `Refusing to run integration tests: a background worker is connected to the same database.`,
        ``,
        ...detected.map(
          ({ row, worker }) =>
            `  ${row.application_name} (${row.count} connection(s)) — ${worker?.stop ?? "stop that worker"}`,
        ),
        ``,
        `These tests claim and mutate the same outbox / delivery rows the worker drains,`,
        `so results would be non-deterministic. Stop the worker(s) above, then re-run.`,
        // Only offered for workers that actually have a restart command, so
        // nobody is told to `docker compose start` something with no service.
        ...(restarts.length > 0 ? [``, `Restart afterwards with:`, ...restarts.map((c) => `  ${c}`)] : []),
      ].join("\n"),
    );
  }
} finally {
  await probe.end().catch(() => {});
}
