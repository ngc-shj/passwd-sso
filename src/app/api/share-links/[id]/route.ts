import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAuditInTx, personalAuditBase, teamAuditBase } from "@/lib/audit/audit";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { errorResponse, unauthorized, notFound } from "@/lib/http/api-response";
import { AUDIT_TARGET_TYPE, AUDIT_ACTION, SHARE_TYPE, TEAM_PERMISSION } from "@/lib/constants";
import { requireTeamPermission, TeamAuthError } from "@/lib/auth/access/team-auth";
import { withUserTenantRls } from "@/lib/tenant-context";
import { withBypassRls } from "@/lib/tenant-rls";
import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
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

  // The creator revokes their own link; a team OWNER/ADMIN (PASSWORD_DELETE)
  // revokes any link of an entry of their team (#995). Personal shares and
  // Sends stay creator-only.
  const isCreator = share.createdById === session.user.id;
  if (!isCreator) {
    const teamId = share.teamPasswordEntry?.teamId;
    if (!teamId) {
      return notFound();
    }
    try {
      await requireTeamPermission(session.user.id, teamId, TEAM_PERMISSION.PASSWORD_DELETE);
    } catch (e) {
      if (e instanceof TeamAuthError) return notFound();
      throw e;
    }
  }

  if (share.revokedAt) {
    return errorResponse(API_ERROR.ALREADY_REVOKED);
  }

  const teamPasswordEntryId = share.teamPasswordEntryId;

  await withUserTenantRls(session.user.id, async () =>
    prisma.passwordShare.update({
      where: isCreator ? { id, createdById: session.user.id } : { id, teamPasswordEntryId: share.teamPasswordEntryId },
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
      action: share.shareType === SHARE_TYPE.TEXT || share.shareType === SHARE_TYPE.FILE
        ? AUDIT_ACTION.SEND_REVOKE
        : AUDIT_ACTION.SHARE_REVOKE,
      targetType: AUDIT_TARGET_TYPE.PASSWORD_SHARE,
      targetId: share.id,
      ...(isCreator ? {} : { metadata: { revokedByTeamAdmin: true, creatorId: share.createdById } }),
    });
  }, BYPASS_GRANT.AUDIT_WRITE_DIRECT_OUTBOX);

  return NextResponse.json({ ok: true });
}

export const DELETE = withRequestLog(handleDELETE);
