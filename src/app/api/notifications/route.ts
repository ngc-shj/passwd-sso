import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { API_ERROR } from "@/lib/api-error-codes";
import { unauthorized, errorResponse } from "@/lib/api-response";
import { withRequestLog } from "@/lib/with-request-log";
import { withUserTenantRls } from "@/lib/tenant-context";
import type { Prisma } from "@prisma/client";
import {
  NOTIFICATION_PAGE_MIN,
  NOTIFICATION_PAGE_DEFAULT,
  NOTIFICATION_PAGE_MAX,
} from "@/lib/validations/common.server";
import { isValidCursorId } from "@/lib/audit-query";

// GET /api/notifications — List notifications (cursor-based pagination)
async function handleGET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { searchParams } = new URL(req.url);
  const cursor = searchParams.get("cursor");
  if (!isValidCursorId(cursor)) {
    return errorResponse(API_ERROR.INVALID_CURSOR, 400);
  }
  const limitParam = searchParams.get("limit");
  const limit = Math.min(
    Math.max(parseInt(limitParam ?? String(NOTIFICATION_PAGE_DEFAULT), 10) || NOTIFICATION_PAGE_DEFAULT, NOTIFICATION_PAGE_MIN),
    NOTIFICATION_PAGE_MAX,
  );
  const unreadOnly = searchParams.get("unreadOnly") === "true";

  const where: Prisma.NotificationWhereInput = {
    userId: session.user.id,
    ...(unreadOnly ? { isRead: false } : {}),
  };

  let notifications;
  try {
    notifications = await withUserTenantRls(session.user.id, async () =>
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }),
    );
  } catch {
    return NextResponse.json(
      { error: API_ERROR.INVALID_CURSOR },
      { status: 400 },
    );
  }

  const hasMore = notifications.length > limit;
  const items = hasMore ? notifications.slice(0, limit) : notifications;
  const nextCursor = hasMore ? items[items.length - 1].id : null;

  return NextResponse.json({
    items: items.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      body: n.body,
      metadata: n.metadata,
      isRead: n.isRead,
      createdAt: n.createdAt,
    })),
    nextCursor,
  });
}

// PATCH /api/notifications — Mark all notifications as read
 
async function handlePATCH(_req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const result = await withUserTenantRls(session.user.id, async () =>
    prisma.notification.updateMany({
      where: { userId: session.user.id, isRead: false },
      data: { isRead: true },
    }),
  );

  return NextResponse.json({ updatedCount: result.count });
}

export const GET = withRequestLog(handleGET);
export const PATCH = withRequestLog(handlePATCH);
