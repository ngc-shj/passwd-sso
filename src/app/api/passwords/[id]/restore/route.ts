import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { API_ERROR } from "@/lib/api-error-codes";
import { withRequestLog } from "@/lib/with-request-log";
import { AUDIT_TARGET_TYPE, AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
import { withUserTenantRls } from "@/lib/tenant-context";
import { errorResponse, forbidden, notFound, unauthorized } from "@/lib/api-response";

// POST /api/passwords/[id]/restore - Restore from trash
async function handlePOST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { id } = await params;

  const existing = await withUserTenantRls(session.user.id, async () =>
    prisma.passwordEntry.findUnique({
      where: { id },
      select: { userId: true, deletedAt: true },
    }),
  );

  if (!existing) {
    return notFound();
  }

  if (existing.userId !== session.user.id) {
    return forbidden();
  }

  if (!existing.deletedAt) {
    return errorResponse(API_ERROR.NOT_IN_TRASH, 400);
  }

  await withUserTenantRls(session.user.id, async () =>
    prisma.passwordEntry.update({
      where: { id },
      data: { deletedAt: null },
    }),
  );

  logAudit({
    scope: AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.ENTRY_RESTORE,
    userId: session.user.id,
    targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
    targetId: id,
    ...extractRequestMeta(req),
  });

  return NextResponse.json({ success: true });
}

export const POST = withRequestLog(handlePOST);
