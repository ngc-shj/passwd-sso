import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { getLogger } from "@/lib/logger";
import { deadLetterLogger } from "@/lib/audit-logger";
import { computeBackoffMs, withFullJitter } from "@/lib/backoff";
import { AUDIT_OUTBOX, AUDIT_SCOPE, ACTOR_TYPE, OUTBOX_BYPASS_AUDIT_ACTIONS } from "@/lib/constants/audit";
import { BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { NIL_UUID } from "@/lib/constants/app";

// Raw shape returned from the claim query
interface AuditOutboxRow {
  id: string;
  tenant_id: string;
  payload: unknown;
  status: string;
  attempt_count: number;
  max_attempts: number;
  created_at: Date;
  next_retry_at: Date;
  processing_started_at: Date | null;
  sent_at: Date | null;
  last_error: string | null;
}

interface AuditOutboxPayload {
  scope: string;
  action: string;
  userId: string | null;
  actorType: string;
  serviceAccountId: string | null;
  teamId: string | null;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  userAgent: string | null;
}

interface WorkerConfig {
  databaseUrl: string;
  batchSize?: number;
  pollIntervalMs?: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts PrismaClient or TransactionClient
async function setBypassRlsGucs(client: any): Promise<void> {
  await client.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
  await client.$executeRaw`SELECT set_config('app.bypass_purpose', ${BYPASS_PURPOSE.AUDIT_WRITE}, true)`;
  await client.$executeRaw`SELECT set_config('app.tenant_id', ${NIL_UUID}, true)`;
}

function parsePayload(raw: unknown): AuditOutboxPayload {
  if (raw === null || typeof raw !== "object") {
    throw new Error("outbox payload is not an object");
  }
  const p = raw as Record<string, unknown>;
  return {
    scope: typeof p.scope === "string" ? p.scope : AUDIT_SCOPE.PERSONAL,
    action: typeof p.action === "string" ? p.action : "",
    userId: typeof p.userId === "string" ? p.userId : null,
    actorType: typeof p.actorType === "string" ? p.actorType : ACTOR_TYPE.HUMAN,
    serviceAccountId:
      typeof p.serviceAccountId === "string" ? p.serviceAccountId : null,
    teamId: typeof p.teamId === "string" ? p.teamId : null,
    targetType: typeof p.targetType === "string" ? p.targetType : null,
    targetId: typeof p.targetId === "string" ? p.targetId : null,
    metadata:
      p.metadata !== null && typeof p.metadata === "object"
        ? (p.metadata as Record<string, unknown>)
        : null,
    ip: typeof p.ip === "string" ? p.ip : null,
    userAgent: typeof p.userAgent === "string" ? p.userAgent : null,
  };
}

async function claimBatch(
  prisma: PrismaClient,
  batchSize: number,
): Promise<AuditOutboxRow[]> {
  return prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    const rows = await tx.$queryRawUnsafe<AuditOutboxRow[]>(`
      UPDATE audit_outbox
      SET status = 'PROCESSING',
          processing_started_at = now()
      WHERE id IN (
        SELECT id FROM audit_outbox
        WHERE status = 'PENDING'
          AND next_retry_at <= now()
        ORDER BY created_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      )
      AND status = 'PENDING'
      RETURNING *
    `, batchSize);
    return rows;
  });
}

