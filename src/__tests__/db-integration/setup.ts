/**
 * Setup file for real-DB integration tests.
 * Loads .env.local then .env without overriding what is already exported
 * (src/lib/load-env.ts): scripts/run-integration-tests.mjs exports the scratch
 * database's URLs, and a DATABASE_URL in .env.local must not replace them.
 * Does NOT set up mocks — integration tests run against a real database.
 */
import { loadEnv } from "@/lib/load-env";
loadEnv();

// A fallback only, for a runner that exported nothing but MIGRATION_DATABASE_URL.
// The harness's superuser comes from MIGRATION_DATABASE_URL itself
// (helpers.ts getConnectionString("superuser")); DATABASE_URL is the
// application's connection, passwd_app both locally and in CI.
if (!process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.MIGRATION_DATABASE_URL;
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL (or MIGRATION_DATABASE_URL) must be set to run integration tests.",
  );
}

const { Client } = await import("pg");
const { scratchDatabaseRefusal } = await import("../../../scripts/lib/integration-scratch-db.mjs");
const probe = new Client({ connectionString: databaseUrl });
try {
  await probe.connect();
  // Only a database scripts/run-integration-tests.mjs created for this run:
  // the suite writes and deletes rows and drives worker claims over whole
  // tables, so a shared database (the dev one, which a live instance and the
  // compose workers use) both suffers that and feeds the suite leftovers, and
  // its workers race the suite for the same rows. No worker connects to a
  // database created for one run unless pointed at it by name, which is why
  // the former worker-detection refusal is gone. The role-URL check below
  // holds every other connection to this same database.
  const { rows: self } = await probe.query<{ name: string; comment: string | null }>(
    `SELECT d.datname AS name, shobj_description(d.oid, 'pg_database') AS comment
       FROM pg_database d
      WHERE d.datname = current_database()`,
  );
  const refusal = scratchDatabaseRefusal(self[0]?.name, self[0]?.comment ?? null);
  if (refusal) {
    throw new Error(
      [
        `Refusing to run integration tests: ${refusal}.`,
        ``,
        `Run them with \`npm run test:integration\` (scripts/run-integration-tests.mjs), which creates an empty`,
        `scratch database on the cluster MIGRATION_DATABASE_URL names, migrates it, runs this suite on it and`,
        `drops it. Pass vitest arguments after \`--\`, e.g. \`npm run test:integration -- vault\`.`,
      ].join("\n"),
    );
  }
  // The same for Redis: the suite drives rate-limit buckets and session-cache
  // entries the live instance on the dev Redis reads, so only the logical
  // database the runner claimed for this run (scripts/run-integration-tests.mjs),
  // recognised by the marker the runner exports in REDIS_CLAIM_ENV: another
  // run's claimed database is its keyspace, not this one's.
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    const { default: IORedis } = await import("ioredis");
    const { REDIS_CLAIM_ENV, REDIS_CLAIM_KEY, scratchRedisRefusal } = await import(
      "../../../scripts/lib/integration-scratch-db.mjs"
    );
    const redis = new IORedis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
    let claim: string | null = null;
    try {
      await redis.connect();
      claim = await redis.get(REDIS_CLAIM_KEY);
    } finally {
      redis.disconnect();
    }
    const redisRefusal = scratchRedisRefusal(claim, {
      sentinel: process.env.REDIS_SENTINEL === "true",
      expected: process.env[REDIS_CLAIM_ENV],
    });
    if (redisRefusal) {
      throw new Error(
        [
          `Refusing to run integration tests: ${redisRefusal}.`,
          ``,
          `Run them with \`npm run test:integration\`, which claims an empty Redis logical database for the run`,
          `on the server REDIS_URL names and points REDIS_URL at it (or unset REDIS_URL to skip the Redis cells).`,
        ].join("\n"),
      );
    }
  }
  // The RLS policies call these for every reading role; without EXECUTE every
  // statement on an RLS table fails with "permission denied for function"
  // (a role created after the migration misses its grant).
  // Checked for every role the suite connects as (the app role, and the
  // worker roles where they exist), not only this connection's.
  const { rows: exec } = await probe.query<{ role: string }>(
    `SELECT r.rolname AS role
       FROM pg_roles r
      WHERE (r.rolname = current_user OR r.rolname IN ('passwd_app', 'passwd_outbox_worker', 'passwd_retention_gc_worker', 'passwd_anchor_publisher', 'passwd_audit_chain_verifier'))
        AND NOT (has_function_privilege(r.rolname, 'public.rls_bypass_admits(text)', 'EXECUTE')
             AND has_function_privilege(r.rolname, 'public.rls_bypass_enforced()', 'EXECUTE'))`,
  );
  if (exec.length > 0) {
    throw new Error(
      `role(s) lacking EXECUTE on public.rls_bypass_admits / rls_bypass_enforced: ${exec.map((r) => r.role).join(", ")}`,
    );
  }
  // The suite is the enforce pass (#921): a bypass that reaches a table outside
  // its grant must be refused, so a database still in report mode would turn
  // every refusal cell into a vacuous or failing one.
  const { rows: mode } = await probe.query<{ enforced: boolean }>(
    `SELECT public.rls_bypass_enforced() AS enforced`,
  );
  if (mode[0]?.enforced !== true) {
    throw new Error(
      `Refusing to run integration tests: public.rls_bypass_enforced() is not true on this database ` +
        `(report mode). Apply the pending migrations with \`npx prisma migrate deploy\`, then re-run.`,
    );
  }
  // Seeding goes through the superuser and assertions through the role clients;
  // a role URL naming another database would run them against different data.
  const { allRoleConnectionStrings } = await import("./helpers");
  const { roleUrlMismatches } = await import("./role-url-consistency");
  const { superuser, ...roleUrls } = allRoleConnectionStrings();
  if (process.env.RLS_GRANT_EVIDENCE_FILE) {
    // The attributes of every role the harness connects as, for the evidence
    // consumer to tell a restricted connection from an exempt one.
    const { HARNESS_ROLES } = await import("../../../scripts/checks/check-rls-grant-evidence");
    const { ROLE_ATTRIBUTES_SQL, connectionUser, recordRoleAttributes } = await import("./rls-grant-evidence-recorder");
    const names = new Set<string>([
      ...HARNESS_ROLES,
      ...Object.values({ superuser, ...roleUrls }).map(connectionUser),
      new URL(databaseUrl).username,
    ]);
    const { rows: attrs } = await probe.query(ROLE_ATTRIBUTES_SQL, [[...names]]);
    recordRoleAttributes(attrs);
  }
  // DATABASE_URL itself too: `@/lib/prisma` and the enforcing-mode probe use it,
  // and with APP_DATABASE_URL set no role URL is derived from it.
  const mismatched = roleUrlMismatches(superuser, { DATABASE_URL: databaseUrl, ...roleUrls });
  if (mismatched.length > 0) {
    throw new Error(
      [
        `Refusing to run integration tests: a role's connection string names a different host, port or database than the superuser one:`,
        ...mismatched.map((m) => `  ${m}`),
        `Point DATABASE_URL, APP_DATABASE_URL, OUTBOX_WORKER_DATABASE_URL, RETENTION_GC_DATABASE_URL, AUDIT_ANCHOR_PUBLISHER_DATABASE_URL and AUDIT_CHAIN_VERIFY_DATABASE_URL at the same database, or unset them.`,
      ].join("\n"),
    );
  }
} finally {
  await probe.end().catch(() => {});
}

