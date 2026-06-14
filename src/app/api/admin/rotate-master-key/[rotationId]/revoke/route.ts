/**
 * POST /api/admin/rotate-master-key/[rotationId]/revoke
 *
 * A04-4: master-key rotation dual-approval — phase 4 (revoke / cancel).
 *
 * Any qualified MAINTENANCE-scoped operator in the rotation's tenant can
 * cancel a pending or approved-but-not-executed rotation. Initiator
 * self-revoke is allowed (asymmetric with approve, which forbids self) —
 * cancellation is non-destructive and shrinking the destructive window is
 * preferred over enforcing strict separation on the cancel path.
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
import {
  REVOKE_ELIGIBILITY,
  computeRevokeEligibility,
} from "@/lib/admin-rotation/rotation-eligibility";
import { getLogger } from "@/lib/logger";
import { RATE_WINDOW_MS } from "@/lib/validations/common.server";

const rateLimiter = createRateLimiter({
  windowMs: RATE_WINDOW_MS,
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
    key: `rl:admin:rotate:revoke:${auth.subjectUserId}`,
    scope: "admin.rotate.revoke",
    userId: auth.subjectUserId,
    tenantId: auth.tenantId,
  });
  if (rlBlocked) return rlBlocked;

  // Optional `reason` body — gated on Content-Length because parseBody
  // (readJsonWithCap → JSON.parse("")) rejects empty bodies with INVALID_JSON,
  // and we MUST allow no-body POSTs for the "revoke with no reason" case.
  // The .strict() check is still enforced for any caller that sets Content-Length;
  // the only bypass surface is chunked-encoding clients that elide Content-Length,
  // and the schema only validates an optional string field — no destructive
  // surface (S6/F9: accepted with rationale, not fixed).
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

  const row = await withTenantRls(prisma, auth.tenantId, async (tx) =>
    tx.masterKeyRotation.findFirst({ where: { id: rotationId } }),
  );
  if (!row) return notFound();

  const eligibility = computeRevokeEligibility({
    actorTenantId: auth.tenantId,
    rotationTenantId: row.tenantId,
    executedAt: row.executedAt,
    revokedAt: row.revokedAt,
  });

  if (eligibility === REVOKE_ELIGIBILITY.CROSS_TENANT) {
    await logAuditAsync({
      ...tenantAuditBase(req, auth.subjectUserId, auth.tenantId),
      actorType: ACTOR_TYPE.HUMAN,
      action: AUDIT_ACTION.MASTER_KEY_ROTATION_REVOKE,
      metadata: {
        rotationId,
        targetVersion: row.targetVersion,
        cause: API_ERROR.FORBIDDEN_CROSS_TENANT,
      },
    });
    return errorResponse(API_ERROR.FORBIDDEN_CROSS_TENANT);
  }

  if (eligibility === REVOKE_ELIGIBILITY.ALREADY_TERMINAL) {
    return errorResponse(API_ERROR.ROTATION_NOT_EXECUTABLE);
  }

  const now = new Date();
  const casResult = await withTenantRls(prisma, auth.tenantId, async (tx) =>
    tx.masterKeyRotation.updateMany({
      where: {
        id: rotationId,
        tenantId: auth.tenantId,
        executedAt: null,
        revokedAt: null,
      },
      data: { revokedAt: now, revokedById: auth.subjectUserId },
    }),
  );

  if (casResult.count === 0) {
    getLogger().warn(
      {
        rotationId,
        actorSubjectId: auth.subjectUserId,
        actorTenantId: auth.tenantId,
        subCause: "race_or_terminal",
      },
      "master-key-rotation revoke: CAS lost",
    );
    return errorResponse(API_ERROR.ROTATION_NOT_EXECUTABLE);
  }

  const cause =
    row.initiatedById !== null && row.initiatedById === auth.subjectUserId
      ? "INITIATOR_SELF_REVOKE"
      : "SECOND_ACTOR_REVOKE";

  await logAuditAsync({
    ...tenantAuditBase(req, auth.subjectUserId, auth.tenantId),
    actorType: ACTOR_TYPE.HUMAN,
    action: AUDIT_ACTION.MASTER_KEY_ROTATION_REVOKE,
    metadata: {
      rotationId,
      targetVersion: row.targetVersion,
      cause,
      reason: reason ?? null,
    },
  });

  return NextResponse.json({ ok: true, status: "revoked" as const });
}

export const POST = withRequestLog(handlePOST);
