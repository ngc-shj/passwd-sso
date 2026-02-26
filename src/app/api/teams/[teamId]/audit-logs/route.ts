import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTeamPermission, TeamAuthError } from "@/lib/team-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import {
  TEAM_PERMISSION,
  AUDIT_SCOPE,
  AUDIT_ACTION_GROUPS_TEAM,
  AUDIT_ACTION_VALUES,
  AUDIT_TARGET_TYPE,
} from "@/lib/constants";
import type { AuditAction } from "@prisma/client";

type Params = { params: Promise<{ teamId: string }> };

const VALID_ACTIONS: Set<string> = new Set(AUDIT_ACTION_VALUES);

// GET /api/teams/[teamId]/audit-logs — Team audit logs (ADMIN/OWNER only)
export async function GET(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { teamId } = await params;

  try {
    await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.TEAM_UPDATE);
  } catch (e) {
    if (e instanceof TeamAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
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
    orgId: teamId,
    scope: AUDIT_SCOPE.ORG,
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
    where.action = { in: requested };
  } else if (action) {
    if (AUDIT_ACTION_GROUPS_TEAM[action]) {
      where.action = { in: AUDIT_ACTION_GROUPS_TEAM[action] };
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
    logs = await prisma.auditLog.findMany({
      where,
      include: {
        user: { select: { id: true, name: true, image: true } },
      },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
  } catch {
    return NextResponse.json({ error: API_ERROR.INVALID_CURSOR }, { status: 400 });
  }

  const hasMore = logs.length > limit;
  const items = hasMore ? logs.slice(0, limit) : logs;
  const nextCursor = hasMore ? items[items.length - 1].id : null;

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
    orgKeyVersion: number;
  }> = {};

  if (entryIds.length > 0) {
    const entries = await prisma.orgPasswordEntry.findMany({
      where: { id: { in: entryIds } },
      select: {
        id: true,
        encryptedOverview: true,
        overviewIv: true,
        overviewAuthTag: true,
        aadVersion: true,
        orgKeyVersion: true,
      },
    });

    for (const e of entries) {
      entryOverviews[e.id] = {
        encryptedOverview: e.encryptedOverview,
        overviewIv: e.overviewIv,
        overviewAuthTag: e.overviewAuthTag,
        aadVersion: e.aadVersion,
        orgKeyVersion: e.orgKeyVersion,
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
      ip: log.ip,
      userAgent: log.userAgent,
      createdAt: log.createdAt,
      user: log.user,
    })),
    nextCursor,
    entryOverviews,
  });
}
