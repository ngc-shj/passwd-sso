/**
 * GET /api/directory-sync/[id]/logs — List sync logs for a config.
 *
 * Query params:
 *   limit  — max rows (1..100, default 20)
 *   cursor — ID of the last row from previous page (for keyset pagination)
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { API_ERROR } from "@/lib/api-error-codes";
import { withRequestLog } from "@/lib/with-request-log";
import { withUserTenantRls } from "@/lib/tenant-context";

type RouteContext = { params: Promise<{ id: string }> };

async function handleGET(req: NextRequest, ctx: RouteContext) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: API_ERROR.UNAUTHORIZED },
      { status: 401 },
    );
  }

  const { id } = await ctx.params;

  const member = await withUserTenantRls(session.user.id, () =>
    prisma.tenantMember.findFirst({
      where: { userId: session.user.id, role: { in: ["ADMIN", "OWNER"] } },
      select: { tenantId: true },
    }),
  );
  if (!member) {
    return NextResponse.json(
      { error: API_ERROR.FORBIDDEN },
      { status: 403 },
    );
  }
  const tenantId = member.tenantId;

  // Verify config belongs to tenant
  const config = await withUserTenantRls(session.user.id, () =>
    prisma.directorySyncConfig.findFirst({
      where: { id, tenantId },
      select: { id: true },
    }),
  );
  if (!config) {
    return NextResponse.json(
      { error: API_ERROR.NOT_FOUND },
      { status: 404 },
    );
  }

  // Parse query params
  const url = req.nextUrl;
  const limit = Math.min(
    100,
    Math.max(1, parseInt(url.searchParams.get("limit") ?? "20", 10) || 20),
  );
  const cursor = url.searchParams.get("cursor") ?? undefined;

  // Fetch logs with keyset pagination
  const logs = await withUserTenantRls(session.user.id, () =>
    prisma.directorySyncLog.findMany({
      where: { configId: id, tenantId },
      orderBy: { startedAt: "desc" },
      take: limit + 1, // fetch one extra to detect hasMore
      ...(cursor
        ? {
            cursor: { id: cursor },
            skip: 1, // skip the cursor row itself
          }
        : {}),
      select: {
        id: true,
        status: true,
        startedAt: true,
        completedAt: true,
        dryRun: true,
        usersCreated: true,
        usersUpdated: true,
        usersDeactivated: true,
        groupsUpdated: true,
        errorMessage: true,
      },
    }),
  );

  const hasMore = logs.length > limit;
  const items = hasMore ? logs.slice(0, limit) : logs;
  const nextCursor = hasMore ? items[items.length - 1].id : undefined;

  return NextResponse.json({
    items,
    nextCursor,
    hasMore,
  });
}

export const GET = withRequestLog(handleGET);
