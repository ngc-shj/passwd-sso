import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { getLogger } from "@/lib/logger";
import { deadLetterLogger } from "@/lib/audit-logger";
import { computeBackoffMs, withFullJitter } from "@/lib/backoff";
import {
  AUDIT_OUTBOX,
  AUDIT_SCOPE,
  AUDIT_ACTION,
  ACTOR_TYPE,
  OUTBOX_BYPASS_AUDIT_ACTIONS,
  WEBHOOK_DISPATCH_SUPPRESS,
} from "@/lib/constants/audit";
import { BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { NIL_UUID, SYSTEM_ACTOR_ID, UUID_RE } from "@/lib/constants/app";
import { DELIVERERS, type TargetConfig, type DeliveryPayload } from "@/workers/audit-delivery";
import { decryptServerData, getMasterKeyByVersion } from "@/lib/crypto-server";
import { sanitizeErrorForStorage } from "@/lib/external-http";
import { buildChainInput, computeCanonicalBytes, computeEventHash } from "@/lib/audit-chain";

export interface AuditOutboxRow {
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

export interface AuditOutboxPayload {
  scope: string;
  action: string;
  userId: string;
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
    // Runtime check kept as defense-in-depth (handles malformed rows from older outbox entries).
    // Falls back to empty string so the UUID_RE guard below can reject the row.
    userId: typeof p.userId === "string" ? p.userId : "",
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

export async function checkChainEnabled(
  prisma: PrismaClient,
  tenantId: string,
): Promise<boolean> {
  const result = await prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    const rows = await tx.$queryRawUnsafe<{ audit_chain_enabled: boolean }[]>(
      `SELECT audit_chain_enabled FROM tenants WHERE id = $1::uuid`,
      tenantId,
    );
    return rows[0]?.audit_chain_enabled ?? false;
  });
  return result;
}

export async function deliverRowWithChain(
  prisma: PrismaClient,
  row: AuditOutboxRow,
  payload: AuditOutboxPayload,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);

    // P4-S2 fix: prevent indefinite lock wait
    await tx.$executeRaw`SET LOCAL lock_timeout = '5000ms'`;

    // P4-F4 fix: ensure anchor row exists (idempotent upsert)
    await tx.$executeRawUnsafe(
      `INSERT INTO audit_chain_anchors (tenant_id, chain_seq, prev_hash, updated_at)
       VALUES ($1::uuid, 0, '\\x00'::bytea, now())
       ON CONFLICT (tenant_id) DO NOTHING`,
      row.tenant_id,
    );

    // Lock the anchor row for this tenant
    const anchors = await tx.$queryRawUnsafe<{
      chain_seq: bigint;
      prev_hash: Buffer;
    }[]>(
      `SELECT chain_seq, prev_hash FROM audit_chain_anchors WHERE tenant_id = $1::uuid FOR UPDATE`,
      row.tenant_id,
    );

    const anchor = anchors[0];
    if (!anchor) {
      throw new Error(`Anchor row missing after upsert for tenant ${row.tenant_id}`);
    }

    const newSeq = anchor.chain_seq + BigInt(1);
    const prevHashBuf = Buffer.isBuffer(anchor.prev_hash)
      ? anchor.prev_hash
      : Buffer.from(anchor.prev_hash);

    // Compute event hash
    // IMPORTANT: metadataObj uses ?? {} fallback for null metadata.
    // The verify endpoint uses the same fallback (row.metadata ?? {}).
    // Both paths must use identical fallback for hash consistency.
    const auditLogId = randomUUID();
    const metadataObj = (payload.metadata ?? {}) as Record<string, unknown>;
    const chainInput = buildChainInput({
      id: auditLogId,
      createdAt: row.created_at,
      chainSeq: newSeq,
      prevHash: prevHashBuf,
      payload: metadataObj,
    });
    const canonicalBytes = computeCanonicalBytes(chainInput);
    const eventHash = computeEventHash(prevHashBuf, canonicalBytes);

    // Build metadata JSON
    const metadataJson = payload.metadata !== null ? JSON.stringify(payload.metadata) : null;
    const createdAtIso = row.created_at.toISOString();

    // P4-F1 fix: INSERT with RETURNING to detect conflict
    const inserted = await tx.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO audit_logs (
        id, tenant_id, scope, action, user_id, actor_type,
        service_account_id, team_id, target_type, target_id,
        metadata, ip, user_agent, created_at, outbox_id,
        chain_seq, event_hash, chain_prev_hash
      ) VALUES (
        $1::uuid,
        $2::uuid,
        $3::"AuditScope",
        $4::"AuditAction",
        $5::uuid,
        $6::"ActorType",
        $7::uuid,
        $8::uuid,
        $9,
        $10,
        $11::jsonb,
        $12,
        $13,
        $14::timestamptz,
        $15::uuid,
        $16,
        $17,
        $18
      )
      ON CONFLICT (outbox_id) DO NOTHING
      RETURNING id`,
      auditLogId,
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
      newSeq,
      eventHash,
      prevHashBuf,
    );

    // Only advance anchor if INSERT succeeded (not a conflict/reprocessing)
    if (inserted.length > 0) {
      await tx.$executeRawUnsafe(
        `UPDATE audit_chain_anchors
         SET chain_seq = $1, prev_hash = $2, updated_at = now()
         WHERE tenant_id = $3::uuid`,
        newSeq,
        eventHash,
        row.tenant_id,
      );
    }

    // Unconditionally mark outbox row as SENT
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

/**
 * Create audit_deliveries rows for each active delivery target.
 * Called after a row is successfully delivered to audit_logs (DB target).
 */
async function fanOutDeliveries(
  prisma: PrismaClient,
  outboxId: string,
  tenantId: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    const targets = await tx.auditDeliveryTarget.findMany({
      where: { tenantId, isActive: true, kind: { not: "DB" } },
    });

    getLogger().info({ outboxId, tenantId, targetCount: targets.length }, "worker.fanout_targets");
    if (targets.length === 0) return;

    await tx.auditDelivery.createMany({
      data: targets.map((t) => ({
        outboxId,
        targetId: t.id,
        tenantId,
        status: "PENDING" as const,
      })),
      skipDuplicates: true,
    });
  });
}

/**
 * Write a SYSTEM-actor audit event directly to audit_logs, bypassing the outbox.
 * Used by reaper and dead-letter logging to avoid recursion.
 */
async function writeDirectAuditLog(
  prisma: PrismaClient,
  tenantId: string,
  action: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO audit_logs (
          id, tenant_id, scope, action, user_id, actor_type, metadata, created_at
        ) VALUES (
          gen_random_uuid(),
          $1::uuid,
          $2::"AuditScope",
          $3::"AuditAction",
          $4::uuid,
          $5::"ActorType",
          $6::jsonb,
          now()
        )`,
        tenantId,
        AUDIT_SCOPE.TENANT,
        action,
        SYSTEM_ACTOR_ID,
        ACTOR_TYPE.SYSTEM,
        JSON.stringify(metadata),
      );
    });
  } catch (err) {
    getLogger().warn(
      { err, tenantId, action },
      "worker.direct_audit_log_write_failed",
    );
  }
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

  // Emit AUDIT_OUTBOX_DEAD_LETTER when row is dead-lettered
  if (isDead) {
    await writeDirectAuditLog(prisma, row.tenant_id, AUDIT_ACTION.AUDIT_OUTBOX_DEAD_LETTER, {
      outboxId: row.id,
      action: parsePayloadAction(row.payload),
      attemptCount: newAttemptCount,
      lastError: errorMsg.slice(0, 256),
    });
  }
}

