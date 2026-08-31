/**
 * Health check logic for liveness and readiness probes.
 *
 * - checkDatabase: SELECT 1 via Prisma with timeout
 * - checkRedis: PING via redis client with timeout
 * - runHealthChecks: orchestrates all checks, returns aggregate status
 *
 * Error details are logged (not returned in responses) to prevent
 * internal information leakage.
 *
 * HEALTH_REDIS_REQUIRED=true makes Redis failure return "fail" (503)
 * instead of the default "warn" (200 degraded).
 */

import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getRedis } from "@/lib/redis";
import { getLogger } from "@/lib/logger";
import { AUDIT_OUTBOX } from "@/lib/constants/audit/audit";
import { MS_PER_SECOND } from "@/lib/constants/time";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { pgErrorCode } from "@/lib/prisma/prisma-error";
import { errorLogFields } from "@/lib/logger/error-fields";

export type CheckStatus = "pass" | "fail" | "warn";

export interface CheckResult {
  status: CheckStatus;
  responseTimeMs: number;
}

export interface HealthResponse {
  status: "healthy" | "degraded" | "unhealthy";
  timestamp: string;
  checks: {
    database: CheckResult;
    redis: CheckResult;
    auditOutbox: CheckResult;
  };
}

/**
 * The budget for one check, and the outer bound every check must respect.
 *
 * Exported so the tests can assert the outbox transaction's `maxWait + timeout`
 * against the real value instead of re-typing 3000 — a re-typed bound lets the
 * expectation and the production constant drift apart while agreeing with each
 * other, which is the same reason BYPASS_PURPOSE is imported rather than
 * literal in both health suites.
 */
export const CHECK_TIMEOUT_MS = 3 * MS_PER_SECOND;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), ms),
    ),
  ]);
}

async function checkDatabase(): Promise<CheckResult> {
  const start = performance.now();
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, CHECK_TIMEOUT_MS);
    return {
      status: "pass",
      responseTimeMs: Math.round(performance.now() - start),
    };
  } catch (err) {
    const responseTimeMs = Math.round(performance.now() - start);
    getLogger().warn({ error: errorLogFields(err), responseTimeMs }, "health.database.fail");
    return { status: "fail", responseTimeMs };
  }
}

const redisRequired = process.env.HEALTH_REDIS_REQUIRED === "true";

async function checkRedis(): Promise<CheckResult> {
  const redis = getRedis();
  if (!redis) {
    if (redisRequired) {
      getLogger().warn("health.redis.fail.not_configured");
      return { status: "fail", responseTimeMs: 0 };
    }
    return { status: "pass", responseTimeMs: 0 };
  }
  const start = performance.now();
  try {
    await withTimeout(redis.ping(), CHECK_TIMEOUT_MS);
    return {
      status: "pass",
      responseTimeMs: Math.round(performance.now() - start),
    };
  } catch (err) {
    const responseTimeMs = Math.round(performance.now() - start);
    const failStatus: CheckStatus = redisRequired ? "fail" : "warn";
    getLogger().warn({ error: errorLogFields(err), responseTimeMs }, `health.redis.${failStatus}`);
    return { status: failStatus, responseTimeMs };
  }
}

// undefined_table. The one outbox-query failure that is a deployment ordering
// artifact rather than a fault, and the only one this check degrades to "warn".
const PG_UNDEFINED_TABLE = "42P01";

// CHECK_TIMEOUT_MS is the check's HARD outer bound, so Prisma has to enforce it
// too. `withTimeout` only rejects the race; the interactive transaction below
// goes on holding its pooled connection to Prisma's 5 s default, so a database
// slow enough to blow the budget was still occupying a connection two seconds
// after the check had already reported "fail" — during exactly the incident
// where connections are the scarce resource. Handing the budget to
// `$transaction` makes the engine end it and release the connection.
//
// Prisma bounds the two phases separately (maxWait to START the transaction,
// timeout to RUN it), so the outer bound is their SUM. Only
// `maxWait + timeout <= CHECK_TIMEOUT_MS` is load-bearing; the split below
// gives the larger share to execution because the statement is one indexed
// aggregate and the queue is the cheaper phase to give up on.
const OUTBOX_DEPTH_MAX_WAIT_MS = Math.floor(CHECK_TIMEOUT_MS / 3);
const OUTBOX_DEPTH_TIMEOUT_MS = CHECK_TIMEOUT_MS - OUTBOX_DEPTH_MAX_WAIT_MS;

