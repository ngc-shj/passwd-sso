import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { API_ERROR } from "@/lib/api-error-codes";
import { withRequestLog } from "@/lib/with-request-log";
import { withUserTenantRls } from "@/lib/tenant-context";

// PATCH /api/notifications/[id] — Mark a single notification as read
async function handlePATCH(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: API_ERROR.UNAUTHORIZED },
      { status: 401 },
    );
  }

  const { id } = await params;

  const existing = await withUserTenantRls(session.user.id, async () =>
    prisma.notification.findUnique({ where: { id } }),
  );
  if (!existing) {
    return NextResponse.json(
      { error: API_ERROR.NOT_FOUND },
      { status: 404 },
    );
  }
  if (existing.userId !== session.user.id) {
    return NextResponse.json(
      { error: API_ERROR.FORBIDDEN },
      { status: 403 },
    );
  }

  const notification = await withUserTenantRls(session.user.id, async () =>
    prisma.notification.update({
      where: { id },
      data: { isRead: true },
    }),
  );

  return NextResponse.json({
    id: notification.id,
    isRead: notification.isRead,
  });
}

// DELETE /api/notifications/[id] — Delete a single notification
async function handleDELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: API_ERROR.UNAUTHORIZED },
      { status: 401 },
    );
  }

  const { id } = await params;

  const existing = await withUserTenantRls(session.user.id, async () =>
    prisma.notification.findUnique({ where: { id } }),
  );
  if (!existing) {
    return NextResponse.json(
      { error: API_ERROR.NOT_FOUND },
      { status: 404 },
    );
  }
  if (existing.userId !== session.user.id) {
    return NextResponse.json(
      { error: API_ERROR.FORBIDDEN },
      { status: 403 },
    );
  }

  await withUserTenantRls(session.user.id, async () =>
    prisma.notification.delete({ where: { id } }),
  );

  return NextResponse.json({ success: true });
}

export const PATCH = withRequestLog(handlePATCH);
export const DELETE = withRequestLog(handleDELETE);
