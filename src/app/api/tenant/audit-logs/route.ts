import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTenantPermission, TenantAuthError } from "@/lib/tenant-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { errorResponse, unauthorized, validationError } from "@/lib/api-response";
import {
  AUDIT_ACTION_GROUPS_TENANT,
  AUDIT_ACTION_VALUES,
  AUDIT_SCOPE,
} from "@/lib/constants";
import { TENANT_PERMISSION } from "@/lib/constants/tenant-permission";
import { withTenantRls } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/with-request-log";
import type { AuditAction } from "@prisma/client";

const VALID_ACTIONS: Set<string> = new Set(AUDIT_ACTION_VALUES);

// GET /api/tenant/audit-logs — Tenant-scoped audit logs (TENANT + TEAM scope, ADMIN/OWNER only)
async function handleGET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  let actor;
  try {
    actor = await requireTenantPermission(session.user.id, TENANT_PERMISSION.AUDIT_LOG_VIEW);
  } catch (e) {
    if (e instanceof TenantAuthError) {
      return errorResponse(e.message, e.status);
    }
    throw e;
  }

  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action");
  const actionsParam = searchParams.get("actions");
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const cursor = searchParams.get("cursor");
  const limitParam = searchParams.get("limit");
  const limit = Math.min(Math.max(parseInt(limitParam ?? "50", 10) || 50, 1), 100);

  const where: Record<string, unknown> = {
    scope: { in: [AUDIT_SCOPE.TENANT, AUDIT_SCOPE.TEAM] },
    tenantId: actor.tenantId,
  };

  if (actionsParam) {
    const requested = actionsParam.split(",").map((a) => a.trim()).filter(Boolean);
    const invalid = requested.filter((a) => !VALID_ACTIONS.has(a as AuditAction));
    if (invalid.length > 0) {
      return validationError({ actions: invalid });
    }
    where.action = { in: requested };
  } else if (action) {
    if (AUDIT_ACTION_GROUPS_TENANT[action]) {
      where.action = { in: AUDIT_ACTION_GROUPS_TENANT[action] };
    } else if (VALID_ACTIONS.has(action as AuditAction)) {
      where.action = action;
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
      user: log.user ? {
        id: log.user.id,
        name: log.user.name,
        email: log.user.email,
        image: log.user.image,
      } : null,
    })),
    nextCursor,
  });
}

export const GET = withRequestLog(handleGET);
