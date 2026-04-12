/**
 * Server-side audit logging helpers.
 *
 * logAudit() is async nonblocking — it never throws and never blocks the response.
 * Dual-write: PostgreSQL AuditLog table (via outbox) + structured JSON to stdout (via pino).
 * extractRequestMeta() extracts IP and User-Agent from NextRequest headers.
 */

import { prisma } from "@/lib/prisma";
import { auditLogger, METADATA_BLOCKLIST } from "@/lib/audit-logger";
import { deadLetterLogger } from "@/lib/audit-logger";
import { safeRecord } from "@/lib/safe-keys";
import { tenantRlsStorage, getTenantRlsContext } from "@/lib/tenant-rls";
import { extractClientIp } from "@/lib/ip-access";
import { getLogger } from "@/lib/logger";
import { drainBuffer, bufferSize } from "@/lib/audit-retry";
import { AUDIT_OUTBOX } from "@/lib/constants/audit";
import type { AuditAction, AuditScope, ActorType, Prisma } from "@prisma/client";
import type { NextRequest } from "next/server";
import type { AuthResult } from "@/lib/auth-or-token";
import { METADATA_MAX_BYTES, USER_AGENT_MAX_LENGTH } from "@/lib/validations/common.server";
import type { AuditOutboxPayload } from "@/lib/audit-outbox";

/** Truncate metadata to fit METADATA_MAX_BYTES, preserving the original if within limits. */
function truncateMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const json = JSON.stringify(metadata);
  return json.length <= METADATA_MAX_BYTES
    ? metadata
    : { _truncated: true, _originalSize: json.length };
}

// Re-export from constants for backward compatibility
export { OUTBOX_BYPASS_AUDIT_ACTIONS } from "@/lib/constants/audit";

export interface AuditLogParams {
  scope: AuditScope;
  action: AuditAction;
  userId: string;
  actorType?: ActorType;
  serviceAccountId?: string | null;
  tenantId?: string;
  teamId?: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}

/** Infer ActorType from an AuthResult. */
export function resolveActorType(auth: AuthResult): ActorType {
  switch (auth.type) {
    case "session":
    case "token":
    case "api_key":
      return "HUMAN";
    case "service_account":
      return "SERVICE_ACCOUNT";
    case "mcp_token":
      return "MCP_AGENT";
  }
}

/**
 * Recursively sanitize metadata for external forwarding.
 * Removes any keys in METADATA_BLOCKLIST at any depth,
 * including inside nested objects and arrays.
 */
export function sanitizeMetadata(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map(sanitizeMetadata).filter((v) => v !== undefined);
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const entries: [string, unknown][] = [];
    for (const [k, v] of Object.entries(obj)) {
      if (!METADATA_BLOCKLIST.has(k)) {
        const sanitized = sanitizeMetadata(v);
        if (sanitized !== undefined) {
          entries.push([k, sanitized]);
        }
      }
    }
    if (entries.length === 0) return undefined;
    return safeRecord(entries);
  }
  return value;
}

// ─── Process-local FIFO queue ────────────────────────────────────

interface FifoEntry {
  params: AuditLogParams;
  retryCount: number;
}

const fifoQueue: FifoEntry[] = [];

function pushToFifo(params: AuditLogParams): void {
  if (fifoQueue.length >= AUDIT_OUTBOX.FIFO_MAX_SIZE) {
    const dropped = fifoQueue.shift();
    if (dropped) {
      deadLetterLogger.warn(
        { auditEntry: dropped.params, reason: "fifo_overflow" },
        "audit.dead_letter",
      );
    }
  }
  fifoQueue.push({ params, retryCount: 0 });
}

// ─── Tenant resolution helper ────────────────────────────────────

async function resolveTenantId(params: AuditLogParams): Promise<string | null> {
  let resolvedTenantId: string | null = params.tenantId ?? null;
  if (!resolvedTenantId && params.teamId) {
    const team = await prisma.team.findUnique({
      where: { id: params.teamId },
      select: { tenantId: true },
    });
    resolvedTenantId = team?.tenantId ?? null;
  }
  if (!resolvedTenantId) {
    const user = await prisma.user.findUnique({
      where: { id: params.userId },
      select: { tenantId: true },
    });
    resolvedTenantId = user?.tenantId ?? null;
  }
  return resolvedTenantId;
}

// ─── FIFO flusher ────────────────────────────────────────────────

