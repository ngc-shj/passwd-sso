/**
 * Generic retention-GC worker.
 *
 * Loops on a configurable interval; each sweep iterates RETENTION_REGISTRY,
 * batch-deleting expired rows per entry with per-entry error isolation.
 * Single-flight is structural: the loop awaits sweepOnce before sleeping
 * (AbortController signals the sleep; in-flight sweep always completes).
 *
 * Lifecycle parity with dcr-cleanup-worker: pool config, error handler,
 * AbortController, graceful stop. Pool application_name distinguishes this
 * worker in pg_stat_activity from the app and audit-outbox workers.
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { setTimeout as setTimeoutPromise } from "node:timers/promises";
import { getLogger } from "@/lib/logger";
import {
  WORKER_POOL_IDLE_TIMEOUT_MS,
  WORKER_POOL_STATEMENT_TIMEOUT_MS,
} from "@/workers/worker-pool-config";
import { assertIdentifier, renderPredicate } from "./predicate";
import {
  RETENTION_REGISTRY,
  RLS_FREE_EXPIRY_TABLES,
  type RetentionEntry,
} from "./registry";
import { sweepOnce } from "./sweep";

export interface WorkerConfig {
  databaseUrl: string;
  intervalMs: number;
  batchSize: number;
  emitHeartbeatAudit: boolean;
}

/**
 * Validate all registry entries at boot time.
 *
 * Called once inside createWorker before the loop starts. Throws on:
 *   - Any identifier (table, cutoffColumn, keyColumns, predicate column) that
 *     fails the ^[a-z_]+$ allowlist (INV-C2a, INV-C1c).
 *   - Any EXPIRY entry that is missing globalDelete AND whose table is NOT
 *     "verification_tokens" (INV-C2b / boot-throw of S10).
 *
 * RLS-free exception set (RLS_FREE_EXPIRY_TABLES in registry.ts — currently
 * just "verification_tokens"): tables with no RLS policy and no tenant_id
 * column. The set is co-located with the registry so it cannot drift. All
 * other EXPIRY tables are
 * RLS-enabled; the worker must set bypass_rls to delete across tenants. Omitting
 * globalDelete on an RLS-enabled table would silently yield 0 rows deleted
 * (the NOBYPASSRLS role triggers "invalid input syntax for type uuid" from the
 * RLS policy's uuid cast). The explicit flag forces the registry author to
 * acknowledge the deliberate all-tenant blast radius (S2).
 *
 * TODO(retention-gc-worker): derive RLS-enabled status from pg_policies in the
 * INV-C1a cross-check so the globalDelete requirement is enforced against DB
 * ground truth, not author discipline. (S14 tracked follow-up — see plan.)
 */
