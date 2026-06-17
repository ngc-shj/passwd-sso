/**
 * Sweep logic for the retention-GC worker.
 *
 * Three exported functions:
 *   sweepExpiryEntry  — batch-bounded DELETE for EXPIRY entries
 *   sweepAuditLogs    — per-tenant audit log purge via SECURITY DEFINER fn
 *   sweepOnce         — orchestrates one full registry sweep + heartbeat audit
 *
 * Each EXPIRY entry runs in its own transaction. The PER_TENANT_FN entry runs
 * in its own transaction. The heartbeat runs in a final separate transaction
 * after all per-entry counts are collected (INV-C4a). A per-entry failure is
 * caught, logged {table, code} (the authoritative error record — F7), and the
 * sweep continues (INV-C4b).
 */

import { PrismaClient } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { getLogger } from "@/lib/logger";
import {
  AUDIT_SCOPE,
  AUDIT_ACTION,
  ACTOR_TYPE,
  AUDIT_METADATA_KEY,
} from "@/lib/constants/audit/audit";
import { SYSTEM_ACTOR_ID, SYSTEM_TENANT_ID } from "@/lib/constants/app";
import type { AuditOutboxPayload } from "@/lib/audit/audit-outbox";
import { MS_PER_DAY } from "@/lib/constants/time";
import { AUDIT_LOG_RETENTION_MIN } from "@/lib/validations/common";
import { assertIdentifier, renderPredicate } from "./predicate";
import {
  RETENTION_REGISTRY,
  type ExpiryEntry,
  type PerTenantFnEntry,
} from "./registry";

// Re-export EmitFn and enqueueAuditInWorkerTx so integration tests can target them.
export type EmitFn = (
  tx: Prisma.TransactionClient,
  tenantId: string,
  payload: AuditOutboxPayload,
) => Promise<void>;

export interface SweepOpts {
  intervalMs: number;
  emitHeartbeatAudit: boolean;
  /**
   * Optional override for the audit-emit step in sweepOnce's heartbeat tx.
   * Used only in integration tests to simulate heartbeat-tx failures (C4 idempotency test).
   * Production callers omit this; sweepOnce defaults to enqueueAuditInWorkerTx.
   */
  _emitFn?: EmitFn;
}

/**
 * Inline audit enqueue — mirrors enqueueAuditInTx from @/lib/audit/audit-outbox
 * but inlined here to avoid the transitive import of @/lib/prisma (the app
 * singleton), which would throw at module load time when DATABASE_URL is unset.
 * Behaviour is identical: verifies bypass_rls GUC, checks tenant existence,
 * then writes to audit_outbox within the caller's transaction.
 *
 * Exported so integration tests can stub it via the _emitFn override.
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
 * Delete up to `batchSize` expired rows for one EXPIRY registry entry.
 *
 * Security:
 * - Identifiers (table, cutoffColumn, keyColumns) are validated at worker boot
 *   via assertIdentifier in createWorker; called here defensively too.
 * - bypass_rls GUC is set in-tx for every globalDelete entry (INV-C2b).
 * - DELETE is batch-bounded via (keys) IN (SELECT keys ... LIMIT $1) — the
 *   ONLY parameter bound is batchSize; all other tokens come from the registry
 *   (literal strings, allowlist-validated), never from runtime input.
 *
 * @returns Number of rows deleted.
 */
export async function sweepExpiryEntry(
  tx: Prisma.TransactionClient,
  entry: ExpiryEntry,
  batchSize: number,
): Promise<number> {
  // Defensive identifier validation at sweep time (boot validation is primary).
  assertIdentifier(entry.table);
  assertIdentifier(entry.cutoffColumn);
  for (const col of entry.keyColumns) {
    assertIdentifier(col);
  }

  if (entry.globalDelete) {
    // Set bypass_rls GUC to span all tenants under the existing RLS policies.
    // Mirror dcr-cleanup-worker.ts:95.
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
  }

  // Build the predicate fragment (may be empty string if no predicate).
  const predicateSql =
    entry.predicate && entry.predicate.length > 0
      ? ` AND ${renderPredicate(entry.predicate)}`
      : "";

  // Row-value (keys) IN (SELECT keys ...) form works for both single-column
  // ("id") and composite ("identifier", "token") key sets.
  const keyList = entry.keyColumns.join(", ");
  const sql = `DELETE FROM ${entry.table}
    WHERE (${keyList}) IN (
      SELECT ${keyList} FROM ${entry.table}
      WHERE ${entry.cutoffColumn} < now()${predicateSql}
      LIMIT $1
    )`;

  return tx.$executeRawUnsafe<number>(sql, batchSize);
}

/**
 * Delete expired audit_logs rows for every tenant with a non-null retention setting.
 *
 * - Enumerates only tenants with auditLogRetentionDays IS NOT NULL.
 * - Clamps each tenant's retention to max(retention, AUDIT_LOG_RETENTION_MIN) (S4 floor).
 * - Deletion is routed through audit_log_purge(uuid, timestamptz), a SECURITY
 *   DEFINER function — the worker role has no direct DELETE grant on audit_logs (S5/F5).
 * - Runs under bypass_rls to read tenants across all tenant-id contexts (INV-C3c).
 *
 * @returns Total rows deleted across all enumerated tenants.
 */
