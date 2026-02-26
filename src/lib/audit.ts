/**
 * Server-side audit logging helpers.
 *
 * logAudit() is fire-and-forget — it never throws and never blocks the response.
 * Dual-write: PostgreSQL AuditLog table + structured JSON to stdout (via pino).
 * extractRequestMeta() extracts IP and User-Agent from NextRequest headers.
 */

import { prisma } from "@/lib/prisma";
import { auditLogger, METADATA_BLOCKLIST } from "@/lib/audit-logger";
import type { AuditAction, AuditScope } from "@prisma/client";
import type { NextRequest } from "next/server";

const METADATA_MAX_BYTES = 10_240; // 10 KB

export interface AuditLogParams {
  scope: AuditScope;
  action: AuditAction;
  userId: string;
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
 * Write an audit log entry. Fire-and-forget: errors are silently caught.
 *
 * Dual-write:
 * 1. PostgreSQL AuditLog table (existing, unchanged)
 * 2. Structured JSON to stdout via pino (for Fluent Bit forwarding)
 */
export function logAudit(params: AuditLogParams): void {
  const { scope, action, userId, teamId, targetType, targetId, metadata, ip, userAgent } = params;

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
  prisma.auditLog
    .create({
      data: {
        scope,
        action,
        userId,
        orgId: teamId ?? null,
        targetType: targetType ?? null,
        targetId: targetId ?? null,
        metadata: safeMetadata as never ?? undefined,
        ip: ip ?? null,
        userAgent: safeUserAgent,
      },
    })
    .catch(() => {
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
 * Extract IP address and User-Agent from a NextRequest.
 */
export function extractRequestMeta(req: NextRequest): {
  ip: string | null;
  userAgent: string | null;
} {
  const forwarded = req.headers.get("x-forwarded-for");
  const ip = forwarded
    ? forwarded.split(",")[0].trim()
    : req.headers.get("x-real-ip") ?? null;
  const userAgent = req.headers.get("user-agent");
  return { ip, userAgent };
}
