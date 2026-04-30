import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { createNotification } from "@/lib/notification";
import { sendEmail } from "@/lib/email";
import { adminVaultResetRevokedEmail } from "@/lib/email/templates/admin-vault-reset-revoked";
import { resolveUserLocale } from "@/lib/locale";
import {
  requireTenantPermission,
} from "@/lib/auth/access/tenant-auth";
import { withTenantRls } from "@/lib/tenant-rls";
import { notificationTitle, notificationBody } from "@/lib/notification/notification-messages";
import { TENANT_PERMISSION } from "@/lib/constants/auth/tenant-permission";
import { AUDIT_ACTION } from "@/lib/constants";
import { NOTIFICATION_TYPE } from "@/lib/constants/audit/notification";
import { withRequestLog } from "@/lib/http/with-request-log";
import { handleAuthError, unauthorized } from "@/lib/http/api-response";

export const runtime = "nodejs";

// POST /api/tenant/members/[userId]/reset-vault/[resetId]/revoke
// Revoke a vault reset. Tenant OWNER/ADMIN only.
//
// Both `pending_approval` and `approved` (not yet executed) states are
// revocable — the WHERE clause `executedAt: null, revokedAt: null,
// expiresAt > now` covers both implicitly.
async function handlePOST(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string; resetId: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { userId: targetUserId, resetId } = await params;

  // Authorization: require MEMBER_VAULT_RESET permission.
  // Unlike initiate, revoke intentionally omits isTenantRoleAbove — any
  // OWNER/ADMIN can revoke any pending reset because revoke is a "safe-side"
  // operation (prevents data deletion). This asymmetry is by design.
  let actor;
  try {
    actor = await requireTenantPermission(
      session.user.id,
      TENANT_PERMISSION.MEMBER_VAULT_RESET,
    );
  } catch (err) {
    return handleAuthError(err);
  }

  // Read approvedAt BEFORE the CAS — the post-revoke target notification is
  // gated on this (F2 + FR8): if the row was still pending_approval the
  // target never received the initial reset email, so a revoke is silent
  // to them. `undefined` means the row does not exist or scope mismatch.
  const existingApprovedAt: Date | null | undefined = await withTenantRls(
    prisma,
    actor.tenantId,
    async () => {
      const existing = await prisma.adminVaultReset.findUnique({
        where: { id: resetId },
        select: { approvedAt: true, tenantId: true, targetUserId: true },
      });
      if (
        !existing ||
        existing.tenantId !== actor.tenantId ||
        existing.targetUserId !== targetUserId
      ) {
        return undefined;
      }
      return existing.approvedAt;
    },
  );

  if (existingApprovedAt === undefined) {
    return NextResponse.json(
      { error: API_ERROR.CONFLICT },
      { status: 409 },
    );
  }

  // Atomic revoke with TOCTOU prevention: only revoke if still in a revocable
  // state. NULL out `encryptedToken` so the at-rest plaintext token cannot
  // be redeemed even if the row is later read with elevated privileges.
  const now = new Date();
  const result = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.adminVaultReset.updateMany({
      where: {
        id: resetId,
        tenantId: actor.tenantId,
        targetUserId,
        executedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: {
        revokedAt: now,
        encryptedToken: null,
      },
    }),
  );

  if (result.count === 0) {
    return NextResponse.json(
      { error: API_ERROR.CONFLICT },
      { status: 409 },
    );
  }

  // Audit log — fires unconditionally regardless of prior approval state.
  await logAuditAsync({
    ...tenantAuditBase(req, session.user.id, actor.tenantId),
    action: AUDIT_ACTION.ADMIN_VAULT_RESET_REVOKE,
    targetType: "User",
    targetId: targetUserId,
    metadata: { revokedById: session.user.id, resetId },
  });

  // Notify target only if the reset had been APPROVED before revoke.
  // Pending-approval revokes are silent to the target (F2 + FR8) — they
  // never received the initial reset email, so a revoke email would leak
  // that an admin had attempted (and aborted) a reset.
  const wasApproved = existingApprovedAt !== null;
  if (!wasApproved) {
    return NextResponse.json({ ok: true });
  }

  // Fetch target user for notification + email
  const targetUser = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.tenantMember.findFirst({
      where: {
        tenantId: actor.tenantId,
        userId: targetUserId,
      },
      include: {
        user: { select: { email: true, name: true, locale: true } },
      },
    }),
  );

  if (targetUser) {
    const locale = resolveUserLocale(targetUser.user.locale);

    createNotification({
      userId: targetUserId,
      tenantId: actor.tenantId,
      type: NOTIFICATION_TYPE.ADMIN_VAULT_RESET_REVOKED,
      title: notificationTitle("ADMIN_VAULT_RESET_REVOKED", locale),
      body: notificationBody("ADMIN_VAULT_RESET_REVOKED", locale),
    });

    if (targetUser.user.email) {
      const adminName = session.user.name ?? session.user.email ?? "";
      const { subject, html, text } = adminVaultResetRevokedEmail(locale, adminName);
      void sendEmail({ to: targetUser.user.email, subject, html, text });
    }
  }

  return NextResponse.json({ ok: true });
}

export const POST = withRequestLog(handlePOST);
