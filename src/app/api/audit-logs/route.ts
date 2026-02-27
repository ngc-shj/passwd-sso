import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import type { AuditAction, Prisma } from "@prisma/client";
import { API_ERROR } from "@/lib/api-error-codes";
import {
  AUDIT_ACTION,
  AUDIT_ACTION_EMERGENCY_PREFIX,
  AUDIT_ACTION_GROUPS_PERSONAL,
  AUDIT_ACTION_VALUES,
  AUDIT_SCOPE,
  AUDIT_TARGET_TYPE,
} from "@/lib/constants";
import { withUserTenantRls } from "@/lib/tenant-context";

const VALID_ACTIONS: Set<string> = new Set(AUDIT_ACTION_VALUES);

// GET /api/audit-logs — Personal audit logs (cursor-based pagination)
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action");
  const actionsParam = searchParams.get("actions");
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const cursor = searchParams.get("cursor");
  const limitParam = searchParams.get("limit");
  const limit = Math.min(Math.max(parseInt(limitParam ?? "50", 10) || 50, 1), 100);

  const where: Prisma.AuditLogWhereInput = {
    scope: AUDIT_SCOPE.PERSONAL,
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

  if (actionsParam) {
    const requested = actionsParam.split(",").map((a) => a.trim()).filter(Boolean);
    const invalid = requested.filter((a) => !VALID_ACTIONS.has(a as AuditAction));
    if (invalid.length > 0) {
      return NextResponse.json(
        { error: API_ERROR.VALIDATION_ERROR, details: { actions: invalid } },
        { status: 400 }
      );
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
    return NextResponse.json({ error: API_ERROR.INVALID_CURSOR }, { status: 400 });
  }

  const hasMore = logs.length > limit;
  const items = hasMore ? logs.slice(0, limit) : logs;
  const nextCursor = hasMore ? items[items.length - 1].id : null;

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
