import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { getLogger } from "@/lib/logger";
import { deadLetterLogger } from "@/lib/audit/audit-logger";
import { computeBackoffMs, withFullJitter } from "@/lib/http/backoff";
import {
  AUDIT_OUTBOX,
  AUDIT_SCOPE,
  AUDIT_ACTION,
  ACTOR_TYPE,
  OUTBOX_BYPASS_AUDIT_ACTIONS,
  WEBHOOK_DISPATCH_SUPPRESS,
} from "@/lib/constants/audit/audit";
import {
  WEBHOOK_DELIVERY_BATCH_SIZE,
  validateWebhookDeliveryLease,
} from "@/lib/constants/audit/webhook-delivery-lease.server";
import { BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { NIL_UUID, SYSTEM_ACTOR_ID, UUID_RE } from "@/lib/constants/app";
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_SECOND } from "@/lib/constants/time";
import { WORKER_POOL_IDLE_TIMEOUT_MS, WORKER_POOL_STATEMENT_TIMEOUT_MS } from "@/workers/worker-pool-config";
import { DELIVERERS, type TargetConfig, type DeliveryPayload } from "@/workers/audit-delivery";
import { decryptServerData, getMasterKeyByVersion } from "@/lib/crypto/crypto-server";
import { sanitizeErrorForStorage, sanitizeForExternalDelivery } from "@/lib/http/external-http";
import { buildChainInput, computeCanonicalBytes, computeEventHash } from "@/lib/audit/audit-chain";
// NOTE: @/lib/webhook-dispatcher is imported LAZILY inside processOneWebhookDelivery
// (not at module scope) — it transitively pulls in the @/lib/prisma singleton,
// which throws at import time when DATABASE_URL is unset. Eager-importing it here
// would break the entry script's `--validate-env-only` path (the Zod env error
// must surface before any prisma init). `type WebhookRecord` is a type-only import
// (erased at compile time, no runtime module load).
import type { WebhookRecord } from "@/lib/webhook-dispatcher";
import { WEBHOOK_MAX_RETRIES, WEBHOOK_AUTO_DISABLE_THRESHOLD, WEBHOOK_DELIVERY_CONCURRENCY } from "@/lib/validations/common.server";
import { maskUrlForDisplay } from "@/lib/url/url-validation";

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

/**
 * Enqueue exactly one webhook delivery work item for this outbox row, inside
 * the caller's winning audit tx (the tx MUST have already run setBypassRlsGucs).
 * Called only by the ON CONFLICT winner of the audit_logs INSERT, so the row is
 * enqueued atomically with the audit event: a crash before commit rolls back
 * both; a crash after commit leaves a durable PENDING row the delivery loop
 * re-runs.
 *
 * Scope maps to the current dispatchWebhookForRow semantics: TEAM+teamId → one
 * TEAM item, TENANT → one TENANT item, PERSONAL → nothing. Suppressed actions
 * (operational/dead-letter events) enqueue nothing. Subscriber resolution and
 * the events filter happen later, at delivery time, against the live webhook
 * tables — so this is a cheap single INSERT keyed only on the outbox row.
 *
 * `ON CONFLICT (outbox_id, scope, team_id) DO NOTHING` is defense-in-depth
 * against a reaper double-claim; in the normal path the audit_logs ON CONFLICT
 * winner is the only caller, so this never conflicts.
 */
async function enqueueWebhookDeliveryInTx(
  tx: Prisma.TransactionClient,
  row: AuditOutboxRow,
  payload: AuditOutboxPayload,
): Promise<void> {
  if (
    OUTBOX_BYPASS_AUDIT_ACTIONS.has(payload.action) ||
    WEBHOOK_DISPATCH_SUPPRESS.has(payload.action)
  ) {
    return;
  }

  let scope: "TENANT" | "TEAM";
  let teamId: string | null;
  if (payload.scope === AUDIT_SCOPE.TEAM && payload.teamId) {
    scope = "TEAM";
    teamId = payload.teamId;
  } else if (payload.scope === AUDIT_SCOPE.TENANT) {
    scope = "TENANT";
    teamId = null;
  } else {
    // PERSONAL (or TEAM with no teamId) — never dispatched to webhooks.
    return;
  }

  await tx.$executeRawUnsafe(
    `INSERT INTO webhook_deliveries (
      id, outbox_id, tenant_id, scope, team_id, action, status, next_retry_at, created_at
    ) VALUES (
      gen_random_uuid(),
      $1::uuid,
      $2::uuid,
      $3::"WebhookDeliveryScope",
      $4::uuid,
      $5,
      'PENDING',
      now(),
      now()
    )
    ON CONFLICT (outbox_id, scope, team_id) DO NOTHING`,
    row.id,
    row.tenant_id,
    scope,
    teamId,
    payload.action,
  );
}

/**
 * Returns `inserted: true` when the audit_logs INSERT won the ON CONFLICT race
 * (false when a concurrent/reaper re-delivery already inserted this outbox
 * row's audit log). The outbox row is marked SENT regardless. Callers that
 * need the prior void semantics can ignore the return; the webhook enqueue is
 * gated on `inserted` INSIDE this tx so only the winner enqueues.
 */
