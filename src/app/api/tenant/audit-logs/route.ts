import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTenantPermission, TenantAuthError } from "@/lib/tenant-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { errorResponse, unauthorized, validationError } from "@/lib/api-response";
import { AUDIT_ACTION_GROUPS_TENANT, AUDIT_SCOPE } from "@/lib/constants";
import { TENANT_PERMISSION } from "@/lib/constants/tenant-permission";
import { withTenantRls } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/with-request-log";
import {
  VALID_ACTIONS,
  parseAuditLogParams,
  buildAuditLogDateFilter,
  buildAuditLogActionFilter,
  paginateResult,
} from "@/lib/audit-query";

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
  const { action, actions, from, to, cursor, limit } = parseAuditLogParams(searchParams);
  const scopeParam = searchParams.get("scope");
  const teamIdParam = searchParams.get("teamId");

  const where: Record<string, unknown> = {
    tenantId: actor.tenantId,
  };

  // Scope filter: "TENANT" only, "TEAM" only (optionally with teamId), or both (default)
  if (scopeParam === AUDIT_SCOPE.TENANT) {
    where.scope = AUDIT_SCOPE.TENANT;
  } else if (scopeParam === AUDIT_SCOPE.TEAM) {
    where.scope = AUDIT_SCOPE.TEAM;
    if (teamIdParam) where.teamId = teamIdParam;
  } else {
    where.scope = { in: [AUDIT_SCOPE.TENANT, AUDIT_SCOPE.TEAM] };
    if (teamIdParam) where.teamId = teamIdParam;
  }

  try {
    const actionFilter = buildAuditLogActionFilter(
      { action, actions },
      VALID_ACTIONS,
      AUDIT_ACTION_GROUPS_TENANT,
    );
    if (actionFilter !== undefined) where.action = actionFilter;
  } catch (e) {
    return validationError(e as Record<string, unknown>);
  }

  const dateFilter = buildAuditLogDateFilter(from, to);
  if (dateFilter) where.createdAt = dateFilter;

  let logs;
  try {
    logs = await withTenantRls(prisma, actor.tenantId, async () =>
      prisma.auditLog.findMany({
        where,
        include: {
          user: { select: { id: true, name: true, email: true, image: true } },
          team: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: "desc" },
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }),
    );
  } catch {
    return errorResponse(API_ERROR.INVALID_CURSOR, 400);
  }

  const { items, nextCursor } = paginateResult(logs, limit);

  return NextResponse.json({
    items: items.map((log) => ({
      id: log.id,
      scope: log.scope,
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
      team: log.team ? {
        id: log.team.id,
        name: log.team.name,
      } : null,
    })),
    nextCursor,
  });
}

export const GET = withRequestLog(handleGET);