export async function sweepAuditLogs(
  tx: Prisma.TransactionClient,
  _entry: PerTenantFnEntry,
): Promise<number> {
  // bypass_rls required to enumerate tenants (no app.tenant_id set in the worker).
  await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;

  // Enumerate only tenants that have explicit retention configured.
  // NULL → no auto-deletion (FR4).
  const tenants = await tx.tenant.findMany({
    where: { auditLogRetentionDays: { not: null } },
    select: { id: true, auditLogRetentionDays: true },
  });

  let total = 0;
  for (const tenant of tenants) {
    const retention = tenant.auditLogRetentionDays!;
    // Clamp to the system minimum floor so a tenant cannot shorten retention below 30d.
    const effectiveDays = Math.max(retention, AUDIT_LOG_RETENTION_MIN);
    const cutoff = new Date(Date.now() - effectiveDays * MS_PER_DAY);

    const rows = await tx.$queryRaw<Array<{ rows_deleted: number }>>`
      SELECT audit_log_purge(${tenant.id}::uuid, ${cutoff}::timestamptz) AS rows_deleted
    `;
    total += rows[0]?.rows_deleted ?? 0;
  }

  return total;
}

/**
 * Run one full sweep across the RETENTION_REGISTRY.
 *
 * Each EXPIRY entry runs in its own $transaction (INV-C4a). A per-entry error
 * is caught, logged {table, code} (the authoritative error record — F7), and
 * the sweep continues (INV-C4b). After collecting all counts, a final separate
 * transaction emits one heartbeat audit row summarising the sweep.
 *
 * The heartbeat tx is NOT atomic with the delete txs (deliberate C4 deviation):
 * per-entry isolation requires separate txs, so atomicity is impossible. The
 * per-entry structured log line is the durable authoritative record; the
 * heartbeat is best-effort (same contract as logAuditAsync).
 *
 * @returns A map of table name → rows deleted (or -1 on per-entry error).
 */
export async function sweepOnce(
  workerPrisma: PrismaClient,
  batchSize: number,
  opts: SweepOpts,
): Promise<Record<string, number>> {
  const log = getLogger();
  const counts: Record<string, number> = {};

  for (const entry of RETENTION_REGISTRY) {
    const tableName = entry.table;
    try {
      if (entry.kind === "EXPIRY") {
        const deleted = await workerPrisma.$transaction(async (tx) =>
          sweepExpiryEntry(tx, entry, batchSize),
        );
        counts[tableName] = deleted;
      } else {
        // kind === "PER_TENANT_FN"
        const deleted = await workerPrisma.$transaction(async (tx) =>
          sweepAuditLogs(tx, entry),
        );
        counts[tableName] = deleted;
      }
    } catch (err) {
      // Per-entry error isolation (INV-C4b): log {table, code} — authoritative error record (F7).
      // Never log err.message or the generated SQL (S6).
      const code =
        (err as NodeJS.ErrnoException | undefined)?.code ?? "unknown";
      log.error({ table: tableName, code }, "retention-gc.entry_failed");
      counts[tableName] = -1;
    }
  }

  // Emit a heartbeat audit row if any rows were deleted, or if always-on heartbeat is set.
  const anyDeleted = Object.values(counts).some((n) => n > 0);
  if (anyDeleted || opts.emitHeartbeatAudit) {
    const totalDeleted = Object.values(counts)
      .filter((n) => n > 0)
      .reduce((sum, n) => sum + n, 0);

    try {
      const emitFn = opts._emitFn ?? enqueueAuditInWorkerTx;
      await workerPrisma.$transaction(async (tx) => {
        // Heartbeat runs in its own bypass_rls context (SYSTEM_TENANT_ID exists
        // by design; INV-C3c — the anchor is system-scoped, not subject to
        // per-tenant purge).
        await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
        await emitFn(tx, SYSTEM_TENANT_ID, {
          scope: AUDIT_SCOPE.TENANT,
          action: AUDIT_ACTION.RETENTION_GC_SWEEP,
          userId: SYSTEM_ACTOR_ID,
          actorType: ACTOR_TYPE.SYSTEM,
          serviceAccountId: null,
          teamId: null,
          targetType: null,
          targetId: null,
          metadata: {
            [AUDIT_METADATA_KEY.PURGED_COUNT]: totalDeleted,
            perTable: counts,
            sweepIntervalMs: opts.intervalMs,
          },
          ip: null,
          userAgent: "retention-gc-worker",
        });
      });
    } catch (err) {
      // Heartbeat failure is non-fatal. The per-entry log lines are the
      // authoritative record (INV-C4b). Log {code} only (S6).
      const code =
        (err as NodeJS.ErrnoException | undefined)?.code ?? "unknown";
      log.error({ code }, "retention-gc.heartbeat_failed");
    }
  }

  return counts;
}
