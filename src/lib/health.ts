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

export async function runHealthChecks(): Promise<HealthResponse> {
  const [database, redis] = await Promise.all([
    checkDatabase(),
    checkRedis(),
  ]);

  const checks = { database, redis };
  const all = Object.values(checks);
  const status = all.some((c) => c.status === "fail")
    ? "unhealthy"
    : all.some((c) => c.status === "warn")
      ? "degraded"
      : "healthy";

  return { status, timestamp: new Date().toISOString(), checks };
}
