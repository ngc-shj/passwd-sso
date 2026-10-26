import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { errorResponse, notFound, unauthorized } from "@/lib/http/api-response";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { parseBody } from "@/lib/http/parse-body";
import { withRequestLog } from "@/lib/http/with-request-log";
import { withUserTenantRls } from "@/lib/tenant-context";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { WEBAUTHN_NICKNAME_MAX_LENGTH } from "@/lib/validations/common";
import { requireRecentCurrentAuthMethod } from "@/lib/auth/session/recent-current-auth-method";
import {
  countUserPasskeys,
  derivePasskeyState,
  passkeyEnforcementBlocks,
} from "@/lib/auth/policy/passkey-enforcement";
import { invalidateUserSessionsCache } from "@/lib/auth/session/user-session-invalidation";
import { getLogger } from "@/lib/logger";

export const runtime = "nodejs";

const patchSchema = z.object({
  nickname: z.string().max(WEBAUTHN_NICKNAME_MAX_LENGTH),
});

// DELETE /api/webauthn/credentials/[id] — remove a credential
async function handleDELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }
  const userId = session.user.id;
  const { id } = await params;

  // C9 (OWASP A01-2): step-up required. Passkey deletion removes an
  // AAL3 credential — a stolen session cookie alone must not suffice.
  // requireRecentCurrentAuthMethod re-asserts the SAME auth method
  // (passkey users re-prove passkey; password users re-prove password)
  // within the last 15 minutes, preventing a password-based session
  // from being used to delete a passkey.
  // @stepup id:webauthn-credential-delete method:DELETE
  const stepUp = await requireRecentCurrentAuthMethod(req, session.user.id);
  if (stepUp) return stepUp;

  const { tenantId, existing } = await withUserTenantRls(userId, async (tid) => ({
    tenantId: tid,
    existing: await prisma.webAuthnCredential.findFirst({
      where: { id, userId },
      select: { id: true, credentialId: true },
    }),
  }));

  if (!existing) {
    return notFound();
  }

  // FN-2 (#959): in a tenant whose passkey requirement is past its grace
  // period, deleting the last passkey would block the member, and this
  // session could not recover in place: a webauthn session loses its bound
  // credential (authCredentialId is SetNull), so its step-up stays stale and
  // registering a replacement needs a full sign-out. Refuse instead, and let
  // the member register the replacement first. The count is user-global,
  // like `hasPasskey`.
  //
  // Not serialized against a concurrent delete: two parallel deletes of the
  // user's last two passkeys can both pass. That needs two fresh step-ups by
  // the user themselves, and lands where this check would otherwise have
  // left them (blocked, re-register after signing in again), so it opens no
  // bypass of the requirement.
  const pkState = await derivePasskeyState({ userId, tenantId });
  if (
    passkeyEnforcementBlocks({ ...pkState, hasPasskey: false }) &&
    (await countUserPasskeys(userId)) <= 1
  ) {
    return errorResponse(API_ERROR.CANNOT_DELETE_LAST_PASSKEY);
  }

  await withUserTenantRls(userId, async () =>
    prisma.webAuthnCredential.delete({
      where: { id, userId },
    }),
  );

  // F5/F19 (#959): every writer of `hasPasskey` invalidates the user's cached
  // sessions (cross-tenant — passkeys are user-global), so deleting the last
  // passkey after grace is not still served `hasPasskey: true` from cache.
  // The delete has already committed, so neither failure mode fails this
  // response (entries still expire on TTL): a Redis tombstone failure does not
  // throw and is counted in the audit row's `cacheTombstoneFailures`; a thrown
  // error (the session read) is logged.
  let cacheInvalidation: { totalSessions: number; cacheTombstoneFailures: number } | null = null;
  try {
    cacheInvalidation = await invalidateUserSessionsCache(userId);
  } catch (err) {
    getLogger().error(
      { err, userId, _logType: "webauthn.credential_delete_cache_invalidation_failed" },
      "webauthn credential delete: invalidateUserSessionsCache failed",
    );
  }

  await logAuditAsync({
    ...personalAuditBase(req, userId),
    action: AUDIT_ACTION.WEBAUTHN_CREDENTIAL_DELETE,
    targetType: AUDIT_TARGET_TYPE.WEBAUTHN_CREDENTIAL,
    targetId: id,
    metadata: {
      credentialId: existing.credentialId,
      ...(cacheInvalidation
        ? {
            cacheInvalidatedSessions: cacheInvalidation.totalSessions,
            cacheTombstoneFailures: cacheInvalidation.cacheTombstoneFailures,
          }
        : {}),
    },
  });

  return NextResponse.json({ success: true });
}

// PATCH /api/webauthn/credentials/[id] — update nickname
async function handlePATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }
  const userId = session.user.id;
  const { id } = await params;

  const result = await parseBody(req, patchSchema);
  if (!result.ok) return result.response;
  const { data } = result;

  const existing = await withUserTenantRls(userId, async () =>
    prisma.webAuthnCredential.findFirst({
      where: { id, userId },
      select: { id: true },
    }),
  );

  if (!existing) {
    return notFound();
  }

  const updated = await withUserTenantRls(userId, async () =>
    prisma.webAuthnCredential.update({
      where: { id, userId },
      data: { nickname: data.nickname },
      select: {
        id: true,
        nickname: true,
        deviceType: true,
        backedUp: true,
        prfSupported: true,
        createdAt: true,
        lastUsedAt: true,
      },
    }),
  );

  return NextResponse.json(updated);
}

export const DELETE = withRequestLog(handleDELETE);
export const PATCH = withRequestLog(handlePATCH);
