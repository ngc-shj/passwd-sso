import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { withRequestLog } from "@/lib/http/with-request-log";
import { AUDIT_TARGET_TYPE, AUDIT_ACTION } from "@/lib/constants";
import { withUserTenantRls } from "@/lib/tenant-context";
import { errorResponse, notFound, unauthorized } from "@/lib/http/api-response";

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
    // A01-4: 403 vs 404 difference leaks "ID exists in tenant" oracle to
    // attacker. RLS should already null this branch; defense-in-depth.
    return notFound();
  }

  if (!existing.deletedAt) {
    return errorResponse(API_ERROR.NOT_IN_TRASH);
  }

  await withUserTenantRls(session.user.id, async () =>
    prisma.passwordEntry.update({
      where: { id, userId: session.user.id },
      data: { deletedAt: null },
    }),
  );

  await logAuditAsync({
    ...personalAuditBase(req, session.user.id),
    action: AUDIT_ACTION.ENTRY_RESTORE,
    targetType: AUDIT_TARGET_TYPE.PASSWORD_ENTRY,
    targetId: id,
  });

  return NextResponse.json({ success: true });
}

export const POST = withRequestLog(handlePOST);
