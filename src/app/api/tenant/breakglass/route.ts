import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTenantPermission } from "@/lib/auth/access/tenant-auth";
import { TENANT_PERMISSION } from "@/lib/constants/auth/tenant-permission";
import { GRANT_STATUS } from "@/lib/constants/integrations/breakglass";
import type { GrantStatus } from "@/lib/constants/integrations/breakglass";
import { withTenantRls } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/http/with-request-log";
import { BREAKGLASS_USER_LIST_LIMIT } from "@/lib/validations/common.server";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { SEC_PER_HOUR } from "@/lib/constants/time";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import { createNotification } from "@/lib/notification";
import { createBreakglassGrantSchema } from "@/lib/validations";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { errorResponse, forbidden, handleAuthError, unauthorized, validationError } from "@/lib/http/api-response";
import { requireRecentCurrentAuthMethod } from "@/lib/auth/session/recent-current-auth-method";
import { parseBody } from "@/lib/http/parse-body";
import { AUDIT_ACTION } from "@/lib/constants";
import { NOTIFICATION_TYPE } from "@/lib/constants/audit/notification";
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_SECOND } from "@/lib/constants/time";

export const runtime = "nodejs";

const breakglassRateLimiter = createRateLimiter({
  windowMs: MS_PER_HOUR,
  max: 5,
  failClosedOnRedisError: true,
});

// POST /api/tenant/breakglass — Create a break-glass personal log access grant
async function handlePOST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const userId = session.user.id;

  let actor;
  try {
    actor = await requireTenantPermission(
      userId,
      TENANT_PERMISSION.BREAKGLASS_REQUEST,
    );
  } catch (err) {
    return handleAuthError(err);
  }

  const stepUpError = await requireRecentCurrentAuthMethod(req);
  if (stepUpError) return stepUpError;

  // Rate limit BEFORE body parse so authenticated admins cannot trigger
  // body-parse memory allocation on every call before hitting the 5/hour cap.
  const blocked = await checkRateLimitOrFail({
    req,
    limiter: breakglassRateLimiter,
    key: `rl:breakglass:${userId}`,
    scope: "breakglass",
    userId,
    tenantId: actor.tenantId,
  });
  if (blocked) return blocked;

  // Parse and validate request body
  const bodyResult = await parseBody(req, createBreakglassGrantSchema);
  if (!bodyResult.ok) return bodyResult.response;
  const { targetUserId, reason, incidentRef } = bodyResult.data;

  // Prevent self-access
  if (targetUserId === userId) {
    return validationError({
      properties: { targetUserId: { errors: ["Cannot request access to your own logs"] } },
    });
  }

  // Verify target, check duplicate, and create grant in a single transaction
  // to prevent TOCTOU race conditions
  type CreatedGrant = {
    id: string;
    tenantId: string;
    requesterId: string;
    targetUserId: string;
    reason: string;
    incidentRef: string | null;
    expiresAt: Date;
    revokedAt: Date | null;
    createdAt: Date;
  };
  type GrantResult =
    | { status: "no_member" }
    | { status: "duplicate" }
    | { status: "created"; grant: CreatedGrant; targetUser: { id: string; name: string | null; email: string | null; image: string | null } };

  let result: GrantResult;
  try {
    result = await withTenantRls(prisma, actor.tenantId, async (tx) => {
      const member = await tx.tenantMember.findFirst({
        where: {
          userId: targetUserId,
          tenantId: actor.tenantId,
          deactivatedAt: null,
        },
        include: {
          user: { select: { id: true, name: true, email: true, image: true } },
        },
      });

      if (!member) return { status: "no_member" as const };

      const now = new Date();
      const duplicate = await tx.personalLogAccessGrant.findFirst({
        where: {
          requesterId: userId,
          targetUserId,
          tenantId: actor.tenantId,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        select: { id: true },
      });

      if (duplicate) return { status: "duplicate" as const };

      // C19 (OWASP A04-5): cooling-off — first grant for this
      // requester→target pair in the last 24h is deferred by
      // BREAKGLASS_COOLING_OFF_SECONDS (default 3600). Subsequent grants
      // in the same window are immediate (incident already underway).
      // Configurable env: BREAKGLASS_COOLING_OFF_SECONDS=0 disables.
      const coolingOffSecs = Number(
        process.env.BREAKGLASS_COOLING_OFF_SECONDS ?? String(SEC_PER_HOUR),
      );
      const recentGrant =
        coolingOffSecs > 0
          ? await tx.personalLogAccessGrant.findFirst({
              where: {
                requesterId: userId,
                targetUserId,
                tenantId: actor.tenantId,
                createdAt: { gt: new Date(now.getTime() - MS_PER_DAY) },
              },
              select: { id: true },
              orderBy: { createdAt: "desc" },
            })
          : null;
      const effectiveAt =
        coolingOffSecs > 0 && recentGrant === null
          ? new Date(now.getTime() + coolingOffSecs * MS_PER_SECOND)
          : null;

      const expiresAt = new Date(now.getTime() + MS_PER_DAY);
      const grant = await tx.personalLogAccessGrant.create({
        data: {
          tenantId: actor.tenantId,
          requesterId: userId,
          targetUserId,
          reason,
          incidentRef: incidentRef ?? null,
          expiresAt,
          effectiveAt,
        },
      });

      return { status: "created" as const, grant, targetUser: member.user };
    });
  } catch {
    return errorResponse(API_ERROR.SERVICE_UNAVAILABLE);
  }

  if (result.status === "no_member") {
    return forbidden();
  }

  if (result.status === "duplicate") {
    return errorResponse(API_ERROR.CONFLICT);
  }

  const { grant, targetUser: targetMemberUser } = result;

  // Audit log (non-blocking)
  await logAuditAsync({
    ...tenantAuditBase(req, userId, actor.tenantId),
    action: AUDIT_ACTION.PERSONAL_LOG_ACCESS_REQUEST,
    targetType: "User",
    targetId: targetUserId,
    metadata: {
      targetUserId,
      targetUserEmail: targetMemberUser.email,
      reason,
      incidentRef: incidentRef ?? null,
      grantId: grant.id,
    },
  });

  // Notify target user (non-blocking)
  const requesterName = session.user.name ?? session.user.email ?? userId;
  createNotification({
    userId: targetUserId,
    tenantId: actor.tenantId,
    type: NOTIFICATION_TYPE.PERSONAL_LOG_ACCESSED,
    title: "Personal log access granted",
    body: `${requesterName} has been granted access to your personal audit logs. Reason: ${reason}`,
    metadata: {
      grantId: grant.id,
      requesterId: userId,
      reason,
      incidentRef: incidentRef ?? null,
    },
  });

  return NextResponse.json(
    {
      id: grant.id,
      tenantId: grant.tenantId,
      requesterId: grant.requesterId,
      targetUserId: grant.targetUserId,
      reason: grant.reason,
      incidentRef: grant.incidentRef,
      expiresAt: grant.expiresAt,
      revokedAt: grant.revokedAt,
      createdAt: grant.createdAt,
      status: GRANT_STATUS.ACTIVE,
    },
    { status: 201 },
  );
}

