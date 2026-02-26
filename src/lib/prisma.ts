import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { getLogger } from "@/lib/logger";
import { getTenantRlsContext } from "@/lib/tenant-rls";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  pool: pg.Pool | undefined;
};

// ─── envInt: defense-in-depth env var parser ──────────────────

interface EnvIntOpts {
  min?: number;
  max?: number;
}

/**
 * Parse env var as strict integer with range guard.
 * Uses Number() (not parseInt) to reject partial numbers like "20ms" or "10abc".
 * Throws in production, falls back to default in dev/test.
 *
 * Validation roles:
 * - env.ts (Zod): startup-time schema validation (authoritative, runs in instrumentation.ts)
 * - prisma.ts (envInt): defense-in-depth for module load order edge cases
 *   (prisma.ts may load before instrumentation.ts triggers env.ts validation)
 */
export function envInt(
  name: string,
  defaultVal: number,
  opts: EnvIntOpts = {},
): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultVal;
  const parsed = Number(raw);
  const { min = 0, max = Number.MAX_SAFE_INTEGER } = opts;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        `Invalid DB pool config: ${name}="${raw}" (expected integer ${min}\u2013${max})`,
      );
    }
    getLogger().warn(
      { envVar: name, raw, min, max },
      "pool.env.invalid_number.fallback",
    );
    return defaultVal;
  }
  return parsed;
}

// ─── Pool creation ───────────────────────────────────────────

function createPool(): pg.Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL environment variable is not set");
  }

  const pool = new pg.Pool({
    connectionString,
    max: envInt("DB_POOL_MAX", 20, { min: 1, max: 200 }),
    connectionTimeoutMillis: envInt("DB_POOL_CONNECTION_TIMEOUT_MS", 5000, {
      min: 0,
      max: 60_000,
    }),
    idleTimeoutMillis: envInt("DB_POOL_IDLE_TIMEOUT_MS", 30_000, {
      min: 0,
      max: 600_000,
    }),
    maxLifetimeSeconds: envInt("DB_POOL_MAX_LIFETIME_SECONDS", 1800, {
      min: 0,
      max: 86_400,
    }),
    statement_timeout: envInt("DB_POOL_STATEMENT_TIMEOUT_MS", 30_000, {
      min: 0,
      max: 300_000,
    }),
    application_name: "passwd-sso",
  });

  const log = getLogger();
  pool.on("error", (err) => {
    log.error({ err }, "pool.error.idle_client");
  });

  return pool;
}

// ─── Graceful shutdown ───────────────────────────────────────

function registerShutdown(pool: pg.Pool): void {
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    const log = getLogger();
    log.info("pool.shutdown.start");
    try {
      await pool.end();
      log.info("pool.shutdown.complete");
    } catch (err) {
      log.error({ err }, "pool.shutdown.error");
    }
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

// ─── PrismaClient factory ────────────────────────────────────

function createPrismaClient(): { client: PrismaClient; pool: pg.Pool } {
  const pool = createPool();
  registerShutdown(pool);

  const adapter = new PrismaPg(pool);
  const client = new PrismaClient({
    adapter,
    log:
      process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

  return { client, pool };
}

// ─── Singleton ───────────────────────────────────────────────

const result = globalForPrisma.prisma
  ? { client: globalForPrisma.prisma, pool: globalForPrisma.pool! }
  : createPrismaClient();

const baseClient = result.client;
export const prismaBase = baseClient;

export const prisma = new Proxy(baseClient, {
  get(target, prop, receiver) {
    const ctx = getTenantRlsContext();
    const active = ctx?.tx;

    if (active && prop in active) {
      const value = Reflect.get(active, prop, active);
      return typeof value === "function" ? value.bind(active) : value;
    }

    const value = Reflect.get(target, prop, receiver);
    return typeof value === "function" ? value.bind(target) : value;
  },
}) as PrismaClient;

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = result.client;
  globalForPrisma.pool = result.pool;
}