async function deliverRow(
  prisma: PrismaClient,
  row: AuditOutboxRow,
  payload: AuditOutboxPayload,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);

    const metadataJson =
      payload.metadata !== null ? JSON.stringify(payload.metadata) : null;
    const createdAtIso = row.created_at.toISOString();

    await tx.$executeRawUnsafe(
      `INSERT INTO audit_logs (
        id, tenant_id, scope, action, user_id, actor_type,
        service_account_id, team_id, target_type, target_id,
        metadata, ip, user_agent, created_at, outbox_id
      ) VALUES (
        gen_random_uuid(),
        $1::uuid,
        $2::"AuditScope",
        $3::"AuditAction",
        $4::uuid,
        $5::"ActorType",
        $6::uuid,
        $7::uuid,
        $8,
        $9,
        $10::jsonb,
        $11,
        $12,
        $13::timestamptz,
        $14::uuid
      )
      ON CONFLICT (outbox_id) DO NOTHING`,
      row.tenant_id,
      payload.scope,
      payload.action,
      payload.userId,
      payload.actorType,
      payload.serviceAccountId,
      payload.teamId,
      payload.targetType,
      payload.targetId,
      metadataJson,
      payload.ip,
      payload.userAgent,
      createdAtIso,
      row.id,
    );

    await tx.$executeRawUnsafe(
      `UPDATE audit_outbox
       SET status = 'SENT',
           sent_at = now(),
           processing_started_at = NULL
       WHERE id = $1`,
      row.id,
    );
  });
}

async function recordError(
  prisma: PrismaClient,
  row: AuditOutboxRow,
  err: unknown,
): Promise<void> {
  const errorMsg = err instanceof Error ? err.message : String(err);
  const newAttemptCount = row.attempt_count + 1;
  const isDead = newAttemptCount >= row.max_attempts;
  const backoffMs = withFullJitter(computeBackoffMs(newAttemptCount));
  const backoffSeconds = backoffMs / 1000;

  try {
    await prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);

      if (isDead) {
        await tx.$executeRawUnsafe(
          `UPDATE audit_outbox
           SET status = 'FAILED',
               attempt_count = $1,
               last_error = LEFT($2, 1024),
               processing_started_at = NULL
           WHERE id = $3`,
          newAttemptCount,
          errorMsg,
          row.id,
        );
      } else {
        await tx.$executeRawUnsafe(
          `UPDATE audit_outbox
           SET status = 'PENDING',
               attempt_count = $1,
               next_retry_at = now() + make_interval(secs => $2),
               last_error = LEFT($3, 1024),
               processing_started_at = NULL
           WHERE id = $4`,
          newAttemptCount,
          backoffSeconds,
          errorMsg,
          row.id,
        );
      }
    });
  } catch (recoveryErr) {
    getLogger().error(
      { outboxId: row.id, err: recoveryErr },
      "worker.error_recovery_tx_failed",
    );
  }
}

async function dispatchWebhookForRow(
  payload: AuditOutboxPayload,
  tenantId: string,
): Promise<void> {
  if (OUTBOX_BYPASS_AUDIT_ACTIONS.has(payload.action)) {
    return;
  }
  try {
    const { dispatchWebhook, dispatchTenantWebhook } = await import(
      "@/lib/webhook-dispatcher"
    );
    const timestamp = new Date().toISOString();
    const webhookData = (payload.metadata ?? {}) as Record<string, unknown>;
    if (payload.scope === AUDIT_SCOPE.TEAM && payload.teamId) {
      void dispatchWebhook({
        type: payload.action,
        teamId: payload.teamId,
        timestamp,
        data: webhookData,
      });
    } else if (payload.scope === AUDIT_SCOPE.TENANT) {
      void dispatchTenantWebhook({
        type: payload.action,
        tenantId,
        timestamp,
        data: webhookData,
      });
    }
  } catch (err) {
    getLogger().warn(
      { err, tenantId, action: payload.action },
      "worker.webhook_dispatch_import_failed",
    );
  }
}

