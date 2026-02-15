import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { API_ERROR } from "@/lib/api-error-codes";
import { withRequestLog } from "@/lib/with-request-log";
import { AUDIT_TARGET_TYPE, AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";

// POST /api/passwords/[id]/restore - Restore from trash
async function handlePOST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { id } = await params;

  const existing = await prisma.passwordEntry.findUnique({
    where: { id },
  });

  if (!existing) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }

  if (existing.userId !== session.user.id) {
    return NextResponse.json({ error: API_ERROR.FORBIDDEN }, { status: 403 });
  }

  if (!existing.deletedAt) {
    return NextResponse.json({ error: API_ERROR.NOT_IN_TRASH }, { status: 400 });
  }

  await prisma.passwordEntry.update({
    where: { id },
    data: { deletedAt: null },
  });

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