/**
 * Backlog depth across the whole outbox — an operator signal, deliberately not
 * scoped to one tenant, so it needs a bypass context. Read on the top-level
 * client it would carry no RLS context at all: `app.tenant_id` is unset on a
 * fresh pooled connection, so the tenant_isolation policy evaluates to NULL and
 * the count comes back 0 (a check that can only pass), and on a connection that
 * already ran a transaction the GUC is back to '' and the ::uuid cast raises
 * 22P02 (a check that can only warn). Neither can report a real backlog.
 *
 * EXPORTED AS A SEAM, for the same reason `readOutboxDepth` is in
 * audit-outbox-worker.ts: the property above is connection-scoped runtime
 * state, and both health suites mock `@/lib/tenant-rls` wholesale, so they pass
 * identically against the bypassed and the un-bypassed form. The only test that
 * can tell the two apart drives this against a real pooled connection —
 * src/__tests__/db-integration/health-outbox-depth.integration.test.ts. The
 * client parameter exists for that test; production always takes the default.
 */
export async function readAuditOutboxDepth(
  client: PrismaClient = prisma,
): Promise<{ pending: number; oldestAgeSecs: number }> {
  const rows = await withBypassRls(
    client,
    (tx) =>
      tx.$queryRaw<{ pending: bigint; oldest_age: number | null }[]>`
        SELECT
          COUNT(*) AS pending,
          EXTRACT(EPOCH FROM (now() - MIN(created_at)))::float AS oldest_age
        FROM audit_outbox
        WHERE status = 'PENDING'
      `,
    BYPASS_PURPOSE.SYSTEM_MAINTENANCE,
    { timeout: OUTBOX_DEPTH_TIMEOUT_MS, maxWait: OUTBOX_DEPTH_MAX_WAIT_MS },
  );
  return {
    pending: Number(rows[0]?.pending ?? 0),
    oldestAgeSecs: rows[0]?.oldest_age ?? 0,
  };
}

async function checkAuditOutbox(): Promise<CheckResult> {
  const start = performance.now();
  try {
    const { pending, oldestAgeSecs: oldestAge } = await withTimeout(
      readAuditOutboxDepth(),
      CHECK_TIMEOUT_MS,
    );
    const responseTimeMs = Math.round(performance.now() - start);

    if (
      pending > AUDIT_OUTBOX.READY_PENDING_THRESHOLD ||
      oldestAge > AUDIT_OUTBOX.READY_OLDEST_THRESHOLD
    ) {
      getLogger().warn(
        { pending, oldestAge, responseTimeMs },
        "health.auditOutbox.fail",
      );
      return { status: "fail", responseTimeMs };
    }

    return { status: "pass", responseTimeMs };
  } catch (err) {
    const responseTimeMs = Math.round(performance.now() - start);
    // Graceful degradation for the pre-migration tree only. Degrading EVERY
    // error to "warn" made the check unable to report a fault: a timeout, a
    // dropped connection, or the 22P02 raised by a missing RLS context all came
    // back as the same non-blocking "warn" this branch was written to give a
    // table that does not exist yet.
    if (pgErrorCode(err) === PG_UNDEFINED_TABLE) {
      getLogger().warn({ error: errorLogFields(err), responseTimeMs }, "health.auditOutbox.warn");
      return { status: "warn", responseTimeMs };
    }
    getLogger().warn({ error: errorLogFields(err), responseTimeMs }, "health.auditOutbox.fail");
    return { status: "fail", responseTimeMs };
  }
}

export async function runHealthChecks(): Promise<HealthResponse> {
  const [database, redis, auditOutbox] = await Promise.all([
    checkDatabase(),
    checkRedis(),
    checkAuditOutbox(),
  ]);

  const checks = { database, redis, auditOutbox };
  const all = Object.values(checks);
  const status = all.some((c) => c.status === "fail")
    ? "unhealthy"
    : all.some((c) => c.status === "warn")
      ? "degraded"
      : "healthy";

  return { status, timestamp: new Date().toISOString(), checks };
}

/**
 * Readiness-specific subset of health checks. Excludes auditOutbox per
 * C20 (OWASP A05-1 / S15) — worker backlog is not app liveness, and
 * exposing outbox pending counts to unauthenticated callers leaks
 * internal state. Detailed outbox metrics live behind operator-token
 * auth at /api/maintenance/audit-outbox-metrics.
 */
export async function runReadinessChecks(): Promise<{
  status: "healthy" | "unhealthy";
}> {
  const [database, redis] = await Promise.all([checkDatabase(), checkRedis()]);
  const failed = [database, redis].some((c) => c.status === "fail");
  return { status: failed ? "unhealthy" : "healthy" };
}
