import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTenantPermission } from "@/lib/auth/access/tenant-auth";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { errorResponse, handleAuthError, unauthorized, validationError } from "@/lib/http/api-response";
import { AUDIT_ACTION_GROUPS_TENANT, AUDIT_ACTION_GROUPS_TEAM, AUDIT_SCOPE, mergeActionGroups } from "@/lib/constants";
import { TENANT_PERMISSION } from "@/lib/constants/auth/tenant-permission";
import { withTenantRls } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/http/with-request-log";
import {
  VALID_ACTIONS,
  parseAuditLogParams,
  parseActorType,
  parseActorUserId,
  buildAuditLogDateFilter,
  buildAuditLogActionFilter,
  paginateResult,
  isValidCursorId,
} from "@/lib/audit/audit-query";
import { buildTenantAuditWhere, validateTenantAuditTeam } from "@/lib/audit/tenant-audit-filter";
import { fetchAuditUserMap } from "@/lib/audit/audit-user-lookup";

const MERGED_ACTION_GROUPS = mergeActionGroups(AUDIT_ACTION_GROUPS_TENANT, AUDIT_ACTION_GROUPS_TEAM);

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
    return handleAuthError(e);
  }

  const { searchParams } = new URL(req.url);
  const { action, actions, from, to, cursor, limit } = parseAuditLogParams(searchParams);
  if (!isValidCursorId(cursor)) {
    return errorResponse(API_ERROR.INVALID_CURSOR);
  }
  const scopeParam = searchParams.get("scope");
  const teamIdParam = searchParams.get("teamId");
  const validActorType = parseActorType(searchParams);
  const actorUser = parseActorUserId(searchParams);
  if ("invalid" in actorUser) {
    return validationError({ userId: "Invalid user id" });
  }

  // Validate teamId belongs to this tenant (prevent cross-tenant oracle)
  if (teamIdParam) {
    const teamOk = await withTenantRls(prisma, actor.tenantId, async (tx) =>
      validateTenantAuditTeam(tx, actor.tenantId, teamIdParam),
    );
    if (!teamOk) {
      return validationError({ teamId: "Team not found" });
    }
  }

  const where = buildTenantAuditWhere({
    tenantId: actor.tenantId,
    scope: scopeParam,
    teamId: teamIdParam,
    actorType: validActorType,
    userId: actorUser.userId,
  });

  // Select action groups map based on scope
  const groupsMap =
    scopeParam === AUDIT_SCOPE.TEAM
      ? AUDIT_ACTION_GROUPS_TEAM
      : scopeParam === AUDIT_SCOPE.TENANT
        ? AUDIT_ACTION_GROUPS_TENANT
        : MERGED_ACTION_GROUPS;

  try {
    const actionFilter = buildAuditLogActionFilter(
      { action, actions },
      VALID_ACTIONS,
      groupsMap,
    );
    if (actionFilter !== undefined) where.action = actionFilter;
  } catch (e) {
    return validationError(e as Record<string, unknown>);
  }

  const dateFilter = buildAuditLogDateFilter(from, to);
  if (dateFilter) where.createdAt = dateFilter;

  let logs;
  try {
    logs = await withTenantRls(prisma, actor.tenantId, async (tx) =>
      tx.auditLog.findMany({
        where,
        select: {
          id: true,
          scope: true,
          action: true,
          actorType: true,
          userId: true,
          serviceAccountId: true,
          targetType: true,
          targetId: true,
          metadata: true,
          ip: true,
          userAgent: true,
          createdAt: true,
          team: { select: { id: true, name: true } },
          serviceAccount: { select: { id: true, name: true } },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }),
    );
  } catch {
    return errorResponse(API_ERROR.INVALID_CURSOR);
  }

  const { items, nextCursor } = paginateResult(logs, limit);

  // Batch-lookup user display info
  const tenantUserMap = await fetchAuditUserMap(items.map((l) => l.userId));

  return NextResponse.json({
    items: items.map((log) => {
      const userInfo = log.userId ? (tenantUserMap.get(log.userId) ?? undefined) : undefined;
      return {
        id: log.id,
        scope: log.scope,
        action: log.action,
        actorType: log.actorType,
        userId: log.userId,
        serviceAccountId: log.serviceAccountId,
        targetType: log.targetType,
        targetId: log.targetId,
        metadata: log.metadata,
        ip: log.ip,
        userAgent: log.userAgent,
        createdAt: log.createdAt,
        user: userInfo
          ? { id: userInfo.id, name: userInfo.name, email: userInfo.email, image: userInfo.image }
          : null,
        team: log.team ? {
          id: log.team.id,
          name: log.team.name,
        } : null,
        serviceAccount: log.serviceAccount ? {
          id: log.serviceAccount.id,
          name: log.serviceAccount.name,
        } : null,
      };
    }),
    nextCursor,
  });
}

export const GET = withRequestLog(handleGET);