// GET /api/tenant/breakglass — List all break-glass grants for the tenant
async function handleGET(_req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const userId = session.user.id;

  let actor;
  try {
    actor = await requireTenantPermission(
      userId,
      TENANT_PERMISSION.AUDIT_LOG_VIEW,
    );
  } catch (err) {
    return handleAuthError(err);
  }

  const grants = await withTenantRls(prisma, actor.tenantId, async (tx) =>
    tx.personalLogAccessGrant.findMany({
      where: { tenantId: actor.tenantId },
      include: {
        requester: { select: { id: true, name: true, email: true, image: true } },
        targetUser: { select: { id: true, name: true, email: true, image: true } },
      },
      orderBy: { createdAt: "desc" },
      take: BREAKGLASS_USER_LIST_LIMIT,
    }),
  );

  const now = new Date();

  return NextResponse.json({
    items: grants.map((grant) => {
      let status: GrantStatus;
      if (grant.revokedAt) {
        status = GRANT_STATUS.REVOKED;
      } else if (grant.expiresAt <= now) {
        status = GRANT_STATUS.EXPIRED;
      } else {
        status = GRANT_STATUS.ACTIVE;
      }

      return {
        id: grant.id,
        tenantId: grant.tenantId,
        requesterId: grant.requesterId,
        targetUserId: grant.targetUserId,
        reason: grant.reason,
        incidentRef: grant.incidentRef,
        expiresAt: grant.expiresAt,
        revokedAt: grant.revokedAt,
        createdAt: grant.createdAt,
        status,
        requester: grant.requester,
        targetUser: grant.targetUser,
      };
    }),
  });
}

export const POST = withRequestLog(handlePOST);
export const GET = withRequestLog(handleGET);
