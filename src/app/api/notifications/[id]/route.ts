import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { notFound, unauthorized } from "@/lib/http/api-response";
import { withRequestLog } from "@/lib/http/with-request-log";
import { withUserTenantRls } from "@/lib/tenant-context";

// PATCH /api/notifications/[id] — Mark a single notification as read
async function handlePATCH(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { id } = await params;

  const existing = await withUserTenantRls(session.user.id, async () =>
    prisma.notification.findFirst({ where: { id, userId: session.user.id } }),
  );
  if (!existing) {
    return notFound();
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
    return unauthorized();
  }

  const { id } = await params;

  const existing = await withUserTenantRls(session.user.id, async () =>
    prisma.notification.findFirst({ where: { id, userId: session.user.id } }),
  );
  if (!existing) {
    return notFound();
  }

  await withUserTenantRls(session.user.id, async () =>
    prisma.notification.delete({ where: { id } }),
  );

  return NextResponse.json({ success: true });
}

export const PATCH = withRequestLog(handlePATCH);
export const DELETE = withRequestLog(handleDELETE);
