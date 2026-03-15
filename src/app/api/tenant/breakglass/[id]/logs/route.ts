import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTenantPermission, TenantAuthError } from "@/lib/tenant-auth";
import { TENANT_PERMISSION } from "@/lib/constants/tenant-permission";
import { withTenantRls } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/with-request-log";
import { extractRequestMeta } from "@/lib/audit";
import { API_ERROR } from "@/lib/api-error-codes";
import { errorResponse, unauthorized } from "@/lib/api-response";
import {
  AUDIT_ACTION,
  AUDIT_ACTION_GROUPS_PERSONAL,
  AUDIT_ACTION_VALUES,
  AUDIT_SCOPE,
} from "@/lib/constants";
import type { AuditAction, Prisma } from "@prisma/client";

export const runtime = "nodejs";

const VALID_ACTIONS: Set<string> = new Set(AUDIT_ACTION_VALUES);

// In-memory dedup maps (per-process, resets on restart — acceptable)
const viewAuditCache = new Map<string, number>(); // grantId -> last VIEW audit ts
const expireAuditCache = new Set<string>(); // grantId set — recorded once per grant
const VIEW_AUDIT_DEDUP_MS = 60 * 60 * 1000; // 1 hour

// GET /api/tenant/breakglass/[id]/logs — View target user's personal logs via active grant
async function handleGET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const userId = session.user.id;
  const { id: grantId } = await params;

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

  // Find grant — must belong to this tenant and be requested by the caller
  const grant = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.personalLogAccessGrant.findFirst({
      where: {
        id: grantId,
        tenantId: actor.tenantId,
        requesterId: userId,
      },
      include: {
        targetUser: { select: { id: true, name: true, email: true, image: true } },
      },
    }),
  );

  if (!grant) {
    return errorResponse(API_ERROR.NOT_FOUND, 404);
  }

  const now = new Date();

  // Check grant validity
  if (grant.revokedAt) {
    return errorResponse(API_ERROR.FORBIDDEN, 403, {
      details: { status: "revoked" },
    });
  }

  if (grant.expiresAt <= now) {
    // Lazily record PERSONAL_LOG_ACCESS_EXPIRE (once per grant, non-blocking)
    if (!expireAuditCache.has(grantId)) {
      void (async () => {
        try {
          await withTenantRls(prisma, actor.tenantId, async () =>
            prisma.auditLog.create({
              data: {
                scope: AUDIT_SCOPE.TENANT,
                action: AUDIT_ACTION.PERSONAL_LOG_ACCESS_EXPIRE,
                userId,
                tenantId: actor.tenantId,
                targetType: "User",
                targetId: grant.targetUserId,
                metadata: {
                  grantId,
                  targetUserId: grant.targetUserId,
                } as never,
                ip: null,
                userAgent: null,
              },
            }),
          );
          expireAuditCache.add(grantId);
        } catch {
          // Non-blocking — expiry is informational
        }
      })();
    }

    return errorResponse(API_ERROR.FORBIDDEN, 403, {
      details: { status: "expired" },
    });
  }

  // Verify target user is still an active tenant member
  const targetMember = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.tenantMember.findFirst({
      where: {
        userId: grant.targetUserId,
        tenantId: actor.tenantId,
        deactivatedAt: null,
      },
      select: { id: true },
    }),
  );

  if (!targetMember) {
    return errorResponse(API_ERROR.FORBIDDEN, 403, {
      details: { status: "target_deactivated" },
    });
  }

  // Non-repudiation: record PERSONAL_LOG_ACCESS_VIEW at most once per grant per hour
  // Blocking — failure returns 503 (Break-Glass requires non-repudiation)
  const lastViewTs = viewAuditCache.get(grantId) ?? 0;
  const { ip, userAgent } = extractRequestMeta(req);
  if (Date.now() - lastViewTs > VIEW_AUDIT_DEDUP_MS) {
    try {
      await withTenantRls(prisma, actor.tenantId, async () =>
        prisma.auditLog.create({
          data: {
            scope: AUDIT_SCOPE.TENANT,
            action: AUDIT_ACTION.PERSONAL_LOG_ACCESS_VIEW,
            userId,
            tenantId: actor.tenantId,
            targetType: "User",
            targetId: grant.targetUserId,
            metadata: {
              grantId,
              targetUserId: grant.targetUserId,
            } as never,
            ip: ip ?? null,
            userAgent: userAgent?.slice(0, 512) ?? null,
          },
        }),
      );
      viewAuditCache.set(grantId, Date.now());
    } catch {
      return errorResponse(API_ERROR.SERVICE_UNAVAILABLE, 503);
    }
  }

  // Parse pagination/filter query params (same shape as personal audit log API)
  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action");
  const actionsParam = searchParams.get("actions");
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const cursor = searchParams.get("cursor");
  const limitParam = searchParams.get("limit");
  const limit = Math.min(Math.max(parseInt(limitParam ?? "50", 10) || 50, 1), 100);

  const where: Prisma.AuditLogWhereInput = {
    userId: grant.targetUserId,
    scope: AUDIT_SCOPE.PERSONAL,
  };

  if (actionsParam) {
    const requested = actionsParam.split(",").map((a) => a.trim()).filter(Boolean);
    const invalid = requested.filter((a) => !VALID_ACTIONS.has(a as AuditAction));
    if (invalid.length > 0) {
      return errorResponse(API_ERROR.VALIDATION_ERROR, 400, {
        details: { actions: invalid },
      });
    }
    where.action = { in: requested as AuditAction[] };
  } else if (action) {
    if (AUDIT_ACTION_GROUPS_PERSONAL[action]) {
      where.action = { in: AUDIT_ACTION_GROUPS_PERSONAL[action] };
    } else if (VALID_ACTIONS.has(action)) {
      where.action = action as AuditAction;
    }
  }

  if (from || to) {
    const createdAt: Record<string, Date> = {};
    if (from) createdAt.gte = new Date(from);
    if (to) createdAt.lte = new Date(to);
    where.createdAt = createdAt;
  }

  let logs;
  try {
    logs = await withTenantRls(prisma, actor.tenantId, async () =>
      prisma.auditLog.findMany({
        where,
        include: {
          user: { select: { id: true, name: true, email: true, image: true } },
        },
        orderBy: { createdAt: "desc" },
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }),
    );
  } catch {
    return errorResponse(API_ERROR.INVALID_CURSOR, 400);
  }

  const hasMore = logs.length > limit;
  const items = hasMore ? logs.slice(0, limit) : logs;
  const nextCursor = hasMore ? items[items.length - 1].id : null;

  return NextResponse.json({
    items: items.map((log) => ({
      id: log.id,
      action: log.action,
      targetType: log.targetType,
      targetId: log.targetId,
      metadata: log.metadata,
      ip: log.ip,
      userAgent: log.userAgent,
      createdAt: log.createdAt,
      user: log.user
        ? {
            id: log.user.id,
            name: log.user.name,
            email: log.user.email,
            image: log.user.image,
          }
        : null,
    })),
    nextCursor,
    // No entryOverviews — admin cannot decrypt the target user's vault
    grant: {
      grantId: grant.id,
      targetUser: grant.targetUser,
      expiresAt: grant.expiresAt,
    },
  });
}

export const GET = withRequestLog(handleGET);