async function flushFifo(): Promise<void> {
  if (fifoQueue.length === 0) return;

  await tenantRlsStorage.run(undefined as never, async () => {
    const batch = fifoQueue.splice(0, 100);
    for (const entry of batch) {
      const { params } = entry;
      try {
        const safeMetadata = truncateMetadata(params.metadata);
        const sanitized = sanitizeMetadata(safeMetadata) as Record<string, unknown> | null | undefined;

        let tenantId: string | null = null;
        try {
          tenantId = await resolveTenantId(params);
        } catch (err) {
          getLogger().warn({ err }, "audit flusher: tenantId resolution failed");
        }

        if (!tenantId) {
          deadLetterLogger.warn(
            { auditEntry: params, reason: "tenant_not_found" },
            "audit.dead_letter",
          );
          continue;
        }

        const payload: AuditOutboxPayload = {
          scope: params.scope,
          action: params.action,
          userId: params.userId,
          actorType: params.actorType ?? "HUMAN",
          serviceAccountId: params.serviceAccountId ?? null,
          teamId: params.teamId ?? null,
          targetType: params.targetType ?? null,
          targetId: params.targetId ?? null,
          metadata: sanitized ?? null,
          ip: params.ip ?? null,
          userAgent: params.userAgent?.slice(0, USER_AGENT_MAX_LENGTH) ?? null,
        };

        const { enqueueAudit } = await import("@/lib/audit-outbox");
        await enqueueAudit(tenantId, payload);
      } catch (err) {
        entry.retryCount++;
        if (entry.retryCount >= AUDIT_OUTBOX.FIFO_MAX_RETRIES) {
          deadLetterLogger.warn(
            { auditEntry: params, reason: "max_retries_exceeded", error: String(err) },
            "audit.dead_letter",
          );
        } else {
          fifoQueue.unshift(entry);
        }
        getLogger().warn({ err, retryCount: entry.retryCount }, "audit fifo flush failed");
      }
    }
  });
}

const flusherInterval = setInterval(() => {
  void flushFifo().catch(() => {});
}, AUDIT_OUTBOX.FLUSH_INTERVAL_MS);

if (typeof flusherInterval.unref === "function") {
  flusherInterval.unref();
}