/** Extract action from raw payload without full parsing. */
function parsePayloadAction(raw: unknown): string {
  if (raw !== null && typeof raw === "object") {
    const p = raw as Record<string, unknown>;
    if (typeof p.action === "string") return p.action;
  }
  return "unknown";
}

/**
 * Claim and process a batch of pending delivery rows.
 * Uses the same FOR UPDATE SKIP LOCKED pattern as outbox claim.
 */
async function processDeliveryBatch(prisma: PrismaClient, batchSize: number): Promise<number> {
  // Claim + fetch in a single transaction to avoid an extra roundtrip
  const deliveries = await prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    const claimed = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      `UPDATE "audit_deliveries"
       SET "status" = 'PROCESSING',
           "processing_started_at" = now()
       WHERE "id" IN (
         SELECT "id" FROM "audit_deliveries"
         WHERE "status" = 'PENDING'
           AND "next_retry_at" <= now()
         ORDER BY "created_at" ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       AND "status" = 'PENDING'
       RETURNING "id"`,
      batchSize,
    );
    if (claimed.length === 0) return [];
    return tx.auditDelivery.findMany({
      where: { id: { in: claimed.map((r) => r.id) } },
      include: { target: true },
    });
  });

  if (deliveries.length === 0) return 0;

  const outboxIds = [
    ...new Set(deliveries.map((d) => d.outboxId).filter((id) => UUID_RE.test(id))),
  ];
  if (outboxIds.length === 0) return deliveries.length;
  const outboxRows = await prisma.auditOutbox.findMany({
    where: { id: { in: outboxIds } },
    select: { id: true, createdAt: true, payload: true, tenantId: true },
  });
  const outboxById = new Map(outboxRows.map((o) => [o.id, o]));

  for (const delivery of deliveries) {
    const outbox = outboxById.get(delivery.outboxId);
    if (!outbox) {
      // Outbox row was purged before delivery completed — log and skip
      getLogger().warn({ deliveryId: delivery.id, outboxId: delivery.outboxId }, "delivery.outbox_purged");
      continue;
    }
    await processOneDelivery(prisma, { ...delivery, outbox });
  }

  return deliveries.length;
}

