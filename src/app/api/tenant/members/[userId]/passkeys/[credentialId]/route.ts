import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAuditInTx, tenantAuditBase } from "@/lib/audit/audit";
import { requireTenantPermission } from "@/lib/auth/access/tenant-auth";
import { canRevokeMemberPasskey } from "@/lib/auth/access/tenant-role-hierarchy";
import { requireRecentCurrentAuthMethod } from "@/lib/auth/session/recent-current-auth-method";
import { revokeUserAuthArtifactsInTx } from "@/lib/auth/session/user-session-invalidation";
import { invalidateCachedSessions } from "@/lib/auth/session/session-cache-helpers";
import { withBypassRls, withTenantRls } from "@/lib/tenant-rls";
import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
import { TENANT_PERMISSION } from "@/lib/constants/auth/tenant-permission";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE, NOTIFICATION_TYPE } from "@/lib/constants";
import { withRequestLog } from "@/lib/http/with-request-log";
import { forbidden, handleAuthError, notFound, unauthorized } from "@/lib/http/api-response";
import { createNotification } from "@/lib/notification";
import { notificationBody, notificationTitle } from "@/lib/notification/notification-messages";
import { sendEmail } from "@/lib/email";
import { passkeyRevokedByAdminEmail } from "@/lib/email/templates/passkey-revoked-by-admin";
import { resolveUserLocale } from "@/lib/locale";
import { getLogger } from "@/lib/logger";
import { errorLogFields } from "@/lib/logger/error-fields";

export const runtime = "nodejs";

type Params = { params: Promise<{ userId: string; credentialId: string }> };

const REVOKE_OUTCOME = {
  NOT_FOUND: "not_found",
  FORBIDDEN: "forbidden",
} as const;

// DELETE /api/tenant/members/[userId]/passkeys/[credentialId]
// Revoke one of a member's passkeys (#974): the recovery path when a member's
// only passkey is compromised and the tenant requires passkeys, where the
// member cannot delete it themselves (CANNOT_DELETE_LAST_PASSKEY). Passkeys are
// user-global, so one registered under the member's previous tenant is
// revocable here too, and what it may have signed in is too: the member's
// sessions and tokens in EVERY tenant end with it, in the same transaction
// (a session's authCredentialId is lost when its credential is deleted, so the
// passkey's own sign-ins cannot be picked out afterwards). The member is told.
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

  // Answer an ineligible target before asking for a step-up; the transaction
  // below re-reads both roles at the delete.
  const targetMember = await withTenantRls(prisma, actor.tenantId, async (tx) =>
    tx.tenantMember.findFirst({
      where: { tenantId: actor.tenantId, userId: targetUserId, deactivatedAt: null },
      select: { role: true },
    }),
  );
  if (!targetMember) {
    return notFound();
  }
  if (!canRevokeMemberPasskey(actor.role, targetMember.role)) {
    return forbidden();
  }

  // @stepup id:tenant-member-passkey-delete method:DELETE
  const stepUpError = await requireRecentCurrentAuthMethod(req, session.user.id);
  if (stepUpError) return stepUpError;

  // One transaction: both roles re-read (a promotion or demotion committed
  // meanwhile decides), the credential deleted by count (a concurrent revoke
  // answers 404), the member's sessions and tokens revoked, the audit row
  // written. Any failure rolls all of it back: the passkey stays, the response
  // is an error, and the admin can retry.
  const outcome = await withBypassRls(prisma, async (tx) => {
    const roles = await tx.tenantMember.findMany({
      where: { tenantId: actor.tenantId, userId: { in: [session.user.id, targetUserId] }, deactivatedAt: null },
      select: { userId: true, role: true, user: { select: { email: true, locale: true } } },
    });
    const actorRow = roles.find((r) => r.userId === session.user.id);
    const targetRow = roles.find((r) => r.userId === targetUserId);
    if (!targetRow) return REVOKE_OUTCOME.NOT_FOUND;
    if (!actorRow || !canRevokeMemberPasskey(actorRow.role, targetRow.role)) return REVOKE_OUTCOME.FORBIDDEN;

    const credential = await tx.webAuthnCredential.findFirst({
      where: { id: credentialId, userId: targetUserId },
      select: { id: true, credentialId: true, tenantId: true },
    });
    if (!credential) return REVOKE_OUTCOME.NOT_FOUND;
    const { count } = await tx.webAuthnCredential.deleteMany({ where: { id: credential.id, userId: targetUserId } });
    if (count === 0) return REVOKE_OUTCOME.NOT_FOUND;

    const { counts, sessionTokens } = await revokeUserAuthArtifactsInTx(tx, targetUserId, { tenantFilter: {} });

    await logAuditInTx(tx, actor.tenantId, {
      ...tenantAuditBase(req, session.user.id, actor.tenantId),
      action: AUDIT_ACTION.TENANT_MEMBER_PASSKEY_REVOKE,
      targetType: AUDIT_TARGET_TYPE.WEBAUTHN_CREDENTIAL,
      targetId: credential.id,
      metadata: {
        targetUserId,
        credentialId: credential.credentialId,
        registeredInTenant: credential.tenantId === actor.tenantId,
        ...counts,
      },
    });
    return { credential, counts, sessionTokens, target: targetRow.user };
  }, BYPASS_GRANT.TENANT_MEMBER_PASSKEY_REVOKE);
  if (outcome === REVOKE_OUTCOME.NOT_FOUND) return notFound();
  if (outcome === REVOKE_OUTCOME.FORBIDDEN) return forbidden();
  const { counts, sessionTokens, target } = outcome;

  // After the commit, evict the revoked sessions from the session cache. The
  // rows are gone, so a cache entry that survives a Redis failure lasts only
  // its TTL; the failure is logged and reported to the admin, not hidden.
  let cacheTombstoneFailures = 0;
  try {
    cacheTombstoneFailures = (await invalidateCachedSessions(sessionTokens)).failed;
  } catch (err) {
    cacheTombstoneFailures = sessionTokens.length;
    getLogger().error(
      { error: errorLogFields(err), targetUserId, _logType: "tenant.member_passkey_revoke_cache_invalidation_failed" },
      "tenant member passkey revoke: session cache invalidation failed",
    );
  }
  if (cacheTombstoneFailures > 0) {
    getLogger().error(
      { targetUserId, failures: cacheTombstoneFailures, reason: "tenant_member_passkey_revoke", _logType: "session.cache_tombstone_failures" },
      "session.cache_tombstone_failures",
    );
  }

  // The member learns of it in the app and by email, as of a vault reset.
  const locale = resolveUserLocale(target.locale);
  createNotification({
    userId: targetUserId,
    tenantId: actor.tenantId,
    type: NOTIFICATION_TYPE.SECURITY_ALERT,
    title: notificationTitle("PASSKEY_REVOKED_BY_ADMIN", locale),
    body: notificationBody("PASSKEY_REVOKED_BY_ADMIN", locale),
  });
  if (target.email) {
    const { subject, html, text } = passkeyRevokedByAdminEmail(locale, session.user.name ?? session.user.email ?? "");
    void sendEmail({ to: target.email, subject, html, text });
  }

  return NextResponse.json({
    ok: true,
    sessionsRevoked: counts.sessions,
    cacheTombstoneFailures,
  });
}

export const DELETE = withRequestLog(handleDELETE);
