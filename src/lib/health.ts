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

import { prisma } from "@/lib/prisma";
import { getRedis } from "@/lib/redis";
import { getLogger } from "@/lib/logger";
import { AUDIT_OUTBOX } from "@/lib/constants/audit/audit";

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

const CHECK_TIMEOUT_MS = 3_000;

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
    getLogger().warn({ err, responseTimeMs }, "health.database.fail");
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
    getLogger().warn({ err, responseTimeMs }, `health.redis.${failStatus}`);
    return { status: failStatus, responseTimeMs };
  }
}

async function checkAuditOutbox(): Promise<CheckResult> {
  const start = performance.now();
  try {
    const rows = await withTimeout(
      prisma.$queryRaw<{ pending: bigint; oldest_age: number | null }[]>`
        SELECT
          COUNT(*) AS pending,
          EXTRACT(EPOCH FROM (now() - MIN(created_at)))::float AS oldest_age
        FROM audit_outbox
        WHERE status = 'PENDING'
      `,
      CHECK_TIMEOUT_MS,
    );
    const pending = Number(rows[0]?.pending ?? 0);
    const oldestAge = rows[0]?.oldest_age ?? 0;
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
    // Graceful degradation: if table doesn't exist yet, warn instead of fail
    getLogger().warn({ err, responseTimeMs }, "health.auditOutbox.warn");
    return { status: "warn", responseTimeMs };
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