async function processOneDelivery(
  workerPrisma: PrismaClient,
  delivery: {
    id: string;
    tenantId: string;
    attemptCount: number;
    maxAttempts: number;
    target: {
      id: string;
      kind: string;
      tenantId: string;
      configEncrypted: string;
      configIv: string;
      configAuthTag: string;
      masterKeyVersion: number;
      failCount: number;
    };
    outbox: {
      id: string;
      createdAt: Date;
      payload: unknown;
    };
  },
): Promise<void> {
  if (!delivery.target) return;

  const kind = delivery.target.kind;
  const deliverFn = DELIVERERS[kind];
  if (!deliverFn) {
    getLogger().error({ deliveryId: delivery.id, kind }, "no deliverer for target kind");
    // F-P3-2 fix: immediately record error instead of leaving row in PROCESSING
    await recordDeliveryError(workerPrisma, delivery, new Error(`Unknown delivery target kind: ${kind}`));
    return;
  }

  try {
    // Decrypt target config
    const masterKey = getMasterKeyByVersion(delivery.target.masterKeyVersion);
    const aad = Buffer.concat([
      Buffer.from(delivery.target.id.replace(/-/g, ""), "hex"),
      Buffer.from(delivery.target.tenantId.replace(/-/g, ""), "hex"),
    ]);
    const configJson = decryptServerData(
      {
        ciphertext: delivery.target.configEncrypted,
        iv: delivery.target.configIv,
        authTag: delivery.target.configAuthTag,
      },
      masterKey,
      aad,
    );
    const config: TargetConfig = JSON.parse(configJson);

    // Build delivery payload from outbox payload
    const outboxPayload = delivery.outbox.payload as Record<string, unknown>;
    const deliveryPayload: DeliveryPayload = {
      id: delivery.outbox.id,
      tenantId: delivery.tenantId,
      action: (outboxPayload.action as string) ?? "",
      scope: (outboxPayload.scope as string) ?? "",
      userId: (outboxPayload.userId as string) ?? "",
      actorType: (outboxPayload.actorType as string) ?? "",
      metadata: (outboxPayload.metadata as Record<string, unknown>) ?? {},
      createdAt: delivery.outbox.createdAt.toISOString(),
    };

    await deliverFn.deliver(config, deliveryPayload);

    // Mark as SENT
    await workerPrisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.auditDelivery.update({
        where: { id: delivery.id },
        data: { status: "SENT", lastError: null },
      });
      await tx.auditDeliveryTarget.update({
        where: { id: delivery.target.id },
        data: {
          lastDeliveredAt: new Date(),
          ...(delivery.target.failCount > 0 ? { failCount: 0, lastError: null } : {}),
        },
      });
    });

    getLogger().info({ deliveryId: delivery.id, kind }, "delivery succeeded");
  } catch (err) {
    await recordDeliveryError(workerPrisma, delivery, err);
  }
}

