import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";

type Params = { params: Promise<{ id: string }> };

// DELETE /api/share-links/[id] — Revoke a share link
export async function DELETE(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (share.revokedAt) {
    return NextResponse.json({ error: "Already revoked" }, { status: 409 });
  }

  await prisma.passwordShare.update({
    where: { id },
    data: { revokedAt: new Date() },
  });

  // Audit log
  const { ip, userAgent } = extractRequestMeta(req);
  logAudit({
    scope: share.orgPasswordEntryId ? "ORG" : "PERSONAL",
    action: "SHARE_REVOKE",
    userId: session.user.id,
    orgId: share.orgPasswordEntryId
      ? (
          await prisma.orgPasswordEntry.findUnique({
            where: { id: share.orgPasswordEntryId },
            select: { orgId: true },
          })
        )?.orgId
      : undefined,
    targetType: "PasswordShare",
    targetId: share.id,
    ip,
    userAgent,
  });

  return NextResponse.json({ ok: true });
}
