import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { requireTenantPermission, isTenantRoleAbove } from "@/lib/auth/access/tenant-auth";
import { requireRecentCurrentAuthMethod } from "@/lib/auth/session/recent-current-auth-method";
import {
  invalidateUserSessions,
  invalidateUserSessionsCache,
  type InvalidateUserSessionsResult,
} from "@/lib/auth/session/user-session-invalidation";
import { withTenantRls } from "@/lib/tenant-rls";
import { TENANT_PERMISSION } from "@/lib/constants/auth/tenant-permission";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { withRequestLog } from "@/lib/http/with-request-log";
import { forbidden, handleAuthError, notFound, unauthorized } from "@/lib/http/api-response";
import { getLogger } from "@/lib/logger";
import { errorLogFields } from "@/lib/logger/error-fields";

export const runtime = "nodejs";

type Params = { params: Promise<{ userId: string; credentialId: string }> };

// DELETE /api/tenant/members/[userId]/passkeys/[credentialId]
// Revoke one of a member's passkeys (#974): the recovery path when a member's
// only passkey is compromised and the tenant requires passkeys, where the
// member cannot delete it themselves (CANNOT_DELETE_LAST_PASSKEY). A passkey
// presumed compromised may have signed someone in, so the member's sessions
// and tokens in this tenant are revoked with it.
async function handleDELETE(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { userId: targetUserId, credentialId } = await params;

  let actor;
  try {
    actor = await requireTenantPermission(session.user.id, TENANT_PERMISSION.MEMBER_MANAGE);
  } catch (err) {
    return handleAuthError(err);
  }

  // A member manages their own passkeys in their settings, where the
  // last-passkey rule applies.
  if (targetUserId === session.user.id) {
    return forbidden();
  }

  const targetMember = await withTenantRls(prisma, actor.tenantId, async (tx) =>
    tx.tenantMember.findFirst({
      where: { tenantId: actor.tenantId, userId: targetUserId, deactivatedAt: null },
      select: { role: true },
    }),
  );
  if (!targetMember) {
    return notFound();
  }
  if (!isTenantRoleAbove(actor.role, targetMember.role)) {
    return forbidden();
  }

  // @stepup id:tenant-member-passkey-delete method:DELETE
  const stepUpError = await requireRecentCurrentAuthMethod(req, session.user.id);
  if (stepUpError) return stepUpError;

  // A passkey registered under another tenant is not visible here: 404.
  const deleted = await withTenantRls(prisma, actor.tenantId, async (tx) => {
    const credential = await tx.webAuthnCredential.findFirst({
      where: { id: credentialId, userId: targetUserId, tenantId: actor.tenantId },
      select: { id: true, credentialId: true },
    });
    if (!credential) return null;
    await tx.webAuthnCredential.delete({ where: { id: credential.id } });
    return credential;
  });
  if (!deleted) {
    return notFound();
  }

  // After the delete commits: end what the passkey may have signed in, then
  // drop every cached `hasPasskey` snapshot of the member (passkeys are
  // user-global). The credential is gone either way; a failure here is logged
  // and recorded in the audit row, sessions and cache entries still expire.
  let invalidation: InvalidateUserSessionsResult | null = null;
  let invalidationFailed = false;
  try {
    invalidation = await invalidateUserSessions(targetUserId, { tenantId: actor.tenantId });
    await invalidateUserSessionsCache(targetUserId);
  } catch (err) {
    invalidationFailed = true;
    getLogger().error(
      { error: errorLogFields(err), targetUserId, _logType: "tenant.member_passkey_revoke_invalidation_failed" },
      "tenant member passkey revoke: session invalidation failed",
    );
  }

  // An outcome audit (the invalidation counts), so it follows the steps it
  // records, like the admin vault reset's.
  await logAuditAsync({
    ...tenantAuditBase(req, session.user.id, actor.tenantId),
    action: AUDIT_ACTION.TENANT_MEMBER_PASSKEY_REVOKE,
    targetType: AUDIT_TARGET_TYPE.WEBAUTHN_CREDENTIAL,
    targetId: deleted.id,
    metadata: {
      targetUserId,
      credentialId: deleted.credentialId,
      ...(invalidation ?? {}),
      ...(invalidationFailed ? { invalidationFailed: true } : {}),
    },
  });

  return NextResponse.json({
    ok: true,
    sessionsRevoked: invalidation?.sessions ?? null,
  });
}

export const DELETE = withRequestLog(handleDELETE);