async function recordDeliveryError(
  workerPrisma: PrismaClient,
  delivery: {
    id: string;
    tenantId: string;
    attemptCount: number;
    maxAttempts: number;
    target: { id: string; failCount: number };
  },
  err: unknown,
): Promise<void> {
  const message = sanitizeErrorForStorage(
    err instanceof Error ? err.message : String(err),
  );
  const newAttemptCount = delivery.attemptCount + 1;
  const isDead = newAttemptCount >= delivery.maxAttempts;

  if (isDead) {
    await workerPrisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.auditDelivery.update({
        where: { id: delivery.id },
        data: {
          status: "FAILED",
          attemptCount: newAttemptCount,
          lastError: message,
          processingStartedAt: null,
        },
      });
      await tx.auditDeliveryTarget.update({
        where: { id: delivery.target.id },
        data: {
          failCount: delivery.target.failCount + 1,
          lastError: message,
        },
      });
    });

    // Write dead-letter audit event directly (bypass outbox — avoids recursion)
    await writeDirectAuditLog(workerPrisma, delivery.tenantId, AUDIT_ACTION.AUDIT_DELIVERY_DEAD_LETTER, {
      deliveryId: delivery.id,
      targetId: delivery.target.id,
      error: message.slice(0, 256),
    });

    getLogger().warn({ deliveryId: delivery.id }, "delivery dead-lettered");
  } else {
    const backoffMs = computeBackoffMs(newAttemptCount);
    const nextRetry = new Date(Date.now() + withFullJitter(backoffMs));

    await workerPrisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await tx.auditDelivery.update({
        where: { id: delivery.id },
        data: {
          status: "PENDING",
          attemptCount: newAttemptCount,
          nextRetryAt: nextRetry,
          lastError: message,
          processingStartedAt: null,
        },
      });
    });

    getLogger().info(
      { deliveryId: delivery.id, attempt: newAttemptCount, nextRetry: nextRetry.toISOString() },
      "delivery will retry",
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
  if (WEBHOOK_DISPATCH_SUPPRESS.has(payload.action)) {
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

// ─── Reaper ─────────────────────────────────────────────────────

/**
 * Reset stuck PROCESSING rows back to PENDING for retry.
 * Rows stuck longer than PROCESSING_TIMEOUT_MS are assumed abandoned.
 */
async function reapStuckRows(prisma: PrismaClient): Promise<number> {
  const timeoutSeconds = AUDIT_OUTBOX.PROCESSING_TIMEOUT_MS / 1000;

  // Reset stuck PROCESSING rows: those under max_attempts go back to PENDING,
  // those at or over max_attempts transition to FAILED (dead-letter).
  const reaped = await prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    const rows = await tx.$queryRawUnsafe<{
      id: string;
      tenant_id: string;
      attempt_count: number;
      new_status: string;
    }[]>(
      `UPDATE audit_outbox
       SET status = CASE
             WHEN attempt_count + 1 >= max_attempts THEN 'FAILED'::"AuditOutboxStatus"
             ELSE 'PENDING'::"AuditOutboxStatus"
           END,
           processing_started_at = NULL,
           attempt_count = attempt_count + 1,
           last_error = LEFT('[reaped after timeout, attempt ' || (attempt_count + 1)::text || ']', 1024)
       WHERE id IN (
         SELECT id FROM audit_outbox
         WHERE status = 'PROCESSING'
           AND processing_started_at < now() - make_interval(secs => $1)
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, tenant_id, attempt_count, status::text AS new_status`,
      timeoutSeconds,
    );
    return rows;
  });

  const log = getLogger();
  for (const row of reaped) {
    if (row.new_status === "FAILED") {
      log.warn({ outboxId: row.id, attemptCount: row.attempt_count }, "worker.reaped_dead_letter");
      deadLetterLogger.warn(
        { outboxId: row.id, tenantId: row.tenant_id, attemptCount: row.attempt_count },
        "outbox row reaped and dead-lettered",
      );
      await writeDirectAuditLog(prisma, row.tenant_id, AUDIT_ACTION.AUDIT_OUTBOX_DEAD_LETTER, {
        outboxId: row.id,
        attemptCount: row.attempt_count,
        reason: "reaped_max_attempts",
      });
    } else {
      log.info({ outboxId: row.id, attemptCount: row.attempt_count }, "worker.reaped");
      await writeDirectAuditLog(prisma, row.tenant_id, AUDIT_ACTION.AUDIT_OUTBOX_REAPED, {
        outboxId: row.id,
        attemptCount: row.attempt_count,
      });
    }
  }

  return reaped.length;
}

