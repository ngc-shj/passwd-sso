import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAuditInTx, personalAuditBase, teamAuditBase } from "@/lib/audit";
import { API_ERROR } from "@/lib/api-error-codes";
import { errorResponse, unauthorized, notFound } from "@/lib/api-response";
import { AUDIT_TARGET_TYPE, AUDIT_ACTION } from "@/lib/constants";
import { withUserTenantRls } from "@/lib/tenant-context";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/with-request-log";

type Params = { params: Promise<{ id: string }> };

// DELETE /api/share-links/[id] — Revoke a share link
async function handleDELETE(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { id } = await params;

  const share = await withUserTenantRls(session.user.id, async () =>
    prisma.passwordShare.findUnique({
      where: { id },
      select: {
        id: true,
        shareType: true,
        createdById: true,
        revokedAt: true,
        tenantId: true,
        teamPasswordEntryId: true,
        teamPasswordEntry: { select: { teamId: true } },
      },
    }),
  );

  if (!share || share.createdById !== session.user.id) {
    return notFound();
  }

  if (share.revokedAt) {
    return errorResponse(API_ERROR.ALREADY_REVOKED, 409);
  }

  const teamPasswordEntryId = share.teamPasswordEntryId;

  await withUserTenantRls(session.user.id, async () =>
    prisma.passwordShare.update({
      where: { id },
      data: { revokedAt: new Date() },
    }),
  );

  // Atomic audit: SHARE_REVOKE / SEND_REVOKE
  await withBypassRls(prisma, async (tx) => {
    const teamId = share.teamPasswordEntry?.teamId;
    await logAuditInTx(tx, share.tenantId, {
      ...(teamPasswordEntryId && teamId
        ? teamAuditBase(req, session.user.id, teamId)
        : personalAuditBase(req, session.user.id)),
      action: share.shareType === "TEXT" || share.shareType === "FILE"
        ? AUDIT_ACTION.SEND_REVOKE
        : AUDIT_ACTION.SHARE_REVOKE,
      targetType: AUDIT_TARGET_TYPE.PASSWORD_SHARE,
      targetId: share.id,
    });
  }, BYPASS_PURPOSE.AUDIT_WRITE);

  return NextResponse.json({ ok: true });
}

export const DELETE = withRequestLog(handleDELETE);
