/**
 * Server-side audit logging helpers.
 *
 * logAuditAsync() writes audit events. Awaitable, never throws.
 * userId must be a UUID (real user or ANONYMOUS_ACTOR_ID / SYSTEM_ACTOR_ID sentinel);
 * the direct-write-to-audit_logs path is removed — all application-emitted events flow through the outbox.
 * Dual-write: PostgreSQL audit_logs + structured JSON to stdout (via pino).
 * extractRequestMeta() extracts IP and User-Agent from NextRequest headers.
 */

import { prisma } from "@/lib/prisma";
import { auditLogger, METADATA_BLOCKLIST, deadLetterLogger } from "@/lib/audit-logger";
import { safeRecord } from "@/lib/safe-keys";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { extractClientIp } from "@/lib/ip-access";
import { ACTOR_TYPE, AUDIT_SCOPE } from "@/lib/constants/audit";
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
export { OUTBOX_BYPASS_AUDIT_ACTIONS, WEBHOOK_DISPATCH_SUPPRESS } from "@/lib/constants/audit";
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

// ─── AuditLogParams → AuditOutboxPayload mapping ─────────────────

export function buildOutboxPayload(params: AuditLogParams): AuditOutboxPayload {
  const safeMetadata = truncateMetadata(params.metadata);
  const sanitized = sanitizeMetadata(safeMetadata) as Record<string, unknown> | null | undefined;
  const actorType = params.actorType ?? ACTOR_TYPE.HUMAN;
  return {
    scope: params.scope,
    action: params.action,
    userId: params.userId,
    actorType,
    serviceAccountId: params.serviceAccountId ?? null,
    teamId: params.teamId ?? null,
    targetType: params.targetType ?? null,
    targetId: params.targetId ?? null,
    metadata: sanitized ?? null,
    ip: params.ip ?? null,
    userAgent: params.userAgent?.slice(0, USER_AGENT_MAX_LENGTH) ?? null,
  };
}

// ─── Tenant resolution helper ───────���────────────────────────────

/**
 * Resolve tenantId for a single entry that doesn't have one.
 * Falls back to user or team lookup.
 */
async function resolveTenantId(params: AuditLogParams): Promise<string | null> {
  if (params.tenantId) return params.tenantId;

  return withBypassRls(prisma, async () => {
    if (params.teamId) {
      const team = await prisma.team.findUnique({
        where: { id: params.teamId },
        select: { tenantId: true },
      });
      return team?.tenantId ?? null;
    }

    // Defense-in-depth: userId is typed as string, but sentinel UUIDs and
    // real user UUIDs must pass UUID_RE before hitting the DB lookup.
    if (UUID_RE.test(params.userId)) {
      const user = await prisma.user.findUnique({
        where: { id: params.userId },
        select: { tenantId: true },
      });
      return user?.tenantId ?? null;
    }

    return null;
  }, BYPASS_PURPOSE.AUDIT_WRITE);
}

// ─── logAuditInTx ────────────���───────────────────────────────────

/**
 * Write an audit log entry inside an existing Prisma transaction.
 * Provides F1 atomicity: business write ⇔ audit row in the same transaction.
 */
export async function logAuditInTx(
  tx: Prisma.TransactionClient,
  tenantId: string,
  params: AuditLogParams,
): Promise<void> {
  await enqueueAuditInTx(tx, tenantId, buildOutboxPayload(params));
}

// ─── logAuditAsync ──────────────────────────────────────────────

/** Minimal dead-letter payload — never includes raw metadata. */
function deadLetterEntry(params: AuditLogParams, reason: string, error?: string) {
  return {
    scope: params.scope,
    action: params.action,
    userId: params.userId,
    tenantId: params.tenantId ?? null,
    reason,
    ...(error != null && { error }),
  };
}

/**
 * Write an audit log entry via the outbox. Awaitable, never throws.
 *
 * 1. Emits structured JSON to auditLogger (synchronous, before outbox write).
 * 2. Enqueues the entry to the outbox (awaited).
 * 3. On any error, logs to deadLetterLogger — caller never needs try/catch.
 */
export async function logAuditAsync(params: AuditLogParams): Promise<void> {
  const payload = buildOutboxPayload(params);

  // Structured JSON emit FIRST (synchronous, never fails the caller)
  try {
    auditLogger.info(
      {
        audit: {
          scope: payload.scope,
          action: payload.action,
          userId: payload.userId,
          actorType: payload.actorType,
          serviceAccountId: payload.serviceAccountId,
          tenantId: params.tenantId ?? null,
          teamId: payload.teamId,
          targetType: payload.targetType,
          targetId: payload.targetId,
          metadata: payload.metadata,
          ip: payload.ip,
          userAgent: payload.userAgent,
        },
      },
      `audit.${payload.action}`,
    );
  } catch {
    // Never let forwarding break the app
  }

  // All errors caught (MF2: never throws)
  try {
    const tenantId = await resolveTenantId(params);
    if (!tenantId) {
      deadLetterLogger.warn(
        deadLetterEntry(params, "tenant_not_found"),
        "audit.dead_letter",
      );
      return;
    }

    await enqueueAudit(tenantId, payload);
  } catch (err) {
    deadLetterLogger.warn(
      deadLetterEntry(params, "logAuditAsync_failed", String(err)),
      "audit.dead_letter",
    );
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

// ─── Scope-specific audit helpers ────────────────────────────
//
// These builders fill in scope + extractRequestMeta so callers only pass
// the fields that vary (action, target, metadata). Omitting `scope` or
// `extractRequestMeta(req)` at a call site is a common mistake — these
// helpers make it impossible.

/** Build the invariant part of a PERSONAL-scope audit log payload. */
export function personalAuditBase(req: NextRequest, userId: string) {
  return { scope: AUDIT_SCOPE.PERSONAL, userId, ...extractRequestMeta(req) };
}

/** Build the invariant part of a TEAM-scope audit log payload. */
export function teamAuditBase(req: NextRequest, userId: string, teamId: string) {
  return { scope: AUDIT_SCOPE.TEAM, userId, teamId, ...extractRequestMeta(req) };
}

/** Build the invariant part of a TENANT-scope audit log payload. */
export function tenantAuditBase(req: NextRequest, userId: string, tenantId: string) {
  return { scope: AUDIT_SCOPE.TENANT, userId, tenantId, ...extractRequestMeta(req) };
}