export function validateRegistry(
  registry: readonly RetentionEntry[] = RETENTION_REGISTRY,
): void {
  for (const entry of registry) {
    if (entry.kind === "EXPIRY") {
      assertIdentifier(entry.table);
      assertIdentifier(entry.cutoffColumn);
      for (const col of entry.keyColumns) {
        assertIdentifier(col);
      }
      if (entry.predicate && entry.predicate.length > 0) {
        // renderPredicate validates every column via assertIdentifier internally.
        renderPredicate(entry.predicate);
      }
      // Enforce that every RLS-enabled EXPIRY table declares globalDelete.
      if (!entry.globalDelete && !RLS_FREE_EXPIRY_TABLES.has(entry.table)) {
        throw new Error(
          `retention-gc: EXPIRY entry for table "${entry.table}" is missing globalDelete:true. ` +
            `All RLS-enabled tables require globalDelete to acknowledge the all-tenant blast ` +
            `radius. Only "${[...RLS_FREE_EXPIRY_TABLES].join('", "')}" may omit it (RLS-free tables).`,
        );
      }
    } else if (entry.kind === "EXPIRY_GUARDED") {
      assertIdentifier(entry.table);
      assertIdentifier(entry.cutoffColumn);
      for (const col of entry.keyColumns) {
        assertIdentifier(col);
      }
      // `guard` is a closed GuardName enum (compile-time checked) → no runtime
      // SQL validation needed. Same globalDelete enforcement as EXPIRY.
      if (!entry.globalDelete && !RLS_FREE_EXPIRY_TABLES.has(entry.table)) {
        throw new Error(
          `retention-gc: EXPIRY_GUARDED entry for table "${entry.table}" is missing globalDelete:true. ` +
            `All RLS-enabled tables require globalDelete to acknowledge the all-tenant blast radius.`,
        );
      }
    } else if (entry.kind === "EXPIRY_AUDIT_PROVENANCE") {
      assertIdentifier(entry.table);
      assertIdentifier(entry.cutoffColumn);
      // provenanceColumns are interpolated into the SELECT projection — validate
      // every one (defense-in-depth before any SQL is built; S1/S3).
      for (const col of entry.provenanceColumns) {
        assertIdentifier(col);
      }
      // tenant_id is required for the per-row audit emit.
      if (!entry.provenanceColumns.includes("tenant_id")) {
        throw new Error(
          `retention-gc: EXPIRY_AUDIT_PROVENANCE entry for table "${entry.table}" must include "tenant_id" in provenanceColumns (the audit is emitted under the row's own tenant).`,
        );
      }
      if (!entry.globalDelete && !RLS_FREE_EXPIRY_TABLES.has(entry.table)) {
        throw new Error(
          `retention-gc: EXPIRY_AUDIT_PROVENANCE entry for table "${entry.table}" is missing globalDelete:true. ` +
            `All RLS-enabled tables require globalDelete to acknowledge the all-tenant blast radius.`,
        );
      }
    } else if (entry.kind === "PER_TENANT_TRASH") {
      // `table` is the only free identifier; scopeKind and tenantRetentionColumn
      // are literal-union types. The sweeper sets bypass_rls explicitly (like
      // sweepAuditLogs), so there is no globalDelete flag to enforce.
      assertIdentifier(entry.table);
    }
    // PER_TENANT_FN entries have no free identifiers to validate — the table,
    // fn, and tenantRetentionColumn fields are literal union types.
  }
}

export function createWorker(config: WorkerConfig) {
  const { databaseUrl, intervalMs, batchSize, emitHeartbeatAudit } = config;

  // Validate the registry before touching any DB connection.
  // Throws immediately on misconfigured identifier or missing globalDelete flag (INV-C2b).
  validateRegistry();

  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 3,
    idleTimeoutMillis: WORKER_POOL_IDLE_TIMEOUT_MS,
    statement_timeout: WORKER_POOL_STATEMENT_TIMEOUT_MS,
    application_name: "passwd-sso-retention-gc-worker",
  });

  pool.on("error", (err) => {
    getLogger().error(
      { code: (err as NodeJS.ErrnoException | undefined)?.code },
      "retention-gc.pool.error",
    );
  });

  const adapter = new PrismaPg(pool);
  const workerPrisma = new PrismaClient({ adapter });

  const controller = new AbortController();
  const { signal } = controller;

  async function loop(): Promise<void> {
    const log = getLogger();
    log.info({ intervalMs, batchSize }, "retention-gc.loop_start");

    while (!signal.aborted) {
      try {
        const counts = await sweepOnce(workerPrisma, batchSize, {
          intervalMs,
          emitHeartbeatAudit,
        });
        log.info({ counts }, "retention-gc.sweep_done");
      } catch (err) {
        // Pin error log shape to {code} only — do NOT spread err — to avoid
        // leaking pg connection target/username via err.message (S6/S7).
        const code =
          (err as NodeJS.ErrnoException | undefined)?.code ?? "unknown";
        log.error({ code }, "retention-gc.sweep_failed");
        // Do not exit; transient DB errors should not crash the worker.
      }

      if (signal.aborted) break;

      try {
        await setTimeoutPromise(intervalMs, undefined, { signal });
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === "ABORT_ERR") break;
        throw err;
      }
    }

    log.info({}, "retention-gc.loop_stopped");
  }

  let loopPromise: Promise<void> | null = null;

  function start(): Promise<void> {
    loopPromise = loop();
    return loopPromise;
  }

  async function stop(): Promise<void> {
    controller.abort();
    if (loopPromise) {
      await loopPromise;
    }
    await workerPrisma.$disconnect();
    await pool.end();
  }

  return { start, stop };
}