export function createWorker(config: WorkerConfig) {
  const { databaseUrl } = config;
  const batchSize = config.batchSize ?? AUDIT_OUTBOX.BATCH_SIZE;
  const pollIntervalMs = config.pollIntervalMs ?? AUDIT_OUTBOX.POLL_INTERVAL_MS;

  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 5,
    idleTimeoutMillis: 30_000,
    statement_timeout: 60_000,
    application_name: "passwd-sso-outbox-worker",
  });

  pool.on("error", (err) => {
    getLogger().error({ err }, "worker.pool.error");
  });

  const adapter = new PrismaPg(pool);
  const workerPrisma = new PrismaClient({ adapter });

  let running = false;
  let shutdownResolve: (() => void) | null = null;
  const shutdownPromise = new Promise<void>((resolve) => {
    shutdownResolve = resolve;
  });

  async function processBatch(): Promise<number> {
    const log = getLogger();
    let rows: AuditOutboxRow[];

    try {
      rows = await claimBatch(workerPrisma, batchSize);
    } catch (err) {
      log.error({ err }, "worker.claim_batch_failed");
      return 0;
    }

    if (rows.length === 0) {
      return 0;
    }

    log.info({ count: rows.length }, "worker.batch_claimed");

    for (const row of rows) {
      let payload: AuditOutboxPayload;

      try {
        payload = parsePayload(row.payload);
      } catch (err) {
        log.error({ err, outboxId: row.id }, "worker.payload_parse_failed");
        await recordError(workerPrisma, row, err);
        continue;
      }

      if (payload.userId === null && payload.actorType !== ACTOR_TYPE.SYSTEM) {
        log.warn(
          { outboxId: row.id, action: payload.action, actorType: payload.actorType },
          "worker.null_userid_non_system_skipped",
        );
        deadLetterLogger.warn(
          { outboxId: row.id, tenantId: row.tenant_id, action: payload.action },
          "null userId for non-SYSTEM actor — skipping",
        );
        await recordError(
          workerPrisma,
          row,
          new Error("null userId for non-SYSTEM actor type"),
        );
        continue;
      }

      if (payload.userId === null) {
        log.warn(
          { outboxId: row.id, action: payload.action },
          "worker.system_actor_null_userid_skipped",
        );
        await recordError(
          workerPrisma,
          row,
          new Error("SYSTEM actor with null userId not supported in Phase 1"),
        );
        continue;
      }

      try {
        await deliverRow(workerPrisma, row, payload);
        log.info(
          { outboxId: row.id, action: payload.action, tenantId: row.tenant_id },
          "worker.delivered",
        );
        void dispatchWebhookForRow(payload, row.tenant_id);
      } catch (err) {
        log.warn(
          { err, outboxId: row.id, action: payload.action },
          "worker.deliver_failed",
        );
        const isDead = row.attempt_count + 1 >= row.max_attempts;
        if (isDead) {
          deadLetterLogger.warn(
            {
              outboxId: row.id,
              tenantId: row.tenant_id,
              action: payload.action,
              attemptCount: row.attempt_count + 1,
              err,
            },
            "outbox row dead-lettered",
          );
        }
        await recordError(workerPrisma, row, err);
      }
    }

    return rows.length;
  }

  let sleepResolve: (() => void) | null = null;

  async function loop(): Promise<void> {
    const log = getLogger();
    log.info({ batchSize, pollIntervalMs }, "worker.loop_start");

    while (running) {
      const claimed = await processBatch();

      if (!running) break;

      if (claimed === 0) {
        await new Promise<void>((resolve) => {
          sleepResolve = resolve;
          setTimeout(() => { sleepResolve = null; resolve(); }, pollIntervalMs);
        });
      }
    }

    log.info("worker.loop_stop");
    shutdownResolve?.();
  }

  function registerShutdown(): void {
    const stop = (signal: string) => {
      if (!running) return;
      running = false;
      process.stderr.write(`[audit-outbox-worker] ${signal} received, shutting down...\n`);
      getLogger().info({ signal }, "worker.shutdown_signal");
      sleepResolve?.();
    };
    process.once("SIGTERM", () => stop("SIGTERM"));
    process.once("SIGINT", () => stop("SIGINT"));
  }

  return {
    async start(): Promise<void> {
      running = true;
      registerShutdown();

      try {
        await workerPrisma.$executeRawUnsafe("SELECT 1");
      } catch {
        // Connection check — if this fails the loop will handle it
      }

      await loop();
      await shutdownPromise;

      try {
        await workerPrisma.$disconnect();
        await pool.end();
      } catch (err) {
        getLogger().warn({ err }, "worker.shutdown_cleanup_error");
      }

      getLogger().info("worker.shutdown_complete");
      process.stderr.write("[audit-outbox-worker] shutdown complete\n");
    },

    stop(): void {
      running = false;
    },
  };
}
