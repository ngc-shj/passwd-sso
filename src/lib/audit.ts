/**
 * Server-side audit logging helpers.
 *
 * logAudit() is async nonblocking — it never throws and never blocks the response.
 * Dual-write: PostgreSQL AuditLog table + structured JSON to stdout (via pino).
 * extractRequestMeta() extracts IP and User-Agent from NextRequest headers.
 */

import { prisma } from "@/lib/prisma";
import { auditLogger, METADATA_BLOCKLIST } from "@/lib/audit-logger";
import { withBypassRls } from "@/lib/tenant-rls";
import { extractClientIp } from "@/lib/ip-access";
import type { AuditAction, AuditScope } from "@prisma/client";
import type { NextRequest } from "next/server";

const METADATA_MAX_BYTES = 10_240; // 10 KB

export interface AuditLogParams {
  scope: AuditScope;
  action: AuditAction;
  userId: string;
  tenantId?: string;
  teamId?: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
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
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (!METADATA_BLOCKLIST.has(k)) {
        const sanitized = sanitizeMetadata(v);
        if (sanitized !== undefined) {
          cleaned[k] = sanitized;
        }
      }
    }
    return Object.keys(cleaned).length > 0 ? cleaned : undefined;
  }
  return value;
}

/**
 * Write an audit log entry. Async nonblocking: errors are silently caught.
 *
 * Dual-write:
 * 1. PostgreSQL AuditLog table (existing, unchanged)
 * 2. Structured JSON to stdout via pino (for Fluent Bit forwarding)
 */
export function logAudit(params: AuditLogParams): void {
  const { scope, action, userId, tenantId, teamId, targetType, targetId, metadata, ip, userAgent } = params;

  // Truncate metadata if too large
  let safeMetadata: Record<string, unknown> | undefined;
  if (metadata) {
    const json = JSON.stringify(metadata);
    if (json.length <= METADATA_MAX_BYTES) {
      safeMetadata = metadata;
    } else {
      safeMetadata = { _truncated: true, _originalSize: json.length };
    }
  }

  const safeUserAgent = userAgent?.slice(0, 512) ?? null;

  // --- DB write (existing, unchanged) ---
  void (async () => {
    await withBypassRls(prisma, async () => {
      let resolvedTenantId = tenantId ?? null;
      if (!resolvedTenantId && teamId) {
        const team = await prisma.team.findUnique({
          where: { id: teamId },
          select: { tenantId: true },
        });
        resolvedTenantId = team?.tenantId ?? null;
      }
      if (!resolvedTenantId) {
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { tenantId: true },
        });
        resolvedTenantId = user?.tenantId ?? null;
      }
      if (!resolvedTenantId) return;

      await prisma.auditLog.create({
        data: {
          scope,
          action,
          userId,
          tenantId: resolvedTenantId,
          teamId: teamId ?? null,
          targetType: targetType ?? null,
          targetId: targetId ?? null,
          metadata: safeMetadata as never ?? undefined,
          ip: ip ?? null,
          userAgent: safeUserAgent,
        },
      });
    });
  })().catch(() => {
    // Silently swallow — audit logging must never break the app
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

/**
 * Write multiple audit log entries in a single DB round-trip.
 * Async nonblocking: errors are silently caught.
 *
 * **Contract**: All entries in `paramsList` must share the same `userId` and
 * `teamId` (if set). tenantId is resolved once from the first entry and applied
 * to the entire batch. Mixing different users/teams in a single batch will
 * produce incorrect tenantId assignments.
 *
 * Optimization over calling logAudit() in a loop:
 * - tenantId resolved once (not per entry)
 * - single withBypassRls call wrapping one createMany (not N create calls)
 * - pino emit still happens per entry (no behavioral change for log forwarding)
 */
export function logAuditBatch(paramsList: AuditLogParams[]): void {
  if (paramsList.length === 0) return;

  // --- DB write: resolve tenantId once, then createMany ---
  void (async () => {
    await withBypassRls(prisma, async () => {
      const first = paramsList[0];
      let resolvedTenantId = first.tenantId ?? null;
      if (!resolvedTenantId && first.teamId) {
        const team = await prisma.team.findUnique({
          where: { id: first.teamId },
          select: { tenantId: true },
        });
        resolvedTenantId = team?.tenantId ?? null;
      }
      if (!resolvedTenantId) {
        const user = await prisma.user.findUnique({
          where: { id: first.userId },
          select: { tenantId: true },
        });
        resolvedTenantId = user?.tenantId ?? null;
      }
      if (!resolvedTenantId) return;

      await prisma.auditLog.createMany({
        data: paramsList.map((p) => {
          let safeMetadata: Record<string, unknown> | undefined;
          if (p.metadata) {
            const json = JSON.stringify(p.metadata);
            safeMetadata =
              json.length <= METADATA_MAX_BYTES
                ? p.metadata
                : { _truncated: true, _originalSize: json.length };
          }
          return {
            scope: p.scope,
            action: p.action,
            userId: p.userId,
            tenantId: resolvedTenantId!,
            teamId: p.teamId ?? null,
            targetType: p.targetType ?? null,
            targetId: p.targetId ?? null,
            metadata: safeMetadata as never ?? undefined,
            ip: p.ip ?? null,
            userAgent: p.userAgent?.slice(0, 512) ?? null,
          };
        }),
      });
    });
  })().catch(() => {
    // Silently swallow — audit logging must never break the app
  });

  // --- Structured JSON emit per entry for external forwarding ---
  for (const p of paramsList) {
    let safeMetadata: Record<string, unknown> | undefined;
    if (p.metadata) {
      const json = JSON.stringify(p.metadata);
      safeMetadata =
        json.length <= METADATA_MAX_BYTES
          ? p.metadata
          : { _truncated: true, _originalSize: json.length };
    }
    const safeUserAgent = p.userAgent?.slice(0, 512) ?? null;
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
            metadata: sanitizeMetadata(safeMetadata),
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
