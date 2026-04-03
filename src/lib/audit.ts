/**
 * Server-side audit logging helpers.
 *
 * logAudit() is async nonblocking — it never throws and never blocks the response.
 * Dual-write: PostgreSQL AuditLog table + structured JSON to stdout (via pino).
 * extractRequestMeta() extracts IP and User-Agent from NextRequest headers.
 */

import { prisma } from "@/lib/prisma";
import { auditLogger, METADATA_BLOCKLIST } from "@/lib/audit-logger";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { extractClientIp } from "@/lib/ip-access";
import { getLogger } from "@/lib/logger";
import { enqueue, drainBuffer, type BufferedAuditEntry } from "@/lib/audit-retry";
import type { AuditAction, AuditScope, ActorType } from "@prisma/client";
import type { NextRequest } from "next/server";
import type { AuthResult } from "@/lib/auth-or-token";
import { METADATA_MAX_BYTES, USER_AGENT_MAX_LENGTH } from "@/lib/validations/common.server";

/**
 * Audit actions that must NOT trigger webhook dispatch.
 * Prevents infinite loops: delivery failure → logAudit → dispatch → failure → ...
 */
const WEBHOOK_DISPATCH_SUPPRESS: ReadonlySet<AuditAction> = new Set<AuditAction>([
  "WEBHOOK_DELIVERY_FAILED" as AuditAction,
  "TENANT_WEBHOOK_DELIVERY_FAILED" as AuditAction,
]);

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
  const { scope, action, userId, actorType, serviceAccountId, tenantId, teamId, targetType, targetId, metadata, ip, userAgent } = params;

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

  const safeUserAgent = userAgent?.slice(0, USER_AGENT_MAX_LENGTH) ?? null;

  // --- Piggyback flush: drain buffered retry entries (fire-and-forget) ---
  void drainBuffer().catch(() => {});

  // --- DB write + webhook dispatch ---
  void (async () => {
    // Resolve tenantId inside transaction, then dispatch webhook after commit
    let resolvedTenantId: string | null = null;

    try {
      await withBypassRls(prisma, async () => {
        resolvedTenantId = tenantId ?? null;
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
            actorType: actorType ?? "HUMAN",
            serviceAccountId: serviceAccountId ?? null,
            tenantId: resolvedTenantId,
            teamId: teamId ?? null,
            targetType: targetType ?? null,
            targetId: targetId ?? null,
            metadata: safeMetadata as never ?? undefined,
            ip: ip ?? null,
            userAgent: safeUserAgent,
          },
        });
      }, BYPASS_PURPOSE.AUDIT_WRITE);
    } catch (err) {
      getLogger().error({ err }, "audit log write failed — enqueuing for retry");
      // Enqueue for retry if tenantId was resolved; otherwise cannot retry
      if (resolvedTenantId) {
        enqueue({
          scope,
          action,
          userId,
          actorType: actorType ?? "HUMAN",
          serviceAccountId: serviceAccountId ?? null,
          tenantId: resolvedTenantId,
          teamId: teamId ?? null,
          targetType: targetType ?? null,
          targetId: targetId ?? null,
          metadata: safeMetadata,
          ip: ip ?? null,
          userAgent: safeUserAgent,
          retryCount: 0,
        });
      }
      return; // Skip webhook dispatch on DB failure
    }

    // --- Webhook dispatch (after transaction commits) ---
    // Lazy import to break circular dependency: audit.ts ↔ webhook-dispatcher.ts
    if (resolvedTenantId && !WEBHOOK_DISPATCH_SUPPRESS.has(action)) {
      const { dispatchWebhook, dispatchTenantWebhook } = await import("@/lib/webhook-dispatcher");
      const webhookData = safeMetadata ?? {};
      const timestamp = new Date().toISOString();
      if (scope === "TEAM" && teamId) {
        void dispatchWebhook({ type: action, teamId, timestamp, data: webhookData });
      } else if (scope === "TENANT") {
        void dispatchTenantWebhook({ type: action, tenantId: resolvedTenantId, timestamp, data: webhookData });
      }
    }
  })();

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

  // --- Piggyback flush: drain buffered retry entries (fire-and-forget) ---
  void drainBuffer().catch(() => {});

  // --- DB write: resolve tenantId once, then createMany, then dispatch ---
  void (async () => {
    let resolvedTenantId: string | null = null;

    try {
      await withBypassRls(prisma, async () => {
        const first = paramsList[0];
        resolvedTenantId = first.tenantId ?? null;
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
              userAgent: p.userAgent?.slice(0, USER_AGENT_MAX_LENGTH) ?? null,
            };
          }),
        });
      }, BYPASS_PURPOSE.AUDIT_WRITE);
    } catch (err) {
      getLogger().error({ err }, "audit log batch write failed — enqueuing for retry");
      // Enqueue each entry individually for retry if tenantId was resolved
      if (resolvedTenantId) {
        for (const p of paramsList) {
          let safeMetadata: Record<string, unknown> | undefined;
          if (p.metadata) {
            const json = JSON.stringify(p.metadata);
            safeMetadata =
              json.length <= METADATA_MAX_BYTES
                ? p.metadata
                : { _truncated: true, _originalSize: json.length };
          }
          enqueue({
            scope: p.scope,
            action: p.action,
            userId: p.userId,
            actorType: p.actorType ?? "HUMAN",
            serviceAccountId: p.serviceAccountId ?? null,
            tenantId: resolvedTenantId,
            teamId: p.teamId ?? null,
            targetType: p.targetType ?? null,
            targetId: p.targetId ?? null,
            metadata: safeMetadata,
            ip: p.ip ?? null,
            userAgent: p.userAgent?.slice(0, USER_AGENT_MAX_LENGTH) ?? null,
            retryCount: 0,
          } satisfies BufferedAuditEntry);
        }
      }
      return; // Skip webhook dispatch on DB failure
    }

    // --- Webhook dispatch per entry (after transaction commits) ---
    // Lazy import to break circular dependency: audit.ts ↔ webhook-dispatcher.ts
    if (resolvedTenantId) {
      const { dispatchWebhook, dispatchTenantWebhook } = await import("@/lib/webhook-dispatcher");
      const timestamp = new Date().toISOString();
      for (const p of paramsList) {
        if (WEBHOOK_DISPATCH_SUPPRESS.has(p.action)) continue;
        let webhookMeta: Record<string, unknown> = {};
        if (p.metadata) {
          const json = JSON.stringify(p.metadata);
          webhookMeta = json.length <= METADATA_MAX_BYTES
            ? p.metadata
            : { _truncated: true, _originalSize: json.length };
        }
        if (p.scope === "TEAM" && p.teamId) {
          void dispatchWebhook({ type: p.action, teamId: p.teamId, timestamp, data: webhookMeta });
        } else if (p.scope === "TENANT" && resolvedTenantId) {
          void dispatchTenantWebhook({ type: p.action, tenantId: resolvedTenantId, timestamp, data: webhookMeta });
        }
      }
    }
  })();

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
