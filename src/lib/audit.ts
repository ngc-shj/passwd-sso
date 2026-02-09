/**
 * Server-side audit logging helpers.
 *
 * logAudit() is fire-and-forget — it never throws and never blocks the response.
 * extractRequestMeta() extracts IP and User-Agent from NextRequest headers.
 */

import { prisma } from "@/lib/prisma";
import type { AuditAction, AuditScope } from "@prisma/client";
import type { NextRequest } from "next/server";

const METADATA_MAX_BYTES = 10_240; // 10 KB

export interface AuditLogParams {
  scope: AuditScope;
  action: AuditAction;
  userId: string;
  orgId?: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Write an audit log entry. Fire-and-forget: errors are silently caught.
 */
export function logAudit(params: AuditLogParams): void {
  const { scope, action, userId, orgId, targetType, targetId, metadata, ip, userAgent } = params;

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

  prisma.auditLog
    .create({
      data: {
        scope,
        action,
        userId,
        orgId: orgId ?? null,
        targetType: targetType ?? null,
        targetId: targetId ?? null,
        metadata: safeMetadata as never ?? undefined,
        ip: ip ?? null,
        userAgent: userAgent?.slice(0, 512) ?? null,
      },
    })
    .catch(() => {
      // Silently swallow — audit logging must never break the app
    });
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
