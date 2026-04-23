import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { withRequestLog } from "@/lib/http/with-request-log";
import { withUserTenantRls } from "@/lib/tenant-context";

// GET /api/notifications/count — Lightweight unread count for polling
async function handleGET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: API_ERROR.UNAUTHORIZED },
      { status: 401 },
    );
  }

  const count = await withUserTenantRls(session.user.id, async () =>
    prisma.notification.count({
      where: { userId: session.user.id, isRead: false },
    }),
  );

  return NextResponse.json({ unreadCount: count });
}

export const GET = withRequestLog(handleGET);
