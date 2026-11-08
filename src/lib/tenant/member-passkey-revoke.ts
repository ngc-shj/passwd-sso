import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import type { TenantRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logAuditInTx, tenantAuditBase } from "@/lib/audit/audit";
import { canRevokeMemberPasskey } from "@/lib/auth/access/tenant-role-hierarchy";
import { revokeUserAuthArtifactsInTx } from "@/lib/auth/session/user-session-invalidation";
import { lockUserAuthArtifacts } from "@/lib/auth/session/user-auth-serialization";
import { invalidateCachedSessions } from "@/lib/auth/session/session-cache-helpers";
import { withBypassRls, withTenantRls } from "@/lib/tenant-rls";
import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE, NOTIFICATION_TYPE } from "@/lib/constants";
import { ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { SYSTEM_ACTOR_ID } from "@/lib/constants/app";
import { forbidden, notFound } from "@/lib/http/api-response";
import { createNotification } from "@/lib/notification";
import { notificationBody, notificationTitle } from "@/lib/notification/notification-messages";
import { sendEmail } from "@/lib/email";
import { passkeyRevokedByAdminEmail, type PasskeyRevokeExtent } from "@/lib/email/templates/passkey-revoked-by-admin";
import { resolveUserLocale } from "@/lib/locale";
import { getLogger } from "@/lib/logger";
import { errorLogFields } from "@/lib/logger/error-fields";
import { AUDIT_CREDENTIAL_ID_MAX_LENGTH } from "@/lib/validations/common.server";

/** One passkey, or every passkey the member has. */
export type MemberPasskeyRevokeScope = { credentialId: string } | { all: true };

export interface MemberPasskeyRevokeParams {
  /** The signed-in admin, as `auth()` returns them. */
  actor: { id: string; name?: string | null; email?: string | null };
  tenantId: string;
  targetUserId: string;
  scope: MemberPasskeyRevokeScope;
}

/**
 * Answer an ineligible target before the route asks for a step-up: the actor
 * themselves (a member manages their own passkeys in their settings, where the
 * last-passkey rule applies), a non-member, or a role the actor may not touch.
 * Null when eligible; revokeMemberPasskeys re-reads both roles at the delete.
 */
export async function refuseMemberPasskeyTarget(
  actor: { userId: string; tenantId: string; role: TenantRole },
  targetUserId: string,
): Promise<NextResponse | null> {
  if (targetUserId === actor.userId) return forbidden();
  const targetMember = await withTenantRls(prisma, actor.tenantId, async (tx) =>
    tx.tenantMember.findFirst({
      where: { tenantId: actor.tenantId, userId: targetUserId, deactivatedAt: null },
      select: { role: true },
    }),
  );
  if (!targetMember) return notFound();
  if (!canRevokeMemberPasskey(actor.role, targetMember.role)) return forbidden();
  return null;
}

// The revoke-all audit row names at most this many public credential ids, each
// cut to AUDIT_CREDENTIAL_ID_MAX_LENGTH, and counts the rest: a member can hold
// any number of passkeys with ids up to ~1 KB each, and metadata past
// METADATA_MAX_BYTES is replaced whole — targetUserId and every count with it —
// on the record of the containment action itself. 10 × 512 stays well inside.
const REVOKE_ALL_AUDIT_MAX_CREDENTIAL_IDS = 10;

const REVOKE_OUTCOME = {
  NOT_FOUND: "not_found",
  FORBIDDEN: "forbidden",
} as const;

/**
 * A tenant admin revokes a member's passkey, or all of them (#974), after the
 * route has checked the actor's permission and step-up. Passkeys are
 * user-global, so the member's sessions and tokens in EVERY tenant end with
 * them, in the same transaction (a session's authCredentialId is lost when its
 * credential is deleted, so a passkey's own sign-ins cannot be picked out
 * afterwards). The member is told.
 *
 * Revoking every passkey is the containment path: a session that registered a
 * passkey before the revoke took the user lock would otherwise leave that one
 * behind to sign back in with. Under the lock no passkey can be registered
 * meanwhile (register/verify takes it too), and every session that could
 * register one afterwards is gone when it releases.
 */
export async function revokeMemberPasskeys(
  req: NextRequest,
  { actor, tenantId, targetUserId, scope }: MemberPasskeyRevokeParams,
): Promise<NextResponse> {
  const actorUserId = actor.id;
  const extent: PasskeyRevokeExtent = "credentialId" in scope ? "one" : "all";
  // One transaction: both roles re-read (a promotion or demotion committed
  // meanwhile decides), the credentials deleted by count (a concurrent revoke
  // answers 404), the member's sessions and tokens revoked, the audit row
  // written. Any failure rolls all of it back: the passkeys stay, the response
  // is an error, and the admin can retry.
  const outcome = await withBypassRls(prisma, async (tx) => {
    // The member's credential lock first, before the credential row locks the
    // delete takes: a passkey sign-in takes them in the same order.
    await lockUserAuthArtifacts(tx, targetUserId);
    const roles = await tx.tenantMember.findMany({
      where: { tenantId, userId: { in: [actorUserId, targetUserId] }, deactivatedAt: null },
      select: { userId: true, role: true, user: { select: { email: true, locale: true } } },
    });
    const actorRow = roles.find((r) => r.userId === actorUserId);
    const targetRow = roles.find((r) => r.userId === targetUserId);
    if (!targetRow) return REVOKE_OUTCOME.NOT_FOUND;
    if (!actorRow || !canRevokeMemberPasskey(actorRow.role, targetRow.role)) return REVOKE_OUTCOME.FORBIDDEN;

    const credentials = await tx.webAuthnCredential.findMany({
      where: { userId: targetUserId, ...("credentialId" in scope ? { id: scope.credentialId } : {}) },
      select: { id: true, credentialId: true, tenantId: true },
    });
    if (credentials.length === 0) return REVOKE_OUTCOME.NOT_FOUND;
    const { count } = await tx.webAuthnCredential.deleteMany({
      where: { userId: targetUserId, id: { in: credentials.map((c) => c.id) } },
    });
    if (count === 0) return REVOKE_OUTCOME.NOT_FOUND;

    const { counts, sessionTokens } = await revokeUserAuthArtifactsInTx(tx, targetUserId, { tenantFilter: {} });

    // The passkeys a row names: one, or a bounded list with the rest counted.
    const passkeyFields = (subset: typeof credentials) =>
      extent === "one"
        ? { credentialId: subset[0].credentialId }
        : {
            passkeys: subset.length,
            credentialIds: subset
              .slice(0, REVOKE_ALL_AUDIT_MAX_CREDENTIAL_IDS)
              .map((c) => c.credentialId.slice(0, AUDIT_CREDENTIAL_ID_MAX_LENGTH)),
            credentialIdsOmitted: Math.max(0, subset.length - REVOKE_ALL_AUDIT_MAX_CREDENTIAL_IDS),
          };
    const action =
      extent === "one"
        ? {
            action: AUDIT_ACTION.TENANT_MEMBER_PASSKEY_REVOKE,
            targetType: AUDIT_TARGET_TYPE.WEBAUTHN_CREDENTIAL,
            targetId: credentials[0].id,
          }
        : { action: AUDIT_ACTION.TENANT_MEMBER_PASSKEY_REVOKE_ALL, targetType: "User", targetId: targetUserId };

    await logAuditInTx(tx, tenantId, {
      ...tenantAuditBase(req, actorUserId, tenantId),
      ...action,
      metadata: {
        targetUserId,
        ...passkeyFields(credentials),
        ...(extent === "one" ? { registeredInTenant: credentials[0].tenantId === tenantId } : {}),
        ...counts,
      },
    });

    // A passkey registered under another tenant signs the member in there too,
    // so that tenant's admins see its revocation in their own log. What they
    // see is that tenant's own: its passkeys only, and the system as the actor —
    // not the revoking admin, their request, or counts over the member's other
    // tenants — plus the tenant it was revoked from.
    const otherTenants = [...new Set(credentials.map((c) => c.tenantId))].filter((t) => t !== tenantId);
    for (const other of otherTenants) {
      await logAuditInTx(tx, other, {
        scope: AUDIT_SCOPE.TENANT,
        userId: SYSTEM_ACTOR_ID,
        actorType: ACTOR_TYPE.SYSTEM,
        tenantId: other,
        ip: null,
        userAgent: null,
        ...action,
        metadata: {
          targetUserId,
          ...passkeyFields(credentials.filter((c) => c.tenantId === other)),
          ...(extent === "one" ? { registeredInTenant: true } : {}),
          revokedFromTenantId: tenantId,
        },
      });
    }
    return { counts, sessionTokens, target: targetRow.user };
  }, BYPASS_GRANT.TENANT_MEMBER_PASSKEY_REVOKE);
  if (outcome === REVOKE_OUTCOME.NOT_FOUND) return notFound();
  if (outcome === REVOKE_OUTCOME.FORBIDDEN) return forbidden();
  const { counts, sessionTokens, target } = outcome;

  // After the commit, evict the revoked sessions from the proxy's session
  // cache. The cache never authenticates a request on its own (every handler
  // re-reads the session row through auth()), so an entry a Redis failure
  // leaves behind only lets the proxy pass a request the handler then refuses,
  // until its TTL; the failure is still logged and reported, not hidden.
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
    // The same on-call signal invalidateUserSessions raises for a tombstone
    // that did not land.
    Sentry.captureMessage("session cache tombstone failures during tenant member passkey revoke", {
      level: "error",
      tags: { reason: "tenant_member_passkey_revoke" },
      extra: { targetUserId, failures: cacheTombstoneFailures },
    });
  }

  // The member learns of it in the app and by email, as of a vault reset.
  const notificationKey = extent === "one" ? "PASSKEY_REVOKED_BY_ADMIN" : "PASSKEYS_ALL_REVOKED_BY_ADMIN";
  const locale = resolveUserLocale(target.locale);
  createNotification({
    userId: targetUserId,
    tenantId,
    type: NOTIFICATION_TYPE.SECURITY_ALERT,
    title: notificationTitle(notificationKey, locale),
    body: notificationBody(notificationKey, locale),
  });
  if (target.email) {
    const { subject, html, text } = passkeyRevokedByAdminEmail(locale, actor.name ?? actor.email ?? "", extent);
    void sendEmail({ to: target.email, subject, html, text });
  }

  return NextResponse.json({
    ok: true,
    sessionsRevoked: counts.sessions,
    cacheTombstoneFailures,
  });
}
