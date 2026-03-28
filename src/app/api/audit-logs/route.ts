import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { API_ERROR } from "@/lib/api-error-codes";
import { errorResponse, unauthorized, validationError } from "@/lib/api-response";
import {
  AUDIT_ACTION,
  AUDIT_ACTION_EMERGENCY_PREFIX,
  AUDIT_ACTION_GROUPS_PERSONAL,
  AUDIT_SCOPE,
  AUDIT_TARGET_TYPE,
} from "@/lib/constants";
import { withUserTenantRls } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/with-request-log";
import {
  VALID_ACTIONS,
  parseAuditLogParams,
  buildAuditLogActionFilter,
  buildAuditLogDateFilter,
  paginateResult,
} from "@/lib/audit-query";

// GET /api/audit-logs — Personal audit logs (cursor-based pagination)
async function handleGET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { searchParams } = new URL(req.url);
  const { action, actions: actionsParam, from, to, cursor, limit } = parseAuditLogParams(searchParams);
  const actorType = searchParams.get("actorType");
  const VALID_ACTOR_TYPES = ["HUMAN", "SERVICE_ACCOUNT", "MCP_AGENT", "SYSTEM"] as const;
  const validActorType = VALID_ACTOR_TYPES.find((t) => t === actorType);

  const where: Prisma.AuditLogWhereInput = {
    scope: AUDIT_SCOPE.PERSONAL,
    ...(validActorType ? { actorType: validActorType } : {}),
    OR: [
      { userId: session.user.id },
      {
        action: AUDIT_ACTION.EMERGENCY_VAULT_ACCESS,
        metadata: {
          path: ["ownerId"],
          equals: session.user.id,
        },
      },
    ],
  };

  try {
    const actionFilter = buildAuditLogActionFilter(
      { action, actions: actionsParam },
      VALID_ACTIONS,
      AUDIT_ACTION_GROUPS_PERSONAL,
    );
    if (actionFilter !== undefined) where.action = actionFilter;
  } catch (err) {
    return validationError(err as Record<string, unknown>);
  }

  const dateFilter = buildAuditLogDateFilter(from, to);
  if (dateFilter) where.createdAt = dateFilter;

  let logs;
  try {
    logs = await withUserTenantRls(session.user.id, async () =>
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

  // Resolve encrypted overviews for PasswordEntry targets
  const entryIds = [
    ...new Set(
      items
        .filter((l) => l.targetType === AUDIT_TARGET_TYPE.PASSWORD_ENTRY && l.targetId)
        .map((l) => l.targetId as string)
    ),
  ];

  const entryOverviews: Record<
    string,
    { ciphertext: string; iv: string; authTag: string; aadVersion: number }
  > = {};

  if (entryIds.length > 0) {
    const entries = await withUserTenantRls(session.user.id, async () =>
      prisma.passwordEntry.findMany({
        where: { id: { in: entryIds } },
        select: {
          id: true,
          encryptedOverview: true,
          overviewIv: true,
          overviewAuthTag: true,
          aadVersion: true,
        },
      }),
    );
    for (const e of entries) {
      entryOverviews[e.id] = {
        ciphertext: e.encryptedOverview,
        iv: e.overviewIv,
        authTag: e.overviewAuthTag,
        aadVersion: e.aadVersion,
      };
    }
  }

  // Resolve related users for Emergency Access logs (ownerId/granteeId stored in metadata)
  const relatedIds = [
    ...new Set(
      items
        .filter((l) => l.action.startsWith(AUDIT_ACTION_EMERGENCY_PREFIX))
        .flatMap((l) => {
          const meta = l.metadata as { ownerId?: string; granteeId?: string } | null;
          return [meta?.ownerId, meta?.granteeId].filter((id): id is string => !!id);
        })
    ),
  ];

  const relatedUsers: Record<string, { id: string; name: string | null; email: string | null; image: string | null }> = {};
  if (relatedIds.length > 0) {
    const users = await withUserTenantRls(session.user.id, async () =>
      prisma.user.findMany({
        where: { id: { in: relatedIds } },
        select: { id: true, name: true, email: true, image: true },
      }),
    );
    for (const user of users) {
      relatedUsers[user.id] = user;
    }
  }

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
    entryOverviews,
    relatedUsers,
  });
}

export const GET = withRequestLog(handleGET);
