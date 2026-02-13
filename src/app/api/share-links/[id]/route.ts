import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { API_ERROR } from "@/lib/api-error-codes";
import { AUDIT_TARGET_TYPE, AUDIT_ACTION } from "@/lib/constants";

type Params = { params: Promise<{ id: string }> };

// DELETE /api/share-links/[id] — Revoke a share link
export async function DELETE(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { id } = await params;

  const share = await prisma.passwordShare.findUnique({
    where: { id },
    select: {
      id: true,
      createdById: true,
      revokedAt: true,
      orgPasswordEntryId: true,
    },
  });

  if (!share || share.createdById !== session.user.id) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }

  if (share.revokedAt) {
    return NextResponse.json({ error: API_ERROR.ALREADY_REVOKED }, { status: 409 });
  }

  await prisma.passwordShare.update({
    where: { id },
    data: { revokedAt: new Date() },
  });

  // Audit log
  const { ip, userAgent } = extractRequestMeta(req);
  logAudit({
    scope: share.orgPasswordEntryId ? "ORG" : "PERSONAL",
    action: AUDIT_ACTION.SHARE_REVOKE,
    userId: session.user.id,
    orgId: share.orgPasswordEntryId
      ? (
          await prisma.orgPasswordEntry.findUnique({
            where: { id: share.orgPasswordEntryId },
            select: { orgId: true },
          })
        )?.orgId
      : undefined,
    targetType: AUDIT_TARGET_TYPE.PASSWORD_SHARE,
    targetId: share.id,
    ip,
    userAgent,
  });

  return NextResponse.json({ ok: true });
}