export async function deliverRow(
  prisma: PrismaClient,
  row: AuditOutboxRow,
  payload: AuditOutboxPayload,
): Promise<{ inserted: boolean }> {
  return prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);

    const metadataJson =
      payload.metadata !== null ? JSON.stringify(payload.metadata) : null;
    const createdAtIso = row.created_at.toISOString();

    const inserted = await tx.$queryRawUnsafe<{ id: string }[]>(
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
      ON CONFLICT (outbox_id) DO NOTHING
      RETURNING id`,
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

    // Only the ON CONFLICT winner enqueues the webhook delivery — atomic with
    // the audit_logs INSERT. A reaper re-delivery (inserted.length === 0) must
    // not re-enqueue (the original work item already exists / was processed).
    if (inserted.length > 0) {
      await enqueueWebhookDeliveryInTx(tx, row, payload);
    }

    await tx.$executeRawUnsafe(
      `UPDATE audit_outbox
       SET status = 'SENT',
           sent_at = now(),
           processing_started_at = NULL
       WHERE id = $1`,
      row.id,
    );

    return { inserted: inserted.length > 0 };
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

/**
 * Returns `delivered: true` when the row was delivered and the chain advanced,
 * `delivered: false` when the row was skipped because publish_paused_until is
 * active. `inserted` reflects whether the audit_logs INSERT actually won the
 * ON CONFLICT race (false when a concurrent delivery already inserted this
 * outbox row's audit log) — callers must read `.delivered` for the prior
 * boolean semantics; `.inserted` is only for concurrency-race assertions.
 */
export async function deliverRowWithChain(
  prisma: PrismaClient,
  row: AuditOutboxRow,
  payload: AuditOutboxPayload,
): Promise<{ delivered: boolean; inserted: boolean }> {
  const result = await prisma.$transaction(async (tx) => {
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

    // Lock the anchor row for this tenant.
    // Also read publish_paused_until to implement plan F2/S9/R3-N5:
    // chain advancement is gated on the publisher's fail-closed pause flag.
    // When the publisher encounters an error, it sets publish_paused_until to
    // now() + pause_duration so that outbox rows are not chained into a
    // potentially inconsistent anchor state. See audit-anchor-publisher.ts
    // Step 5 (nonPausedAnchors filter) for where the pause is set.
    //
    // NOTE (liveness): paused rows are left PENDING and re-claimed on the
    // next poll cycle. We deliberately do NOT filter them out of claimBatch
    // (option a from the plan) to keep the claim query simple. The natural
    // batch size + OUTBOX_POLL_INTERVAL_MS cadence bounds the re-check rate.
    // This only matters during a sustained publisher pause (rare in practice).
    const anchors = await tx.$queryRawUnsafe<{
      chain_seq: bigint;
      prev_hash: Buffer;
      publish_paused_until: Date | null;
    }[]>(
      `SELECT chain_seq, prev_hash, publish_paused_until FROM audit_chain_anchors WHERE tenant_id = $1::uuid FOR UPDATE`,
      row.tenant_id,
    );

    const anchor = anchors[0];
    if (!anchor) {
      throw new Error(`Anchor row missing after upsert for tenant ${row.tenant_id}`);
    }

    // If publish_paused_until is set and in the future, skip chain advancement.
    // The outbox row remains PENDING (reset below) so the next poll will retry.
    // Do NOT emit an audit event here — the publisher already emits
    // AUDIT_ANCHOR_PUBLISH_PAUSED per cron tick and we must not double-emit.
    if (anchor.publish_paused_until && anchor.publish_paused_until > new Date()) {
      getLogger().debug(
        { outboxId: row.id, tenantId: row.tenant_id, publishPausedUntil: anchor.publish_paused_until },
        "worker.chain_advancement_skipped_paused",
      );
      // Reset the row to PENDING so it is retried after the pause expires.
      await tx.$executeRawUnsafe(
        `UPDATE audit_outbox
         SET status = 'PENDING',
             processing_started_at = NULL
         WHERE id = $1`,
        row.id,
      );
      return { delivered: false, inserted: false };
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
      // Enqueue the webhook delivery in the same winning tx (INV-W2).
      await enqueueWebhookDeliveryInTx(tx, row, payload);
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
    return { delivered: true, inserted: inserted.length > 0 };
  });
  return result;
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
 * Insert a SYSTEM-actor audit event into audit_logs using the caller's
 * transaction. The caller's tx MUST have already run setBypassRlsGucs. This
 * does NOT open a tx and does NOT swallow errors — a failure rolls back the
 * caller's tx, which is required when the audit row must commit atomically
 * with a sibling mutation (e.g. the retention-purge DELETE).
 */
interface DirectAuditScope {
  scope?: string;
  teamId?: string | null;
}

async function writeDirectAuditLogInTx(
  tx: Prisma.TransactionClient,
  tenantId: string,
  action: string,
  metadata: Record<string, unknown>,
  opts?: DirectAuditScope,
): Promise<void> {
  await tx.$executeRawUnsafe(
    `INSERT INTO audit_logs (
      id, tenant_id, scope, action, user_id, actor_type, team_id, metadata, created_at
    ) VALUES (
      gen_random_uuid(),
      $1::uuid,
      $2::"AuditScope",
      $3::"AuditAction",
      $4::uuid,
      $5::"ActorType",
      $6::uuid,
      $7::jsonb,
      now()
    )`,
    tenantId,
    opts?.scope ?? AUDIT_SCOPE.TENANT,
    action,
    SYSTEM_ACTOR_ID,
    ACTOR_TYPE.SYSTEM,
    opts?.teamId ?? null,
    JSON.stringify(metadata),
  );
}

/**
 * Write a SYSTEM-actor audit event directly to audit_logs, bypassing the outbox.
 * Used by reaper and dead-letter logging to avoid recursion. Opens its own tx
 * and swallows errors (best-effort — must never break the caller's flow).
 */
async function writeDirectAuditLog(
  prisma: PrismaClient,
  tenantId: string,
  action: string,
  metadata: Record<string, unknown>,
  opts?: DirectAuditScope,
): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      await writeDirectAuditLogInTx(tx, tenantId, action, metadata, opts);
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
  // Strip URL query params and credential patterns before persisting,
  // matching the audit-delivery dead-letter path. last_error rows are
  // long-lived (until retention purge) and feed the audit log.
  const sanitizedError = sanitizeErrorForStorage(errorMsg);
  const newAttemptCount = row.attempt_count + 1;
  const isDead = newAttemptCount >= row.max_attempts;
  const backoffMs = withFullJitter(computeBackoffMs(newAttemptCount));
  const backoffSeconds = backoffMs / MS_PER_SECOND;

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
          sanitizedError,
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
          sanitizedError,
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
      lastError: sanitizedError.slice(0, 256),
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

// ─── Webhook delivery (durable) ─────────────────────────────────

interface WebhookDeliveryRow {
  id: string;
  outbox_id: string;
  tenant_id: string;
  scope: string;
  team_id: string | null;
  action: string;
  attempt_count: number;
  max_attempts: number;
}

/**
 * Claim and process a batch of pending webhook_deliveries work items.
 * Sibling of processDeliveryBatch — same FOR UPDATE SKIP LOCKED claim, but the
 * fan-out resolves the LIVE tenant_webhooks/team_webhooks subscribers whose
 * `events` includes the row's action (delivery-time semantics: an event that
 * lost its subscription between enqueue and delivery is not delivered), and
 * delivers via the extracted webhook-dispatcher core under the worker prisma.
 * The work item is marked SENT once the fan-out pass completes; individual
 * per-webhook HTTP failures stay on the per-webhook failCount + in-worker
 * deliverWithRetry (no re-notify of already-succeeded webhooks). Returns the
 * number of work items claimed.
 */
export async function processWebhookDeliveryBatch(
  prisma: PrismaClient,
  batchSize: number,
): Promise<number> {
  const claimed = await prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    return tx.$queryRawUnsafe<WebhookDeliveryRow[]>(
      `UPDATE webhook_deliveries
       SET status = 'PROCESSING',
           processing_started_at = now()
       WHERE id IN (
         SELECT id FROM webhook_deliveries
         WHERE status = 'PENDING'
           AND next_retry_at <= now()
         ORDER BY next_retry_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       AND status = 'PENDING'
       RETURNING id, outbox_id, tenant_id, scope::text AS scope,
                 team_id, action, attempt_count, max_attempts`,
      batchSize,
    );
  });

  if (claimed.length === 0) return 0;

  // Process work items in parallel chunks of WEBHOOK_DELIVERY_CONCURRENCY so a
  // batch of slow/unreachable webhooks does not hold the claim lease serially
  // past the PROCESSING timeout (which would let the reaper reset in-flight rows
  // for another worker to re-claim → duplicate + concurrent delivery). The batch
  // size (WEBHOOK_DELIVERY_BATCH_SIZE) is derived from this concurrency and the
  // per-item worst case so ceil(batch/concurrency) chunks fit within half the
  // lease. processOneWebhookDelivery never throws (its own try/catch routes to
  // recordWebhookDeliveryError), so allSettled is belt-and-suspenders.
  for (let i = 0; i < claimed.length; i += WEBHOOK_DELIVERY_CONCURRENCY) {
    const chunk = claimed.slice(i, i + WEBHOOK_DELIVERY_CONCURRENCY);
    await Promise.allSettled(chunk.map((item) => processOneWebhookDelivery(prisma, item)));
  }

  return claimed.length;
}

async function processOneWebhookDelivery(
  workerPrisma: PrismaClient,
  item: WebhookDeliveryRow,
): Promise<void> {
  try {
    // Fetch the outbox payload for the delivery body. If the outbox row was
    // purged (event predates retention), mark SENT + log — there is nothing
    // left to deliver, and the outbox-purge guard only allows this once no
    // PENDING/PROCESSING webhook delivery references the row.
    const outbox = await workerPrisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      const rows = await tx.$queryRawUnsafe<
        { created_at: Date; payload: unknown }[]
      >(
        `SELECT created_at, payload FROM audit_outbox WHERE id = $1::uuid`,
        item.outbox_id,
      );
      return rows[0] ?? null;
    });

    if (!outbox) {
      getLogger().warn(
        { deliveryId: item.id, outboxId: item.outbox_id },
        "webhook_delivery.outbox_purged",
      );
      await markWebhookDeliverySent(workerPrisma, item.id);
      return;
    }

    // Resolve the LIVE subscribers whose events filter includes this action.
    const webhooks = await resolveWebhookSubscribers(workerPrisma, item);

    if (webhooks.length > 0) {
      const outboxPayload = (outbox.payload ?? {}) as Record<string, unknown>;
      const webhookData = (outboxPayload.metadata ?? {}) as Record<
        string,
        unknown
      >;
      // Dispatch-time timestamp (NOT outbox.created_at): it is fed to the
      // Stripe-style X-Webhook-Timestamp anti-replay signature, which receivers
      // reject outside a ±5-minute window. A durable/retried delivery can leave
      // the queue minutes-to-hours after the event; signing with created_at
      // would make every delayed delivery replay-stale and silently dropped by
      // a spec-compliant receiver — the exact failure this feature exists to
      // avoid. Matches the former fire-and-forget dispatch (new Date()).
      const timestamp = new Date().toISOString();
      const data = sanitizeForExternalDelivery(webhookData) as Record<string, unknown>;
      const eventBody =
        item.scope === "TEAM"
          ? { type: item.action, teamId: item.team_id, timestamp, data }
          : { type: item.action, tenantId: item.tenant_id, timestamp, data };
      const payloadStr = JSON.stringify(eventBody);

      // Lazy import: keeps the @/lib/prisma singleton out of the worker's eager
      // module graph so `--validate-env-only` fails cleanly (see the import note).
      const { deliverToWebhookRecords } = await import("@/lib/webhook-dispatcher");
      // A recoverable per-webhook error (secret-version/key/decrypt failure or a
      // health-field DB-update throw) must NOT let the work item be marked SENT —
      // that would permanently lose the webhook on a pending key migration or a
      // transient error. Collect them and fail the work item so it retries.
      const recoverableErrors: unknown[] = [];
      await deliverToWebhookRecords(
        webhooks,
        payloadStr,
        timestamp,
        async (id) => onWebhookDeliverySuccess(workerPrisma, item.scope, id),
        async (id, failCount, url) =>
          onWebhookDeliveryFailure(workerPrisma, item, id, failCount, url),
        async (_id, err) => {
          recoverableErrors.push(err);
        },
      );
      if (recoverableErrors.length > 0) {
        const first = recoverableErrors[0];
        throw first instanceof Error
          ? first
          : new Error(`webhook delivery recoverable error: ${String(first)}`);
      }
    }

    await markWebhookDeliverySent(workerPrisma, item.id);
  } catch (err) {
    await recordWebhookDeliveryError(workerPrisma, item, err);
  }
}

/**
 * Read the live webhook rows for this work item whose `events` array includes
 * the action and that are active, mapped to WebhookRecord for the delivery
 * core. TenantWebhook rows pass teamId: undefined (not null) to keep the AAD
 * byte-identical to the app dispatcher path (buildWebhookSecretAAD).
 */
async function resolveWebhookSubscribers(
  workerPrisma: PrismaClient,
  item: WebhookDeliveryRow,
): Promise<WebhookRecord[]> {
  return workerPrisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    if (item.scope === "TEAM" && item.team_id) {
      const rows = await tx.teamWebhook.findMany({
        // Scope by tenantId too (defense-in-depth): delivery runs under bypass
        // RLS, so filtering by teamId alone would let an inconsistent queue row
        // reach another tenant's team webhook. team_id is globally unique, but a
        // corrupt enqueue must not cross the tenant boundary.
        where: {
          tenantId: item.tenant_id,
          teamId: item.team_id,
          isActive: true,
          events: { has: item.action },
        },
      });
      return rows.map((r) => ({
        id: r.id,
        url: r.url,
        secretEncrypted: r.secretEncrypted,
        secretIv: r.secretIv,
        secretAuthTag: r.secretAuthTag,
        masterKeyVersion: r.masterKeyVersion,
        secretAadVersion: r.secretAadVersion,
        tenantId: r.tenantId,
        kind: "TeamWebhook" as const,
        teamId: r.teamId,
        failCount: r.failCount,
      }));
    }
    const rows = await tx.tenantWebhook.findMany({
      where: { tenantId: item.tenant_id, isActive: true, events: { has: item.action } },
    });
    return rows.map((r) => ({
      id: r.id,
      url: r.url,
      secretEncrypted: r.secretEncrypted,
      secretIv: r.secretIv,
      secretAuthTag: r.secretAuthTag,
      masterKeyVersion: r.masterKeyVersion,
      secretAadVersion: r.secretAadVersion,
      tenantId: r.tenantId,
      kind: "TenantWebhook" as const,
      teamId: undefined,
      failCount: r.failCount,
    }));
  });
}

async function markWebhookDeliverySent(
  workerPrisma: PrismaClient,
  deliveryId: string,
): Promise<void> {
  await workerPrisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    await tx.$executeRawUnsafe(
      `UPDATE webhook_deliveries
       SET status = 'SENT', last_error = NULL, processing_started_at = NULL
       WHERE id = $1::uuid`,
      deliveryId,
    );
  });
}

async function onWebhookDeliverySuccess(
  workerPrisma: PrismaClient,
  scope: string,
  webhookId: string,
): Promise<void> {
  await workerPrisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    if (scope === "TEAM") {
      await tx.teamWebhook.update({
        where: { id: webhookId },
        data: { lastDeliveredAt: new Date(), failCount: 0, lastError: null },
      });
    } else {
      await tx.tenantWebhook.update({
        where: { id: webhookId },
        data: { lastDeliveredAt: new Date(), failCount: 0, lastError: null },
      });
    }
  });
}

async function onWebhookDeliveryFailure(
  workerPrisma: PrismaClient,
  item: WebhookDeliveryRow,
  webhookId: string,
  _newFailCount: number,
  url: string,
): Promise<void> {
  const isTeam = item.scope === "TEAM";
  const table = isTeam ? "team_webhooks" : "tenant_webhooks";
  // Atomic increment (fail_count = fail_count + 1) computed IN the UPDATE, not
  // read-modify-write from the WebhookRecord snapshot: since work items for the
  // same webhook can run concurrently (WEBHOOK_DELIVERY_CONCURRENCY), every
  // concurrent failure would otherwise read the same snapshot failCount and
  // write the same absolute value → a lost update that under-counts failures and
  // delays auto-disable. Derive is_active from the POST-increment value in the
  // same statement, and RETURN it so the audit event reports the true count.
  const updated = await workerPrisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    const rows = await tx.$queryRawUnsafe<{ fail_count: number }[]>( // raw-sql-ident: `table` is a code-controlled literal ("team_webhooks" | "tenant_webhooks") chosen by isTeam, never user input — no injection risk
      `UPDATE "${table}"
       SET fail_count = fail_count + 1,
           last_failed_at = now(),
           last_error = $1,
           is_active = CASE WHEN fail_count + 1 >= $2 THEN false ELSE is_active END,
           updated_at = now()
       WHERE id = $3::uuid
       RETURNING fail_count`,
      `Delivery failed after ${WEBHOOK_MAX_RETRIES} attempts`,
      WEBHOOK_AUTO_DISABLE_THRESHOLD,
      webhookId,
    );
    return rows[0] ?? null;
  });

  const newFailCount = updated?.fail_count ?? 0;

  // Per-webhook delivery failure is a distinct, unchained audit event (parity
  // with the app dispatcher). Uses writeDirectAuditLog (bypass outbox) so it
  // never re-enters the queue. TEAM failures must be recorded with TEAM scope +
  // teamId so they surface in the team audit view (the app dispatcher logged
  // WEBHOOK_DELIVERY_FAILED as TEAM/teamId; a plain TENANT-scope write would
  // change the audit attribution and hide the failure from team admins).
  await writeDirectAuditLog(
    workerPrisma,
    item.tenant_id,
    isTeam
      ? AUDIT_ACTION.WEBHOOK_DELIVERY_FAILED
      : AUDIT_ACTION.TENANT_WEBHOOK_DELIVERY_FAILED,
    {
      webhookId,
      url: maskUrlForDisplay(url),
      failCount: newFailCount,
    },
    isTeam ? { scope: AUDIT_SCOPE.TEAM, teamId: item.team_id } : undefined,
  );
}

/**
 * DB-backed backoff + dead-letter for a webhook_deliveries WORK ITEM. Only
 * fires on infrastructure failure of the fan-out pass (outbox read, subscriber
 * resolution, unexpected throw) — individual per-webhook HTTP failures are
 * handled by onWebhookDeliveryFailure and do NOT retry the work item, which
 * would re-notify already-succeeded webhooks. Mirrors recordDeliveryError.
 */
async function recordWebhookDeliveryError(
  workerPrisma: PrismaClient,
  item: WebhookDeliveryRow,
  err: unknown,
): Promise<void> {
  const message = sanitizeErrorForStorage(
    err instanceof Error ? err.message : String(err),
  );
  const newAttemptCount = item.attempt_count + 1;
  const isDead = newAttemptCount >= item.max_attempts;

  try {
    await workerPrisma.$transaction(async (tx) => {
      await setBypassRlsGucs(tx);
      if (isDead) {
        await tx.$executeRawUnsafe(
          `UPDATE webhook_deliveries
           SET status = 'FAILED', attempt_count = $1,
               last_error = LEFT($2, 1024), processing_started_at = NULL
           WHERE id = $3::uuid`,
          newAttemptCount,
          message,
          item.id,
        );
      } else {
        const backoffMs = withFullJitter(computeBackoffMs(newAttemptCount));
        const backoffSeconds = backoffMs / MS_PER_SECOND;
        await tx.$executeRawUnsafe(
          `UPDATE webhook_deliveries
           SET status = 'PENDING', attempt_count = $1,
               next_retry_at = now() + make_interval(secs => $2),
               last_error = LEFT($3, 1024), processing_started_at = NULL
           WHERE id = $4::uuid`,
          newAttemptCount,
          backoffSeconds,
          message,
          item.id,
        );
      }
    });
  } catch (recoveryErr) {
    getLogger().error(
      { deliveryId: item.id, err: recoveryErr },
      "webhook_delivery.error_recovery_tx_failed",
    );
  }

  if (isDead) {
    getLogger().warn({ deliveryId: item.id }, "webhook_delivery.dead_lettered");
    // Record the dead-letter with the work item's own scope/teamId (parity with
    // the per-failure WEBHOOK_DELIVERY_FAILED event) so a TEAM work item's
    // dead-letter surfaces in the team audit view, not just the tenant view.
    await writeDirectAuditLog(
      workerPrisma,
      item.tenant_id,
      AUDIT_ACTION.AUDIT_WEBHOOK_DELIVERY_DEAD_LETTER,
      {
        deliveryId: item.id,
        action: item.action,
        attemptCount: newAttemptCount,
        lastError: message.slice(0, 256),
      },
      item.scope === "TEAM" && item.team_id
        ? { scope: AUDIT_SCOPE.TEAM, teamId: item.team_id }
        : undefined,
    );
  } else {
    getLogger().info(
      { deliveryId: item.id, attempt: newAttemptCount },
      "webhook_delivery.will_retry",
    );
  }
}

// ─── Reaper ─────────────────────────────────────────────────────

/**
 * Reset stuck PROCESSING rows back to PENDING for retry.
 * Rows stuck longer than PROCESSING_TIMEOUT_MS are assumed abandoned.
 *
 * Exported so integration tests can target the real function (see sweep.ts's
 * re-export convention) instead of duplicating this SQL.
 */
export async function reapStuckRows(
  prisma: PrismaClient,
  limit: number = AUDIT_OUTBOX.REAP_BATCH_SIZE,
): Promise<number> {
  const timeoutSeconds = AUDIT_OUTBOX.PROCESSING_TIMEOUT_MS / MS_PER_SECOND;

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
         ORDER BY processing_started_at ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, tenant_id, attempt_count, status::text AS new_status`,
      timeoutSeconds,
      limit,
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
 *
 * Exported so integration tests can target the real function (see sweep.ts's
 * re-export convention) instead of duplicating this SQL.
 */
export async function reapStuckDeliveries(
  prisma: PrismaClient,
  limit: number = AUDIT_OUTBOX.REAP_BATCH_SIZE,
): Promise<number> {
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
       WHERE "id" IN (
         SELECT "id" FROM "audit_deliveries"
         WHERE "status" = 'PROCESSING'
           AND "processing_started_at" < $1
         ORDER BY "processing_started_at" ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )`,
      cutoff,
      limit,
    );
  });

  const count = Number(result);
  if (count > 0) {
    getLogger().info({ count }, "reaped stuck delivery rows");
  }

  return count;
}

/**
 * Reset stuck PROCESSING webhook_deliveries rows back to PENDING or FAILED.
 * Copy of reapStuckDeliveries against the webhook_deliveries table (bounded).
 */
export async function reapStuckWebhookDeliveries(
  prisma: PrismaClient,
  limit: number = AUDIT_OUTBOX.REAP_BATCH_SIZE,
): Promise<number> {
  const timeout = AUDIT_OUTBOX.PROCESSING_TIMEOUT_MS;
  const cutoff = new Date(Date.now() - timeout);

  const result = await prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    return tx.$executeRawUnsafe(
      `UPDATE webhook_deliveries
       SET status = CASE
         WHEN attempt_count + 1 >= max_attempts THEN 'FAILED'::"AuditDeliveryStatus"
         ELSE 'PENDING'::"AuditDeliveryStatus"
       END,
       attempt_count = attempt_count + 1,
       processing_started_at = NULL,
       last_error = 'reaped: processing timeout exceeded'
       WHERE id IN (
         SELECT id FROM webhook_deliveries
         WHERE status = 'PROCESSING'
           AND processing_started_at < $1
         ORDER BY processing_started_at ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )`,
      cutoff,
      limit,
    );
  });

  const count = Number(result);
  if (count > 0) {
    getLogger().info({ count }, "reaped stuck webhook delivery rows");
  }

  return count;
}

/**
 * Purge SENT rows older than RETENTION_HOURS and FAILED rows older than FAILED_RETENTION_DAYS.
 *
 * Split into two independently-capped branches (SENT-aged, FAILED-aged) so a
 * large backlog of SENT rows cannot starve the FAILED-aged purge of its
 * budget — FAILED rows retain the full payload (PII) and must not silently
 * outlive their 90-day retention policy.
 */
export async function purgeRetention(
  prisma: PrismaClient,
  opts?: { limit?: number },
): Promise<void> {
  const limit = opts?.limit ?? AUDIT_OUTBOX.PURGE_BATCH_SIZE;
  const retentionHours = AUDIT_OUTBOX.RETENTION_HOURS;
  const failedRetentionDays = AUDIT_OUTBOX.FAILED_RETENTION_DAYS;

  const sentCutoff = new Date(Date.now() - retentionHours * MS_PER_HOUR);
  const failedCutoff = new Date(Date.now() - failedRetentionDays * MS_PER_DAY);

  // Each branch's DELETE and its RETENTION_PURGED audit event commit
  // atomically in the SAME tx. A destructive delete must never succeed without
  // a matching audit record: if the FAILED-branch tx later throws, the
  // SENT-branch delete + its audit event have already committed together.
  const sentResult = await prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    const rows = await tx.$queryRawUnsafe<{ purged: bigint; sample_tenant_id: string | null }[]>(
      `WITH deleted AS (
        DELETE FROM audit_outbox
        WHERE id IN (
          SELECT id FROM audit_outbox
          WHERE status = 'SENT'
            AND sent_at < now() - make_interval(hours => $1)
            AND NOT EXISTS (
              SELECT 1 FROM "audit_deliveries"
              WHERE "audit_deliveries"."outbox_id" = "audit_outbox"."id"
                AND "audit_deliveries"."status" IN ('PENDING', 'PROCESSING')
            )
            AND NOT EXISTS (
              SELECT 1 FROM "webhook_deliveries"
              WHERE "webhook_deliveries"."outbox_id" = "audit_outbox"."id"
                AND "webhook_deliveries"."status" IN ('PENDING', 'PROCESSING')
            )
          ORDER BY sent_at ASC
          LIMIT $2
        )
        RETURNING id, tenant_id
      )
      SELECT COUNT(*) AS purged, MIN(tenant_id::text) AS sample_tenant_id FROM deleted`,
      retentionHours,
      limit,
    );
    const purged = Number(rows[0]?.purged ?? 0);
    const sampleTenantId = rows[0]?.sample_tenant_id ?? null;
    if (purged > 0 && sampleTenantId) {
      await writeDirectAuditLogInTx(tx, sampleTenantId, AUDIT_ACTION.AUDIT_OUTBOX_RETENTION_PURGED, {
        purgedCount: purged,
        retentionHours,
        failedRetentionDays,
      });
    }
    return { purged, sampleTenantId };
  });

  const failedResult = await prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    const rows = await tx.$queryRawUnsafe<{ purged: bigint; sample_tenant_id: string | null }[]>(
      `WITH deleted AS (
        DELETE FROM audit_outbox
        WHERE id IN (
          SELECT id FROM audit_outbox
          WHERE status = 'FAILED'
            AND created_at < now() - make_interval(days => $1)
          ORDER BY created_at ASC
          LIMIT $2
        )
        RETURNING id, tenant_id
      )
      SELECT COUNT(*) AS purged, MIN(tenant_id::text) AS sample_tenant_id FROM deleted`,
      failedRetentionDays,
      limit,
    );
    const purged = Number(rows[0]?.purged ?? 0);
    const sampleTenantId = rows[0]?.sample_tenant_id ?? null;
    if (purged > 0 && sampleTenantId) {
      await writeDirectAuditLogInTx(tx, sampleTenantId, AUDIT_ACTION.AUDIT_OUTBOX_RETENTION_PURGED, {
        purgedCount: purged,
        retentionHours,
        failedRetentionDays,
      });
    }
    return { purged, sampleTenantId };
  });

  const totalPurged = sentResult.purged + failedResult.purged;
  if (totalPurged > 0) {
    getLogger().info({ purged: totalPurged }, "worker.retention_purged");
  }

  // Purge terminal delivery rows
  const deliveryPurged = await prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    return tx.$executeRawUnsafe(
      `DELETE FROM "audit_deliveries"
       WHERE "id" IN (
         SELECT "id" FROM "audit_deliveries"
         WHERE ("status" = 'SENT' AND "created_at" < $1)
            OR ("status" = 'FAILED' AND "created_at" < $2)
         ORDER BY "created_at" ASC
         LIMIT $3
       )`,
      sentCutoff,
      failedCutoff,
      limit,
    );
  });
  if (Number(deliveryPurged) > 0) {
    getLogger().info({ deliveryPurged }, "purged delivery retention rows");
  }

  // Purge terminal webhook delivery rows (bounded).
  const webhookDeliveryPurged = await prisma.$transaction(async (tx) => {
    await setBypassRlsGucs(tx);
    return tx.$executeRawUnsafe(
      `DELETE FROM webhook_deliveries
       WHERE id IN (
         SELECT id FROM webhook_deliveries
         WHERE (status = 'SENT' AND created_at < $1)
            OR (status = 'FAILED' AND created_at < $2)
         ORDER BY created_at ASC
         LIMIT $3
       )`,
      sentCutoff,
      failedCutoff,
      limit,
    );
  });
  if (Number(webhookDeliveryPurged) > 0) {
    getLogger().info({ webhookDeliveryPurged }, "purged webhook delivery retention rows");
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
    await reapStuckWebhookDeliveries(prisma);
  } catch (err) {
    log.error({ err }, "worker.reaper.stuck_webhook_deliveries_reset_failed");
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
    idleTimeoutMillis: WORKER_POOL_IDLE_TIMEOUT_MS,
    statement_timeout: WORKER_POOL_STATEMENT_TIMEOUT_MS,
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
        let rowDelivered: boolean;
        if (chainEnabled) {
          const res = await deliverRowWithChain(workerPrisma, row, payload);
          rowDelivered = res.delivered;
        } else {
          // deliverRow always marks the outbox row SENT and never returns a
          // paused/skip state (unlike deliverRowWithChain); the webhook enqueue
          // gate lives inside its tx, so rowDelivered stays unconditionally true.
          await deliverRow(workerPrisma, row, payload);
          rowDelivered = true;
        }
        if (!rowDelivered) {
          // Row was skipped because the tenant's anchor has publish_paused_until
          // active. The row is already reset to PENDING inside deliverRowWithChain.
          // Skip fan-out — it will run after the pause lifts. The webhook enqueue
          // is gated on the audit_logs INSERT winner and did not fire here.
          continue;
        }
        log.info(
          { outboxId: row.id, action: payload.action, tenantId: row.tenant_id },
          "worker.delivered",
        );
        // Webhook delivery is now durable: enqueueWebhookDeliveryInTx committed a
        // webhook_deliveries row inside the winning audit tx, and
        // processWebhookDeliveryBatch drives the actual HTTP fan-out. No
        // fire-and-forget dispatch here (replaces the former dispatchWebhookForRow).
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
  // C16 (OWASP A09-2): outbox-depth alert state. Tracks whether the depth
  // is currently above threshold + when we last alerted. Re-alert on
  // (a) clear → alarm transition AND (b) every REALERT_MS while still in
  // alarmed state. Prevents both single-shot-only alerts (operator forgets)
  // and alert-flood on flap.
  let depthAlarmed = false;
  let lastDepthAlertAt = 0;
  const DEPTH_REALERT_MS = MS_PER_DAY;
  const pendingThreshold = AUDIT_OUTBOX.READY_PENDING_THRESHOLD;
  const oldestThresholdSecs = AUDIT_OUTBOX.READY_OLDEST_THRESHOLD;

  async function checkDepthAlert(): Promise<void> {
    try {
      const rows = await workerPrisma.$queryRawUnsafe<
        Array<{ pending: bigint; oldest_age_secs: number | null }>
      >(`
        SELECT
          COUNT(*)::bigint AS pending,
          EXTRACT(EPOCH FROM (now() - MIN(created_at)))::int AS oldest_age_secs
        FROM audit_outbox
        WHERE status = 'PENDING'
      `);
      const r = rows[0];
      const pending = Number(r?.pending ?? 0);
      const oldestAge = r?.oldest_age_secs ?? 0;
      const overThreshold =
        pending > pendingThreshold || oldestAge > oldestThresholdSecs;

      const now = Date.now();
      if (overThreshold) {
        const shouldAlert =
          !depthAlarmed ||
          now - lastDepthAlertAt >= DEPTH_REALERT_MS;
        if (shouldAlert) {
          getLogger().error(
            {
              pending,
              oldestAgeSecs: oldestAge,
              pendingThreshold,
              oldestThresholdSecs,
              _logType: "outbox.depth.alert",
            },
            "outbox.depth.alert",
          );
          lastDepthAlertAt = now;
        }
        depthAlarmed = true;
      } else {
        depthAlarmed = false;
        lastDepthAlertAt = 0;
      }
    } catch (err) {
      getLogger().warn({ err }, "outbox.depth.check_failed");
    }
  }

  async function loop(): Promise<void> {
    const log = getLogger();
    log.info({ batchSize, pollIntervalMs }, "worker.loop_start");

    while (running) {
      const claimed = await processBatch();

      // Phase 3: process pending audit-log deliveries (SIEM/S3 sinks)
      let deliveryClaimed = 0;
      try {
        deliveryClaimed = await processDeliveryBatch(workerPrisma, batchSize);
        if (deliveryClaimed > 0) {
          log.debug({ deliveryClaimed }, "processed delivery batch");
        }
      } catch (err) {
        log.error({ err }, "worker.delivery_batch_failed");
      }

      // Durable webhook delivery: drain pending webhook_deliveries work items.
      // Uses a small bounded batch (NOT the 500-row outbox batchSize): each item
      // can hold the claim lease for the full worst-case delivery time, so the
      // batch must stay short enough that serial processing finishes before the
      // PROCESSING timeout — otherwise the reaper resets in-flight rows and a
      // second worker re-claims them (duplicate + concurrent delivery).
      let webhookDeliveryClaimed = 0;
      try {
        webhookDeliveryClaimed = await processWebhookDeliveryBatch(
          workerPrisma,
          WEBHOOK_DELIVERY_BATCH_SIZE,
        );
        if (webhookDeliveryClaimed > 0) {
          log.debug({ webhookDeliveryClaimed }, "processed webhook delivery batch");
        }
      } catch (err) {
        log.error({ err }, "worker.webhook_delivery_batch_failed");
      }

      // Run reaper at REAPER_INTERVAL_MS intervals
      const now = Date.now();
      if (now - lastReaperRun >= AUDIT_OUTBOX.REAPER_INTERVAL_MS) {
        lastReaperRun = now;
        await runReaper(workerPrisma);
        // Reaper interval is a reasonable cadence for depth alerts too;
        // avoids hammering the COUNT(*) on every poll tick.
        await checkDepthAlert();
      }

      if (!running) break;

      if (claimed === 0 && deliveryClaimed === 0 && webhookDeliveryClaimed === 0) {
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
      // Fail closed if the configured PROCESSING timeout cannot safely hold one
      // webhook delivery item's worst case — otherwise the reaper would reset
      // in-flight rows mid-delivery for a duplicate re-claim (F1 lease guard).
      const leaseError = validateWebhookDeliveryLease();
      if (leaseError) {
        getLogger().error({ leaseError }, "worker.webhook_delivery_lease_misconfigured");
        throw new Error(leaseError);
      }

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
