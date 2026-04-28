import { PrismaClient } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { setTimeout as setTimeoutPromise } from "node:timers/promises";
import { getLogger } from "@/lib/logger";
import {
  AUDIT_SCOPE,
  AUDIT_ACTION,
  ACTOR_TYPE,
  AUDIT_METADATA_KEY,
} from "@/lib/constants/audit/audit";
import { SYSTEM_ACTOR_ID, SYSTEM_TENANT_ID } from "@/lib/constants/app";
import type { AuditOutboxPayload } from "@/lib/audit/audit-outbox";

export interface WorkerConfig {
  databaseUrl: string;
  intervalMs: number;
  batchSize: number;
  emitHeartbeatAudit: boolean;
}

type EmitFn = (
  tx: Prisma.TransactionClient,
  tenantId: string,
  payload: AuditOutboxPayload,
) => Promise<void>;

interface SweepOpts {
  intervalMs: number;
  emitHeartbeatAudit: boolean;
  /**
   * Optional override for the audit-emit step.
   * Used only in integration tests to simulate mid-tx failures (tx-rollback test).
   * Production callers omit this; sweepOnce defaults to enqueueAuditInWorkerTx.
   */
  _emitFn?: EmitFn;
}

/**
 * Inline audit enqueue — mirrors enqueueAuditInTx from @/lib/audit/audit-outbox
 * but inlined here to avoid the transitive import of @/lib/prisma (the app
 * singleton) which would throw at module load time when DATABASE_URL is unset.
 * The behaviour is identical: verifies bypass_rls GUC, checks tenant existence,
 * then writes to audit_outbox within the caller's transaction.
 *
 * Exported so integration tests can stub this via vi.mock to verify tx atomicity.
 */
export async function enqueueAuditInWorkerTx(
  tx: Prisma.TransactionClient,
  tenantId: string,
  payload: AuditOutboxPayload,
): Promise<void> {
  const [ctx] = await tx.$queryRaw<{ bypass_rls: string; tenant_id: string }[]>`
    SELECT current_setting('app.bypass_rls', true) AS bypass_rls,
           current_setting('app.tenant_id', true)  AS tenant_id`;
  if (ctx.bypass_rls !== "on" && ctx.tenant_id !== tenantId) {
    throw new Error(
      `enqueueAuditInWorkerTx: called outside bypass_rls scope; ` +
      `bypass_rls=${ctx.bypass_rls}, tenant_id=${ctx.tenant_id}, expected=${tenantId}`,
    );
  }
  const [tenantExists] = await tx.$queryRaw<{ ok: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM tenants WHERE id = ${tenantId}::uuid) AS ok`;
  if (!tenantExists?.ok) {
    throw new Error(
      `enqueueAuditInWorkerTx: tenantId ${tenantId} does not exist`,
    );
  }
  await tx.auditOutbox.create({
    data: {
      tenantId,
      payload: payload as unknown as Prisma.InputJsonValue,
    },
  });
}

/**
 * Delete expired unclaimed DCR registrations in a single atomic transaction.
 * Also emits an audit row to audit_outbox within the same tx (atomicity R9).
 *
 * Exported so integration tests can call it in-process without start().
 * Single-flight is structural: the loop awaits sweepOnce before sleeping,
 * so no concurrency primitive is needed.
 */
export async function sweepOnce(
  workerPrisma: PrismaClient,
  batchSize: number,
  opts: SweepOpts,
): Promise<number> {
  return workerPrisma.$transaction(async (tx) => {
    // Set bypass_rls GUC to reach tenant_id IS NULL rows under existing RLS policy.
    // Mirror the pattern used in audit-outbox-worker.ts (raw set_config, not @/lib/tenant-rls).
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;

    // Delete expired unclaimed DCR registrations up to batchSize at a time.
    // USING subquery with LIMIT to cap the DELETE without a direct LIMIT on DELETE.
    const purged = await tx.$executeRawUnsafe<number>(
      `DELETE FROM mcp_clients
       USING (
         SELECT id FROM mcp_clients
         WHERE is_dcr = true AND tenant_id IS NULL AND dcr_expires_at < now()
         LIMIT $1
       ) sub
       WHERE mcp_clients.id = sub.id`,
      batchSize,
    );

    if (purged > 0 || opts.emitHeartbeatAudit) {
      const emitFn = opts._emitFn ?? enqueueAuditInWorkerTx;
      await emitFn(tx, SYSTEM_TENANT_ID, {
        scope: AUDIT_SCOPE.TENANT,
        action: AUDIT_ACTION.MCP_CLIENT_DCR_CLEANUP,
        userId: SYSTEM_ACTOR_ID,
        actorType: ACTOR_TYPE.SYSTEM,
        serviceAccountId: null,
        teamId: null,
        targetType: null,
        targetId: null,
        metadata: {
          [AUDIT_METADATA_KEY.PURGED_COUNT]: purged,
          triggeredBy: "dcr-cleanup-worker",
          sweepIntervalMs: opts.intervalMs,
        },
        ip: null,
        userAgent: "dcr-cleanup-worker",
      });
    }

    return purged;
  });
}

export function createWorker(config: WorkerConfig) {
  const { databaseUrl, intervalMs, batchSize, emitHeartbeatAudit } = config;

  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 3,
    idleTimeoutMillis: 30_000,
    statement_timeout: 60_000,
    application_name: "passwd-sso-dcr-cleanup-worker",
  });

  pool.on("error", (err) => {
    getLogger().error(
      { code: (err as NodeJS.ErrnoException | undefined)?.code },
      "dcr-cleanup.pool.error",
    );
  });

  const adapter = new PrismaPg(pool);
  const workerPrisma = new PrismaClient({ adapter });

  const controller = new AbortController();
  const { signal } = controller;

  async function loop(): Promise<void> {
    const log = getLogger();
    log.info({ intervalMs, batchSize }, "dcr-cleanup.loop_start");

    while (!signal.aborted) {
      try {
        const purged = await sweepOnce(workerPrisma, batchSize, {
          intervalMs,
          emitHeartbeatAudit,
        });
        log.info({ purged }, "dcr-cleanup.sweep_done");
      } catch (err) {
        // Pin error log shape to {code} only — do NOT spread err — to avoid
        // leaking pg connection target/username via err.message.
        const code = (err as NodeJS.ErrnoException | undefined)?.code ?? "unknown";
        log.error({ code }, "dcr-cleanup.sweep_failed");
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

    log.info({}, "dcr-cleanup.loop_stopped");
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
