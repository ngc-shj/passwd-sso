import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { assertOrigin } from "@/lib/auth/csrf";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { createNotification } from "@/lib/notification";
import { sendEmail } from "@/lib/email";
import { adminVaultResetRevokedEmail } from "@/lib/email/templates/admin-vault-reset-revoked";
import { resolveUserLocale } from "@/lib/locale";
import {
  requireTenantPermission,
} from "@/lib/auth/tenant-auth";
import { withTenantRls } from "@/lib/tenant-rls";
import { notificationTitle, notificationBody } from "@/lib/notification/notification-messages";
import { TENANT_PERMISSION } from "@/lib/constants/auth/tenant-permission";
import { AUDIT_ACTION } from "@/lib/constants";
import { NOTIFICATION_TYPE } from "@/lib/constants/audit/notification";
import { withRequestLog } from "@/lib/http/with-request-log";
import { handleAuthError, unauthorized } from "@/lib/http/api-response";

export const runtime = "nodejs";

// POST /api/tenant/members/[userId]/reset-vault/[resetId]/revoke
// Revoke a pending vault reset. Tenant OWNER/ADMIN only.
async function handlePOST(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string; resetId: string }> },
) {
  const originError = assertOrigin(req);
  if (originError) return originError;

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

  // Atomic revoke with TOCTOU prevention: only revoke if still pending
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
      },
    }),
  );

  if (result.count === 0) {
    return NextResponse.json(
      { error: API_ERROR.CONFLICT },
      { status: 409 },
    );
  }

  // Audit log
  await logAuditAsync({
    ...tenantAuditBase(req, session.user.id, actor.tenantId),
    action: AUDIT_ACTION.ADMIN_VAULT_RESET_REVOKE,
    targetType: "User",
    targetId: targetUserId,
    metadata: { revokedById: session.user.id, resetId },
  });

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

    // In-app notification
    createNotification({
      userId: targetUserId,
      tenantId: actor.tenantId,
      type: NOTIFICATION_TYPE.ADMIN_VAULT_RESET_REVOKED,
      title: notificationTitle("ADMIN_VAULT_RESET_REVOKED", locale),
      body: notificationBody("ADMIN_VAULT_RESET_REVOKED", locale),
    });

    // Email notification
    if (targetUser.user.email) {
      const adminName = session.user.name ?? session.user.email ?? "";
      const { subject, html, text } = adminVaultResetRevokedEmail(locale, adminName);
      void sendEmail({ to: targetUser.user.email, subject, html, text });
    }
  }

  return NextResponse.json({ ok: true });
}

export const POST = withRequestLog(handlePOST);
