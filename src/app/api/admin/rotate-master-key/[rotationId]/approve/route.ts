/**
 * POST /api/admin/rotate-master-key/[rotationId]/approve
 *
 * A04-4: master-key rotation dual-approval — phase 2 (approve).
 *
 * Second-admin approval. Self-approval and cross-tenant approval are blocked
 * at BOTH app-level (computeApproveEligibility) and DB CAS (load-bearing
 * `initiatedById: { not: actor.subjectUserId }` and `tenantId: actor.tenantId`).
 *
 * Body: { reason?: string }
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyAdminToken } from "@/lib/auth/tokens/admin-token";
import { prisma } from "@/lib/prisma";
import { parseBody } from "@/lib/http/parse-body";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION, ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { withTenantRls } from "@/lib/tenant-rls";
import { requireMaintenanceOperator } from "@/lib/auth/access/maintenance-auth";
import { withRequestLog } from "@/lib/http/with-request-log";
import {
  errorResponse,
  notFound,
  unauthorized,
} from "@/lib/http/api-response";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { EXECUTE_TTL_MS } from "@/lib/constants/time";
import {
  APPROVE_ELIGIBILITY,
  computeApproveEligibility,
} from "@/lib/admin-rotation/rotation-eligibility";
import { getLogger } from "@/lib/logger";

const rateLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 1,
  failClosedOnRedisError: true,
});

const bodySchema = z.object({ reason: z.string().trim().max(500).optional() }).strict();

async function handlePOST(
  req: NextRequest,
  { params }: { params: Promise<{ rotationId: string }> },
) {
  const authResult = await verifyAdminToken(req);
  if (!authResult.ok) return unauthorized();
  const { auth } = authResult;

  const { rotationId } = await params;

  const rlBlocked = await checkRateLimitOrFail({
    req,
    limiter: rateLimiter,
    key: `rl:admin:rotate:approve:${auth.subjectUserId}`,
    scope: "admin.rotate.approve",
    userId: auth.subjectUserId,
    tenantId: auth.tenantId,
  });
  if (rlBlocked) return rlBlocked;

  // Optional `reason` body — gated on Content-Length because parseBody
  // rejects empty bodies with INVALID_JSON, and we MUST allow no-body POSTs
  // for "approve without comment" (the most common case). See revoke route
  // for the matching pattern + the S6/F9 rationale.
  let reason: string | undefined;
  if (req.headers.get("content-length") && req.headers.get("content-length") !== "0") {
    const parsed = await parseBody(req, bodySchema);
    if (!parsed.ok) return parsed.response;
    reason = parsed.data.reason;
  }

  const op = await requireMaintenanceOperator(auth.subjectUserId, {
    tenantId: auth.tenantId,
  });
  if (!op.ok) return op.response;

  // Load via withTenantRls — RLS already filters by tenant; the helper still
  // returns null if rotation doesn't exist in this tenant (or at all).
  const row = await withTenantRls(prisma, auth.tenantId, async (tx) =>
    tx.masterKeyRotation.findFirst({ where: { id: rotationId } }),
  );
  if (!row) return notFound();

  const now = new Date();
  const eligibility = computeApproveEligibility({
    actorSubjectId: auth.subjectUserId,
    actorTenantId: auth.tenantId,
    initiatedById: row.initiatedById,
    rotationTenantId: row.tenantId,
    approvedAt: row.approvedAt,
    executedAt: row.executedAt,
    revokedAt: row.revokedAt,
    expiresAt: row.expiresAt,
    now,
  });

  if (eligibility === APPROVE_ELIGIBILITY.INITIATOR) {
    await logAuditAsync({
      ...tenantAuditBase(req, auth.subjectUserId, auth.tenantId),
      actorType: ACTOR_TYPE.HUMAN,
      action: AUDIT_ACTION.MASTER_KEY_ROTATION_APPROVE,
      metadata: {
        rotationId,
        targetVersion: row.targetVersion,
        cause: "FORBIDDEN_SELF_APPROVAL",
      },
    });
    return errorResponse(API_ERROR.FORBIDDEN_SELF_APPROVAL);
  }

  if (eligibility === APPROVE_ELIGIBILITY.CROSS_TENANT) {
    // Forensic-only — cross-tenant attempts may indicate a stolen token from
    // another tenant. The 403 response does not leak the row's tenant.
    await logAuditAsync({
      ...tenantAuditBase(req, auth.subjectUserId, auth.tenantId),
      actorType: ACTOR_TYPE.HUMAN,
      action: AUDIT_ACTION.MASTER_KEY_ROTATION_APPROVE,
      metadata: {
        rotationId,
        targetVersion: row.targetVersion,
        cause: "FORBIDDEN_CROSS_TENANT",
      },
    });
    return errorResponse(API_ERROR.FORBIDDEN_CROSS_TENANT);
  }

  if (eligibility === APPROVE_ELIGIBILITY.ALREADY_TERMINAL) {
    await logAuditAsync({
      ...tenantAuditBase(req, auth.subjectUserId, auth.tenantId),
      actorType: ACTOR_TYPE.HUMAN,
      action: AUDIT_ACTION.MASTER_KEY_ROTATION_APPROVE,
      metadata: {
        rotationId,
        targetVersion: row.targetVersion,
        cause: "RACE_LOST_OR_TERMINAL",
      },
    });
    return errorResponse(API_ERROR.ROTATION_NOT_EXECUTABLE);
  }

  // Narrow expiresAt to min(originalExpiresAt, now + EXECUTE_TTL_MS).
  const newExpiresAt = new Date(
    Math.min(row.expiresAt.getTime(), now.getTime() + EXECUTE_TTL_MS),
  );

  // CAS update — load-bearing self-approval + cross-tenant + state-machine guards.
  // `initiatedById: { not: ... }` only fires when the row has a non-null
  // initiator. The app-level eligibility check already handles null initiator
  // case by treating it as not-self.
  const casResult = await withTenantRls(prisma, auth.tenantId, async (tx) =>
    tx.masterKeyRotation.updateMany({
      where: {
        id: rotationId,
        tenantId: auth.tenantId,
        approvedAt: null,
        executedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
        initiatedById: { not: auth.subjectUserId },
      },
      data: {
        approvedAt: now,
        approvedById: auth.subjectUserId,
        expiresAt: newExpiresAt,
      },
    }),
  );

  if (casResult.count === 0) {
    // Operational sub-cause for forensics (NOT in audit metadata — S15).
    getLogger().warn(
      {
        rotationId,
        actorSubjectId: auth.subjectUserId,
        actorTenantId: auth.tenantId,
        subCause: "race_or_terminal",
      },
      "master-key-rotation approve: CAS lost",
    );
    await logAuditAsync({
      ...tenantAuditBase(req, auth.subjectUserId, auth.tenantId),
      actorType: ACTOR_TYPE.HUMAN,
      action: AUDIT_ACTION.MASTER_KEY_ROTATION_APPROVE,
      metadata: {
        rotationId,
        targetVersion: row.targetVersion,
        cause: "RACE_LOST_OR_TERMINAL",
      },
    });
    return errorResponse(API_ERROR.ROTATION_NOT_EXECUTABLE);
  }

  await logAuditAsync({
    ...tenantAuditBase(req, auth.subjectUserId, auth.tenantId),
    actorType: ACTOR_TYPE.HUMAN,
    action: AUDIT_ACTION.MASTER_KEY_ROTATION_APPROVE,
    metadata: {
      rotationId,
      targetVersion: row.targetVersion,
      initiatedById: row.initiatedById,
      newExpiresAt: newExpiresAt.toISOString(),
      reason: reason ?? null,
    },
  });

  return NextResponse.json({
    ok: true,
    status: "approved" as const,
    expiresAt: newExpiresAt.toISOString(),
  });
}

export const POST = withRequestLog(handlePOST);
