import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAuditInTx, personalAuditBase, teamAuditBase } from "@/lib/audit/audit";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { errorResponse, unauthorized, notFound } from "@/lib/http/api-response";
import { AUDIT_TARGET_TYPE, AUDIT_ACTION, SHARE_TYPE } from "@/lib/constants";
import { withUserTenantRls } from "@/lib/tenant-context";
import { withTenantRls } from "@/lib/tenant-rls";
import { SHARE_LINK_MANAGER, shareLinkManagerOf } from "@/lib/share/share-link-manager";
import { withRequestLog } from "@/lib/http/with-request-log";

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

  if (!share) {
    return notFound();
  }

  // The creator, or for a team entry's link a team OWNER/ADMIN (#995).
  const manager = await shareLinkManagerOf(session.user.id, share, req);
  if (!manager) {
    return notFound();
  }
  const byTeamAdmin = manager === SHARE_LINK_MANAGER.TEAM_ADMIN;

  if (share.revokedAt) {
    return errorResponse(API_ERROR.ALREADY_REVOKED);
  }

  // Revoke and audit in one transaction, the revoke as a compare-and-set on an
  // unrevoked row: of two concurrent revokes (the creator and an admin, say)
  // one revokes and audits, the other answers ALREADY_REVOKED.
  const revoked = await withTenantRls(prisma, share.tenantId, async (tx) => {
    const { count } = await tx.passwordShare.updateMany({
      where: byTeamAdmin
        ? { id, teamPasswordEntryId: share.teamPasswordEntryId, revokedAt: null }
        : { id, createdById: session.user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count === 0) return false;
    const teamId = share.teamPasswordEntry?.teamId;
    await logAuditInTx(tx, share.tenantId, {
      ...(share.teamPasswordEntryId && teamId
        ? teamAuditBase(req, session.user.id, teamId)
        : personalAuditBase(req, session.user.id)),
      action: share.shareType === SHARE_TYPE.TEXT || share.shareType === SHARE_TYPE.FILE
        ? AUDIT_ACTION.SEND_REVOKE
        : AUDIT_ACTION.SHARE_REVOKE,
      targetType: AUDIT_TARGET_TYPE.PASSWORD_SHARE,
      targetId: share.id,
      ...(byTeamAdmin ? { metadata: { revokedByTeamAdmin: true, creatorId: share.createdById } } : {}),
    });
    return true;
  });
  if (!revoked) {
    return errorResponse(API_ERROR.ALREADY_REVOKED);
  }

  return NextResponse.json({ ok: true });
}

export const DELETE = withRequestLog(handleDELETE);
