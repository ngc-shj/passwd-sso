/**
 * In-memory retry buffer for failed audit log DB writes.
 *
 * When logAudit() DB write fails, the entry is enqueued here instead of being
 * silently dropped. On each subsequent logAudit() call, buffered entries are
 * drained via fire-and-forget piggyback flush (no route handler latency impact).
 *
 * Bounded FIFO queue: max 100 entries. When full, oldest entry is moved to
 * dead-letter log and the new entry takes its place.
 *
 * Retry path performs DB write only — no webhook dispatch (prevents duplicates).
 */

import { prisma } from "@/lib/prisma";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { getLogger } from "@/lib/logger";
import { deadLetterLogger } from "@/lib/audit-logger";
import type { AuditScope, AuditAction, ActorType } from "@prisma/client";

const MAX_BUFFER_SIZE = 100;
const MAX_RETRIES = 3;
const DRAIN_BATCH_SIZE = 10;

export interface BufferedAuditEntry {
  scope: AuditScope;
  action: AuditAction;
  userId: string;
  actorType: ActorType;
  serviceAccountId: string | null;
  tenantId: string;
  teamId: string | null;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown> | undefined;
  ip: string | null;
  userAgent: string | null;
  retryCount: number;
}

const buffer: BufferedAuditEntry[] = [];

/** Current buffer length (for testing). */
export function bufferSize(): number {
  return buffer.length;
}

/** Clear all buffered entries (for testing only). */
export function clearBuffer(): void {
  buffer.length = 0;
}

/**
 * Enqueue a failed audit entry for retry.
 * If buffer is full, oldest entry is sent to dead-letter log.
 */
export function enqueue(entry: BufferedAuditEntry): void {
  if (buffer.length >= MAX_BUFFER_SIZE) {
    const dropped = buffer.shift()!;
    deadLetterLogger.warn(
      { auditEntry: dropped, reason: "buffer_overflow" },
      "audit.dead_letter",
    );
  }
  buffer.push(entry);
}

/**
 * Piggyback flush: drain up to DRAIN_BATCH_SIZE entries.
 * Called fire-and-forget from logAudit() — never blocks the caller.
 *
 * Each entry is retried individually. On 3rd failure, moved to dead-letter.
 */
export async function drainBuffer(): Promise<void> {
  const batch = buffer.splice(0, DRAIN_BATCH_SIZE);
  if (batch.length === 0) return;

  for (const entry of batch) {
    try {
      await withBypassRls(prisma, async () => {
        await prisma.auditLog.create({
          data: {
            scope: entry.scope,
            action: entry.action,
            userId: entry.userId,
            actorType: entry.actorType,
            serviceAccountId: entry.serviceAccountId,
            tenantId: entry.tenantId,
            teamId: entry.teamId,
            targetType: entry.targetType,
            targetId: entry.targetId,
            metadata: entry.metadata as never ?? undefined,
            ip: entry.ip,
            userAgent: entry.userAgent,
          },
        });
      }, BYPASS_PURPOSE.AUDIT_WRITE);
    } catch (err) {
      entry.retryCount++;
      if (entry.retryCount >= MAX_RETRIES) {
        deadLetterLogger.warn(
          { auditEntry: entry, reason: "max_retries_exceeded", error: String(err) },
          "audit.dead_letter",
        );
      } else {
        // Re-enqueue for next piggyback flush
        buffer.push(entry);
      }
      getLogger().warn(
        { err, retryCount: entry.retryCount },
        "audit retry failed",
      );
    }
  }
}
