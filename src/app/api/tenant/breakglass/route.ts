import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTenantPermission, TenantAuthError } from "@/lib/tenant-auth";
import { TENANT_PERMISSION } from "@/lib/constants/tenant-permission";
import { GRANT_STATUS } from "@/lib/constants/breakglass";
import type { GrantStatus } from "@/lib/constants/breakglass";
import { withTenantRls } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/with-request-log";
import { BREAKGLASS_USER_LIST_LIMIT } from "@/lib/validations/common.server";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { assertOrigin } from "@/lib/csrf";
import { createRateLimiter } from "@/lib/rate-limit";
import { createNotification } from "@/lib/notification";
import { createBreakglassGrantSchema } from "@/lib/validations";
import { API_ERROR } from "@/lib/api-error-codes";
import { errorResponse, unauthorized, forbidden, rateLimited } from "@/lib/api-response";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
import { NOTIFICATION_TYPE } from "@/lib/constants/notification";

export const runtime = "nodejs";

const breakglassRateLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
});

// POST /api/tenant/breakglass — Create a break-glass personal log access grant
async function handlePOST(req: NextRequest) {
  const originError = assertOrigin(req);
  if (originError) return originError;

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
    if (err instanceof TenantAuthError) {
      return errorResponse(err.message, err.status);
    }
    throw err;
  }

  // Parse and validate request body
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(API_ERROR.VALIDATION_ERROR, 400);
  }

  const parsed = createBreakglassGrantSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(API_ERROR.VALIDATION_ERROR, 400, {
      details: parsed.error.flatten(),
    });
  }

  const { targetUserId, reason, incidentRef } = parsed.data;

  // Prevent self-access
  if (targetUserId === userId) {
    return errorResponse(API_ERROR.VALIDATION_ERROR, 400, {
      details: { targetUserId: ["Cannot request access to your own logs"] },
    });
  }

  // Rate limit: 5 per hour per admin
  const rlResult = await breakglassRateLimiter.check(
    `rl:breakglass:${userId}`,
  );
  if (!rlResult.allowed) {
    return rateLimited(rlResult.retryAfterMs);
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
    result = await withTenantRls(prisma, actor.tenantId, async () => {
      const member = await prisma.tenantMember.findFirst({
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
      const duplicate = await prisma.personalLogAccessGrant.findFirst({
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

      const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const grant = await prisma.personalLogAccessGrant.create({
        data: {
          tenantId: actor.tenantId,
          requesterId: userId,
          targetUserId,
          reason,
          incidentRef: incidentRef ?? null,
          expiresAt,
        },
      });

      return { status: "created" as const, grant, targetUser: member.user };
    });
  } catch {
    return errorResponse(API_ERROR.SERVICE_UNAVAILABLE, 500);
  }

  if (result.status === "no_member") {
    return forbidden();
  }

  if (result.status === "duplicate") {
    return errorResponse(API_ERROR.CONFLICT, 409);
  }

  const { grant, targetUser: targetMemberUser } = result;

  // Audit log (non-blocking)
  const { ip, userAgent } = extractRequestMeta(req);
  logAudit({
    scope: AUDIT_SCOPE.TENANT,
    action: AUDIT_ACTION.PERSONAL_LOG_ACCESS_REQUEST,
    userId,
    tenantId: actor.tenantId,
    targetType: "User",
    targetId: targetUserId,
    metadata: {
      targetUserId,
      targetUserEmail: targetMemberUser.email,
      reason,
      incidentRef: incidentRef ?? null,
      grantId: grant.id,
    },
    ip,
    userAgent,
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
    if (err instanceof TenantAuthError) {
      return errorResponse(err.message, err.status);
    }
    throw err;
  }

  const grants = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.personalLogAccessGrant.findMany({
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
