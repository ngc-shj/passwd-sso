import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTeamPermission, TeamAuthError } from "@/lib/team-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import {
  TEAM_PERMISSION,
  AUDIT_SCOPE,
  AUDIT_ACTION_GROUPS_TEAM,
  AUDIT_TARGET_TYPE,
} from "@/lib/constants";
import { withTeamTenantRls } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/with-request-log";
import { errorResponse, unauthorized } from "@/lib/api-response";
import {
  VALID_ACTIONS,
  parseAuditLogParams,
  parseActorType,
  buildAuditLogActionFilter,
  buildAuditLogDateFilter,
  paginateResult,
  isValidCursorId,
} from "@/lib/audit-query";

type Params = { params: Promise<{ teamId: string }> };

// GET /api/teams/[teamId]/audit-logs — Team audit logs (ADMIN/OWNER only)
async function handleGET(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { teamId } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.TEAM_UPDATE, req);
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return errorResponse(e.message, e.status);
    }
    throw e;
  }

  const { searchParams } = new URL(req.url);
  const { action, actions: actionsParam, from, to, cursor, limit } = parseAuditLogParams(searchParams);
  if (!isValidCursorId(cursor)) {
    return errorResponse(API_ERROR.INVALID_CURSOR, 400);
  }
  const validActorType = parseActorType(searchParams);

  const where: Record<string, unknown> = {
    teamId: teamId,
    scope: AUDIT_SCOPE.TEAM,
    ...(validActorType ? { actorType: validActorType } : {}),
  };

  try {
    const actionFilter = buildAuditLogActionFilter(
      { action, actions: actionsParam },
      VALID_ACTIONS,
      AUDIT_ACTION_GROUPS_TEAM,
    );
    if (actionFilter !== undefined) where.action = actionFilter;
  } catch (err) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: err },
      { status: 400 }
    );
  }

  const dateFilter = buildAuditLogDateFilter(from, to);
  if (dateFilter) where.createdAt = dateFilter;

  let logs;
  try {
    logs = await withTeamTenantRls(teamId, async () =>
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

  const { items, nextCursor } = paginateResult(logs, limit);

  // Collect encrypted overviews for entry targets (client decrypts to get titles)
  const entryIds = [
    ...new Set(
      items
        .filter((l) => l.targetType === AUDIT_TARGET_TYPE.TEAM_PASSWORD_ENTRY && l.targetId)
        .map((l) => l.targetId as string)
    ),
  ];

  const entryOverviews: Record<string, {
    encryptedOverview: string;
    overviewIv: string;
    overviewAuthTag: string;
    aadVersion: number;
    teamKeyVersion: number;
    encryptedItemKey: string;
    itemKeyIv: string;
    itemKeyAuthTag: string;
    itemKeyVersion: number;
  }> = {};

  if (entryIds.length > 0) {
    const entries = await withTeamTenantRls(teamId, async () =>
      prisma.teamPasswordEntry.findMany({
        where: { id: { in: entryIds } },
        select: {
          id: true,
          encryptedOverview: true,
          overviewIv: true,
          overviewAuthTag: true,
          aadVersion: true,
          teamKeyVersion: true,
          encryptedItemKey: true,
          itemKeyIv: true,
          itemKeyAuthTag: true,
          itemKeyVersion: true,
        },
      }),
    );

    for (const e of entries) {
      // Skip entries without ItemKey (pre-migration entries)
      if (!e.encryptedItemKey || !e.itemKeyIv || !e.itemKeyAuthTag) continue;
      entryOverviews[e.id] = {
        encryptedOverview: e.encryptedOverview,
        overviewIv: e.overviewIv,
        overviewAuthTag: e.overviewAuthTag,
        aadVersion: e.aadVersion,
        teamKeyVersion: e.teamKeyVersion,
        encryptedItemKey: e.encryptedItemKey,
        itemKeyIv: e.itemKeyIv,
        itemKeyAuthTag: e.itemKeyAuthTag,
        itemKeyVersion: e.itemKeyVersion,
      };
    }
  }

  return NextResponse.json({
    items: items.map((log) => ({
      id: log.id,
      action: log.action,
      targetType: log.targetType,
      targetId: log.targetId,
      metadata: log.metadata,
      actorType: log.actorType,
      ip: log.ip,
      userAgent: log.userAgent,
      createdAt: log.createdAt,
      user: log.user,
    })),
    nextCursor,
    entryOverviews,
  });
}

export const GET = withRequestLog(handleGET);