/**
 * Reset stuck PROCESSING delivery rows back to PENDING or FAILED.
 * Rows stuck longer than PROCESSING_TIMEOUT_MS are assumed abandoned.
 */
async function reapStuckDeliveries(prisma: PrismaClient): Promise<number> {
  const timeout = AUDIT_OUTBOX.PROCESSING_TIMEOUT_MS;
  const cutoff = new Date(Date.now() - timeout);

  const result = await prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    return tx.$executeRawUnsafe(
      `UPDATE "audit_deliveries"
       SET "status" = CASE
         WHEN "attempt_count" + 1 >= "max_attempts" THEN 'FAILED'::"AuditDeliveryStatus"
         ELSE 'PENDING'::"AuditDeliveryStatus"
       END,
       "attempt_count" = "attempt_count" + 1,
       "processing_started_at" = NULL,
       "last_error" = 'reaped: processing timeout exceeded'
       WHERE "status" = 'PROCESSING'
         AND "processing_started_at" < $1`,
      cutoff,
    );
  });

  const count = Number(result);
  if (count > 0) {
    getLogger().info({ count }, "reaped stuck delivery rows");
  }

  return count;
}

/**
 * Purge SENT rows older than RETENTION_HOURS and FAILED rows older than FAILED_RETENTION_DAYS.
 */
async function purgeRetention(prisma: PrismaClient): Promise<void> {
  const retentionHours = AUDIT_OUTBOX.RETENTION_HOURS;
  const failedRetentionDays = AUDIT_OUTBOX.FAILED_RETENTION_DAYS;

  const sentCutoff = new Date(Date.now() - retentionHours * 3_600_000);
  const failedCutoff = new Date(Date.now() - failedRetentionDays * 86_400_000);

  const result = await prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    const rows = await tx.$queryRawUnsafe<{ purged: bigint; sample_tenant_id: string | null }[]>(
      `WITH deleted AS (
        DELETE FROM audit_outbox
        WHERE (
          status = 'SENT'
          AND sent_at < now() - make_interval(hours => $1)
          AND NOT EXISTS (
            SELECT 1 FROM "audit_deliveries"
            WHERE "audit_deliveries"."outbox_id" = "audit_outbox"."id"
              AND "audit_deliveries"."status" IN ('PENDING', 'PROCESSING')
          )
        )
           OR (status = 'FAILED' AND created_at < now() - make_interval(days  => $2))
        RETURNING id, tenant_id
      )
      SELECT COUNT(*) AS purged, MIN(tenant_id::text) AS sample_tenant_id FROM deleted`,
      retentionHours,
      failedRetentionDays,
    );
    return {
      purged: Number(rows[0]?.purged ?? 0),
      sampleTenantId: rows[0]?.sample_tenant_id ?? null,
    };
  });

  if (result.purged > 0 && result.sampleTenantId) {
    getLogger().info({ purged: result.purged }, "worker.retention_purged");
    await writeDirectAuditLog(prisma, result.sampleTenantId, AUDIT_ACTION.AUDIT_OUTBOX_RETENTION_PURGED, {
      purgedCount: result.purged,
      retentionHours,
      failedRetentionDays,
    });
  }

  // Purge terminal delivery rows
  const deliveryPurged = await prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    return tx.$executeRawUnsafe(
      `DELETE FROM "audit_deliveries"
       WHERE ("status" = 'SENT' AND "created_at" < $1)
          OR ("status" = 'FAILED' AND "created_at" < $2)`,
      sentCutoff,
      failedCutoff,
    );
  });
  if (Number(deliveryPurged) > 0) {
    getLogger().info({ deliveryPurged }, "purged delivery retention rows");
  }
}

/**
 * Run the reaper: reset stuck PROCESSING rows and purge expired rows.
 */
async function runReaper(prisma: PrismaClient): Promise<void> {
  const log = getLogger();
  try {
    const reaped = await reapStuckRows(prisma);
    if (reaped > 0) {
      log.info({ reaped }, "worker.reaper.stuck_reset");
    }
  } catch (err) {
    log.error({ err }, "worker.reaper.stuck_reset_failed");
  }

  try {
    await reapStuckDeliveries(prisma);
  } catch (err) {
    log.error({ err }, "worker.reaper.stuck_deliveries_reset_failed");
  }

  try {
    await purgeRetention(prisma);
  } catch (err) {
    log.error({ err }, "worker.reaper.retention_purge_failed");
  }
}

