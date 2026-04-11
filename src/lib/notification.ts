/**
 * Server-side notification helpers.
 *
 * createNotification() is async nonblocking — it never throws and never blocks
 * the response. Follows the same fire-and-forget pattern as logAudit().
 *
 * Design rule: `body` and `metadata` must NEVER contain E2E-encrypted entry
 * content (titles, passwords, etc.). Only non-sensitive information is allowed:
 * timestamps, IP addresses, UA categories, action types, etc.
 */

import { prisma } from "@/lib/prisma";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import type { NotificationType } from "@prisma/client";
import { METADATA_BLOCKLIST } from "@/lib/audit-logger";
import { safeSet } from "@/lib/safe-keys";
import { NOTIFICATION_TITLE_MAX, NOTIFICATION_BODY_MAX } from "@/lib/validations/common";

export interface CreateNotificationParams {
  userId: string;
  tenantId?: string;
  type: NotificationType;
  title: string;
  body: string;
  metadata?: Record<string, unknown>;
}

/**
 * Sanitize notification metadata by removing sensitive keys.
 * Uses the same blocklist as audit log metadata sanitization.
 */
function sanitizeNotificationMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const cleaned: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(metadata)) {
    if (METADATA_BLOCKLIST.has(k)) continue;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const nested = sanitizeNotificationMetadata(v as Record<string, unknown>);
      if (nested) safeSet(cleaned, k, nested);
    } else {
      safeSet(cleaned, k, v);
    }
  }
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

/**
 * Create an in-app notification. Async nonblocking: errors are silently caught.
 * If tenantId is not provided, it will be resolved from the user record.
 */
export function createNotification(params: CreateNotificationParams): void {
  const { userId, tenantId, type, title, body, metadata } = params;

  const safeMetadata = sanitizeNotificationMetadata(metadata);

  void (async () => {
    await withBypassRls(prisma, async () => {
      let resolvedTenantId = tenantId ?? null;
      if (!resolvedTenantId) {
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { tenantId: true },
        });
        resolvedTenantId = user?.tenantId ?? null;
      }
      if (!resolvedTenantId) return;

      await prisma.notification.create({
        data: {
          userId,
          tenantId: resolvedTenantId,
          type,
          title: title.slice(0, NOTIFICATION_TITLE_MAX),
          body: body.slice(0, NOTIFICATION_BODY_MAX),
          metadata: (safeMetadata ?? undefined) as Parameters<typeof prisma.notification.create>[0]["data"]["metadata"],
        },
      });
    }, BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);
  })().catch(() => {
    // Silently swallow — notification creation must never break the app
  });
}
