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
const WORKER_APPLICATION_NAMES = [
  "passwd-sso-outbox-worker",
  "passwd-sso-retention-gc-worker",
  "passwd-sso-audit-anchor-publisher",
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
    [WORKER_APPLICATION_NAMES],
  );
  if (rows.length > 0) {
    const detail = rows
      .map((r) => `${r.application_name} (${r.count} connection(s))`)
      .join(", ");
    throw new Error(
      [
        `Refusing to run integration tests: a background worker is connected to the same database.`,
        `  Detected: ${detail}`,
        ``,
        `These tests claim and mutate the same outbox / delivery rows the worker drains,`,
        `so results would be non-deterministic. Stop the worker, then re-run:`,
        ``,
        `  docker compose stop audit-outbox-worker`,
        ``,
        `Restart it afterwards with \`docker compose start audit-outbox-worker\`.`,
      ].join("\n"),
    );
  }
} finally {
  await probe.end().catch(() => {});
}
