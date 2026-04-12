/**
 * Server-side audit logging helpers.
 *
 * logAudit() is async nonblocking — it never throws and never blocks the response.
 * Dual-write: PostgreSQL AuditLog table (via outbox) + structured JSON to stdout (via pino).
 * extractRequestMeta() extracts IP and User-Agent from NextRequest headers.
 */

import { prisma } from "@/lib/prisma";
import { auditLogger, METADATA_BLOCKLIST, deadLetterLogger } from "@/lib/audit-logger";
import { safeRecord } from "@/lib/safe-keys";
import { tenantRlsStorage, getTenantRlsContext, withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { extractClientIp } from "@/lib/ip-access";
import { getLogger } from "@/lib/logger";
import { drainBuffer, bufferSize } from "@/lib/audit-retry";
import { AUDIT_OUTBOX, ACTOR_TYPE } from "@/lib/constants/audit";
import type { AuditAction, AuditScope, ActorType, Prisma } from "@prisma/client";
import type { NextRequest } from "next/server";
import type { AuthResult } from "@/lib/auth-or-token";
import { METADATA_MAX_BYTES, USER_AGENT_MAX_LENGTH } from "@/lib/validations/common.server";
import { enqueueAudit, enqueueAuditInTx, type AuditOutboxPayload } from "@/lib/audit-outbox";

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
import { UUID_RE } from "@/lib/constants/app";

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
      return ACTOR_TYPE.HUMAN;
    case "service_account":
      return ACTOR_TYPE.SERVICE_ACCOUNT;
    case "mcp_token":
      return ACTOR_TYPE.MCP_AGENT;
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

/**
 * Batch-resolve tenantIds for entries that don't have one.
 * Single DB round-trip per entity type instead of N+1.
 */
async function resolveTenantIds(
  entries: { params: AuditLogParams }[],
): Promise<Map<AuditLogParams, string | null>> {
  const result = new Map<AuditLogParams, string | null>();
  const needTeamLookup: string[] = [];
  const needUserLookup: string[] = [];

  for (const { params } of entries) {
    if (params.tenantId) {
      result.set(params, params.tenantId);
    } else if (params.teamId) {
      needTeamLookup.push(params.teamId);
    } else {
      needUserLookup.push(params.userId);
    }
  }

  if (needTeamLookup.length === 0 && needUserLookup.length === 0) return result;

  await withBypassRls(prisma, async () => {
    if (needTeamLookup.length > 0) {
      const uniqueTeamIds = [...new Set(needTeamLookup)];
      const teams = await prisma.team.findMany({
        where: { id: { in: uniqueTeamIds } },
        select: { id: true, tenantId: true },
      });
      const teamMap = new Map(teams.map((t) => [t.id, t.tenantId]));
      for (const { params } of entries) {
        if (!params.tenantId && params.teamId) {
          result.set(params, teamMap.get(params.teamId) ?? null);
        }
      }
    }

    if (needUserLookup.length > 0) {
      const uniqueUserIds = [...new Set(needUserLookup)];
      const users = await prisma.user.findMany({
        where: { id: { in: uniqueUserIds } },
        select: { id: true, tenantId: true },
      });
      const userMap = new Map(users.map((u) => [u.id, u.tenantId]));
      for (const { params } of entries) {
        if (!params.tenantId && !params.teamId) {
          result.set(params, userMap.get(params.userId) ?? null);
        }
      }
    }
  }, BYPASS_PURPOSE.AUDIT_WRITE);

  return result;
}

// ─── AuditLogParams → AuditOutboxPayload mapping ─────────────────

function buildOutboxPayload(params: AuditLogParams): AuditOutboxPayload {
  const safeMetadata = truncateMetadata(params.metadata);
  const sanitized = sanitizeMetadata(safeMetadata) as Record<string, unknown> | null | undefined;
  return {
    scope: params.scope,
    action: params.action,
    userId: params.userId,
    actorType: params.actorType ?? ACTOR_TYPE.HUMAN,
    serviceAccountId: params.serviceAccountId ?? null,
    teamId: params.teamId ?? null,
    targetType: params.targetType ?? null,
    targetId: params.targetId ?? null,
    metadata: sanitized ?? null,
    ip: params.ip ?? null,
    userAgent: params.userAgent?.slice(0, USER_AGENT_MAX_LENGTH) ?? null,
  };
}

// ─── FIFO flusher ────────────────────────────────────────────────

async function flushFifo(): Promise<void> {
  if (fifoQueue.length === 0) return;

  await tenantRlsStorage.run(undefined as never, async () => {
    const batch = fifoQueue.splice(0, 100);

    // Separate non-UUID userId entries (legacy direct-write path)
    const uuidEntries: typeof batch = [];
    for (const entry of batch) {
      if (!UUID_RE.test(entry.params.userId)) {
        // Non-UUID userId (e.g., "anonymous") bypasses the outbox
        const tenantId = entry.params.tenantId ?? null;
        if (!tenantId) {
          deadLetterLogger.warn(
            { auditEntry: entry.params, reason: "non_uuid_userId_no_tenantId" },
            "audit.dead_letter",
          );
          continue;
        }
        try {
          const p = buildOutboxPayload(entry.params);
          await withBypassRls(prisma, async () => {
            await prisma.auditLog.create({
              data: {
                scope: p.scope, action: p.action, userId: p.userId!,
                actorType: p.actorType, serviceAccountId: p.serviceAccountId,
                tenantId, teamId: p.teamId, targetType: p.targetType,
                targetId: p.targetId,
                metadata: (p.metadata as Prisma.InputJsonValue) ?? undefined,
                ip: p.ip, userAgent: p.userAgent,
              },
            });
          }, BYPASS_PURPOSE.AUDIT_WRITE);
        } catch (err) {
          getLogger().warn({ err }, "audit flusher: non-UUID direct write failed");
        }
      } else {
        uuidEntries.push(entry);
      }
    }

    if (uuidEntries.length === 0) return;

    // Batch-resolve tenantIds (1-2 queries instead of N)
    let tenantMap: Map<AuditLogParams, string | null>;
    try {
      tenantMap = await resolveTenantIds(uuidEntries);
    } catch (err) {
      getLogger().warn({ err }, "audit flusher: batch tenantId resolution failed");
      for (const entry of uuidEntries) fifoQueue.unshift(entry);
      return;
    }

    for (const entry of uuidEntries) {
      const { params } = entry;
      try {
        const tenantId = tenantMap.get(params) ?? null;
        if (!tenantId) {
          deadLetterLogger.warn(
            { auditEntry: params, reason: "tenant_not_found" },
            "audit.dead_letter",
          );
          continue;
        }

        await enqueueAudit(tenantId, buildOutboxPayload(params));
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
  // enqueueAuditInTx is a static import at the top of the file
  await enqueueAuditInTx(tx, tenantId, buildOutboxPayload(params));
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
          actorType: actorType ?? ACTOR_TYPE.HUMAN,
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

/** @internal Exposed for unit tests only. Clears the FIFO queue. */
export function _clearFifoForTest(): void {
  fifoQueue.length = 0;
}