// ��── Worker ─────────────────────────────────────────────────────

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

    // Cache checkChainEnabled per tenant within a batch to avoid
    // one DB round-trip per row (the flag rarely changes mid-batch).
    const chainEnabledCache = new Map<string, boolean>();
    async function getChainEnabled(tenantId: string | null): Promise<boolean> {
      if (!tenantId) return false;
      const cached = chainEnabledCache.get(tenantId);
      if (cached !== undefined) return cached;
      const enabled = await checkChainEnabled(workerPrisma, tenantId);
      chainEnabledCache.set(tenantId, enabled);
      return enabled;
    }

    for (const row of rows) {
      let payload: AuditOutboxPayload;

      try {
        payload = parsePayload(row.payload);
      } catch (err) {
        log.error({ err, outboxId: row.id }, "worker.payload_parse_failed");
        await recordError(workerPrisma, row, err);
        continue;
      }

      // Defense-in-depth: reject payloads whose userId is not a valid UUID (e.g. "" from
      // parsePayload's fallback on malformed JSON, or legacy null rows from before the type
      // tightened). logAuditAsync cannot produce these, but external inserts or legacy
      // outbox rows could. Skip the row rather than letting the UUID cast fail.
      if (!UUID_RE.test(payload.userId) && payload.actorType !== ACTOR_TYPE.SYSTEM) {
        log.warn(
          { outboxId: row.id, action: payload.action, actorType: payload.actorType },
          "worker.invalid_userid_skipped",
        );
        deadLetterLogger.warn(
          { outboxId: row.id, tenantId: row.tenant_id, action: payload.action },
          "invalid userId for non-SYSTEM actor — skipping",
        );
        await recordError(
          workerPrisma,
          row,
          new Error("invalid userId for non-SYSTEM actor type"),
        );
        continue;
      }

      // Same guard for SYSTEM actor.
      if (!UUID_RE.test(payload.userId)) {
        log.warn(
          { outboxId: row.id, action: payload.action },
          "worker.invalid_userid_skipped",
        );
        await recordError(
          workerPrisma,
          row,
          new Error("SYSTEM actor with invalid userId must not enter the outbox — check OUTBOX_BYPASS_AUDIT_ACTIONS"),
        );
        continue;
      }

      try {
        const chainEnabled = await getChainEnabled(row.tenant_id);
        if (chainEnabled) {
          await deliverRowWithChain(workerPrisma, row, payload);
        } else {
          await deliverRow(workerPrisma, row, payload);
        }
        log.info(
          { outboxId: row.id, action: payload.action, tenantId: row.tenant_id },
          "worker.delivered",
        );
        void dispatchWebhookForRow(payload, row.tenant_id);
        // Phase 3: fan out to non-DB delivery targets (fire-and-forget).
        // If the worker crashes here, outbox row is already SENT so fan-out
        // will not be retried. This is the design trade-off per Plan §3.4:
        // DB target success is not rolled back by fan-out failure.
        fanOutDeliveries(workerPrisma, row.id, row.tenant_id).catch((err) => {
          log.error({ err, outboxId: row.id }, "worker.fanout_failed");
        });
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
  let lastReaperRun = 0;

  async function loop(): Promise<void> {
    const log = getLogger();
    log.info({ batchSize, pollIntervalMs }, "worker.loop_start");

    while (running) {
      const claimed = await processBatch();

      // Phase 3: process pending deliveries
      let deliveryClaimed = 0;
      try {
        deliveryClaimed = await processDeliveryBatch(workerPrisma, batchSize);
        if (deliveryClaimed > 0) {
          log.debug({ deliveryClaimed }, "processed delivery batch");
        }
      } catch (err) {
        log.error({ err }, "worker.delivery_batch_failed");
      }

      // Run reaper at REAPER_INTERVAL_MS intervals
      const now = Date.now();
      if (now - lastReaperRun >= AUDIT_OUTBOX.REAPER_INTERVAL_MS) {
        lastReaperRun = now;
        await runReaper(workerPrisma);
      }

      if (!running) break;

      if (claimed === 0 && deliveryClaimed === 0) {
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