async function flushWithTimeout(timeoutMs: number): Promise<void> {
  await Promise.race([
    flushFifo(),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

process.on("SIGTERM", () => {
  void flushWithTimeout(5000).finally(() => process.exit(0));
});

process.on("SIGINT", () => {
  void flushWithTimeout(5000).finally(() => process.exit(0));
});

process.on("beforeExit", () => {
  void flushFifo().catch(() => {});
});

// ─── logAuditInTx ────────────────────────────────────────────────

/**
 * Write an audit log entry inside an existing Prisma transaction.
 * Provides F1 atomicity: business write ⇔ audit row in the same transaction.
 */
export async function logAuditInTx(
  tx: Prisma.TransactionClient,
  tenantId: string,
  params: AuditLogParams,
): Promise<void> {
  const safeMetadata = truncateMetadata(params.metadata);
  const sanitized = sanitizeMetadata(safeMetadata) as Record<string, unknown> | null | undefined;
  const safeUserAgent = params.userAgent?.slice(0, USER_AGENT_MAX_LENGTH) ?? null;

  const payload: AuditOutboxPayload = {
    scope: params.scope,
    action: params.action,
    userId: params.userId,
    actorType: params.actorType ?? "HUMAN",
    serviceAccountId: params.serviceAccountId ?? null,
    teamId: params.teamId ?? null,
    targetType: params.targetType ?? null,
    targetId: params.targetId ?? null,
    metadata: sanitized ?? null,
    ip: params.ip ?? null,
    userAgent: safeUserAgent,
  };

  const { enqueueAuditInTx } = await import("@/lib/audit-outbox");
  await enqueueAuditInTx(tx, tenantId, payload);
}

// ─── logAudit ────────────────────────────────────────────────────

/**
 * Write an audit log entry. Async nonblocking: errors are silently caught.
 *
 * @deprecated Use logAuditInTx(tx, tenantId, params) for atomicity guarantees.
 * logAudit() enqueues to a process-local FIFO and writes to the outbox
 * asynchronously via a background flusher. There is NO atomicity guarantee
 * between the business write and the audit row.
 */
export function logAudit(params: AuditLogParams): void {
  const { scope, action, userId, actorType, serviceAccountId, tenantId, teamId, targetType, targetId, metadata, ip, userAgent } = params;

  if (getTenantRlsContext()) {
    getLogger().warn(
      { action, scope },
      "logAudit() called inside withTenantRls/withBypassRls — prefer logAuditInTx for atomicity",
    );
  }

  const safeMetadata = truncateMetadata(metadata);
  const safeUserAgent = userAgent?.slice(0, USER_AGENT_MAX_LENGTH) ?? null;

  // --- Piggyback flush: drain buffered retry entries (fire-and-forget) ---
  if (bufferSize() > 0) void drainBuffer().catch(() => {});

  // --- Push to FIFO for background outbox enqueue ---
  pushToFifo({
    scope,
    action,
    userId,
    actorType,
    serviceAccountId,
    tenantId,
    teamId,
    targetType,
    targetId,
    metadata: safeMetadata,
    ip,
    userAgent: safeUserAgent,
  });

  // --- Structured JSON emit for external forwarding ---
  // auditLogger.enabled is false when AUDIT_LOG_FORWARD !== "true",
  // so pino short-circuits internally (no I/O).
  try {
    auditLogger.info(
      {
        audit: {
          scope,
          action,
          userId,
          actorType: actorType ?? "HUMAN",
          serviceAccountId: serviceAccountId ?? null,
          teamId: teamId ?? null,
          targetType: targetType ?? null,
          targetId: targetId ?? null,
          metadata: sanitizeMetadata(safeMetadata),
          ip: ip ?? null,
          userAgent: safeUserAgent,
        },
      },
      `audit.${action}`,
    );
  } catch {
    // Never let forwarding break the app
  }
}

// ─── logAuditBatch ───────────────────────────────────────────────

/**
 * Write multiple audit log entries.
 * Async nonblocking: errors are silently caught.
 *
 * @deprecated Use logAuditInTx(tx, tenantId, params) per entry for atomicity guarantees.
 */
export function logAuditBatch(paramsList: AuditLogParams[]): void {
  if (paramsList.length === 0) return;

  // --- Piggyback flush: drain buffered retry entries (fire-and-forget) ---
  if (bufferSize() > 0) void drainBuffer().catch(() => {});

  for (const params of paramsList) {
    const safeMetadata = truncateMetadata(params.metadata);
    const safeUserAgent = params.userAgent?.slice(0, USER_AGENT_MAX_LENGTH) ?? null;

    pushToFifo({
      scope: params.scope,
      action: params.action,
      userId: params.userId,
      actorType: params.actorType,
      serviceAccountId: params.serviceAccountId,
      tenantId: params.tenantId,
      teamId: params.teamId,
      targetType: params.targetType,
      targetId: params.targetId,
      metadata: safeMetadata,
      ip: params.ip,
      userAgent: safeUserAgent,
    });
  }

  // --- Structured JSON emit per entry for external forwarding ---
  for (const p of paramsList) {
    const safeUserAgent = p.userAgent?.slice(0, USER_AGENT_MAX_LENGTH) ?? null;
    try {
      auditLogger.info(
        {
          audit: {
            scope: p.scope,
            action: p.action,
            userId: p.userId,
            teamId: p.teamId ?? null,
            targetType: p.targetType ?? null,
            targetId: p.targetId ?? null,
            metadata: sanitizeMetadata(truncateMetadata(p.metadata)),
            ip: p.ip ?? null,
            userAgent: safeUserAgent,
          },
        },
        `audit.${p.action}`,
      );
    } catch {
      // Never let forwarding break the app
    }
  }
}

// ─── extractRequestMeta ──────────────────────────────────────────

/**
 * Extract IP address, User-Agent, and Accept-Language from a NextRequest.
 */
export function extractRequestMeta(req: NextRequest): {
  ip: string | null;
  userAgent: string | null;
  acceptLanguage: string | null;
} {
  const ip = extractClientIp(req);
  const userAgent = req.headers.get("user-agent");
  const acceptLanguage = req.headers.get("accept-language");
  return { ip, userAgent, acceptLanguage };
}

// ─── Test helpers (tree-shaken in production via dead-code elimination) ───────

/** @internal Exposed for unit tests only. Returns the current FIFO queue length. */
export function _getFifoSize(): number {
  return fifoQueue.length;
}

/** @internal Exposed for unit tests only. Manually triggers a FIFO flush. */
export async function _flushFifoForTest(): Promise<void> {
  await flushFifo();
}