// Every RLS bypass report goes to this suite's buffers, never to the logger;
// a test that caused one fails unless it took it (see bypass-notice-sink.ts).
const { registerBypassNoticeSink } = await import("@/lib/db/pool-factory");
const { failOnReports, recordBypassNotice } = await import("./bypass-notice-sink");
registerBypassNoticeSink(recordBypassNotice);

const { afterEach, afterAll } = await import("vitest");

// Runtime backstop for check-tx-concurrent-queries (issue #975): a query issued
// on a pg client that is still executing one is two statements at once on one
// interactive transaction, whatever spelling produced it. Fail the test that
// caused it, so what the static gate cannot see still fails this suite.
//
// pg's own deprecation warning is not enough: pg@8 warns only when its queue is
// already non-empty, so two queries at once (one active, one queued) pass
// silently — it takes a third. Client.query is wrapped instead, and refuses to
// run against a pg whose internals it can no longer read. It sees statements
// that actually overlap on the connection: Prisma itself serialises some
// operation pairs inside an interactive transaction (measured: two `count()`s,
// or `$executeRaw` + `count()`) and not others (`count()` + `findUnique()`), so
// this backs the static gate up rather than replacing it.
//
// One source is exempt: Prisma's own query interpreter loads the children of a
// relation join (`include` of two or more relations) with Promise.all on the
// transaction's connection. That is inside one Prisma operation, out of this
// codebase's reach, and recognised by the exact interpreter frame that loads
// `childRecords` (prisma-join-children.ts); if Prisma rewrites it, the
// exemption stops matching and these tests fail loudly rather than go blind.
const CONCURRENT_QUERY = "client is already executing a query";
const concurrentQueryReports: string[] = [];
type PgClientInternals = {
  connectionParameters?: { user?: string; options?: string };
  _activeQuery?: unknown;
  _queryQueue?: unknown[];
  pipeline?: boolean;
  query: (...args: unknown[]) => unknown;
};
const clientProto = Client.prototype as unknown as PgClientInternals;
const shape = new Client({ connectionString: databaseUrl }) as unknown as PgClientInternals;
if (!("_activeQuery" in shape) || !Array.isArray(shape._queryQueue)) {
  throw new Error(
    "pg Client no longer exposes _activeQuery/_queryQueue; update the concurrent-query backstop in setup.ts",
  );
}
const { readFileSync } = await import("node:fs");
const { fileURLToPath } = await import("node:url");
const { fromPrismaJoinChildren } = await import("./prisma-join-children");
const { recordGrantEvidence } = await import("./rls-grant-evidence-recorder");
const sourceLines = new Map<string, string[]>();
function readSourceLine(location: string, line: number): string | null {
  const path = location.startsWith("file://") ? fileURLToPath(location) : location;
  let lines = sourceLines.get(path);
  if (!lines) {
    try {
      lines = readFileSync(path, "utf8").split("\n");
    } catch {
      return null;
    }
    sourceLines.set(path, lines);
  }
  return lines[line - 1] ?? null;
}
const originalQuery = clientProto.query;
clientProto.query = function (this: PgClientInternals, ...args: unknown[]) {
  if (!this.pipeline && (this._activeQuery != null || (this._queryQueue?.length ?? 0) > 0)) {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 50;
    const stack = new Error(CONCURRENT_QUERY).stack ?? CONCURRENT_QUERY;
    Error.stackTraceLimit = limit;
    if (!fromPrismaJoinChildren(stack, readSourceLine)) concurrentQueryReports.push(stack);
  }
  recordGrantEvidence(this.connectionParameters, args);
  return originalQuery.apply(this, args);
};
// Positive control: two queries at once on one client must produce exactly one
// report, or the wrapper above is not on the path pg actually takes.
{
  const control = new Client({ connectionString: databaseUrl });
  await control.connect();
  try {
    await Promise.all([control.query("SELECT pg_sleep(0.05)"), control.query("SELECT 1")]);
  } finally {
    await control.end().catch(() => {});
  }
  const recorded = concurrentQueryReports.splice(0).length;
  if (recorded !== 1) {
    throw new Error(
      `concurrent-query backstop is blind: a deliberate two-at-once pair recorded ${recorded} report(s), expected 1`,
    );
  }
}
function failOnConcurrentQueries(when: string): void {
  const warnings = concurrentQueryReports.splice(0);
  if (warnings.length > 0) {
    throw new Error(
      `pg ran two queries at once on one client ${when} — sequence them (await each in turn):\n` +
        warnings.join("\n"),
    );
  }
}

afterEach(() => {
  failOnReports("in this test");
  failOnConcurrentQueries("in this test");
});
// Detached work can report after its test ended.
afterAll(() => {
  failOnReports("after this file's last test");
  failOnConcurrentQueries("after this file's last test");
});
