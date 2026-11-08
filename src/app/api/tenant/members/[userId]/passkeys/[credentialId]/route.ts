import { NextRequest } from "next/server";
import { auth } from "@/auth";
import { requireTenantPermission } from "@/lib/auth/access/tenant-auth";
import { requireRecentCurrentAuthMethod } from "@/lib/auth/session/recent-current-auth-method";
import { TENANT_PERMISSION } from "@/lib/constants/auth/tenant-permission";
import { withRequestLog } from "@/lib/http/with-request-log";
import { handleAuthError, unauthorized } from "@/lib/http/api-response";
import { refuseMemberPasskeyTarget, revokeMemberPasskeys } from "@/lib/tenant/member-passkey-revoke";

export const runtime = "nodejs";

type Params = { params: Promise<{ userId: string; credentialId: string }> };

// DELETE /api/tenant/members/[userId]/passkeys/[credentialId]
// Revoke one of a member's passkeys (#974): the recovery path when a member's
// only passkey is compromised and the tenant requires passkeys, where the
// member cannot delete it themselves (CANNOT_DELETE_LAST_PASSKEY). Passkeys are
// user-global, so one registered under the member's previous tenant is
// revocable here too, and the member's sessions and tokens in every tenant end
// with it (revokeMemberPasskeys). DELETE .../passkeys revokes all of them.
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

  const refused = await refuseMemberPasskeyTarget(actor, targetUserId);
  if (refused) return refused;

  // @stepup id:tenant-member-passkey-delete method:DELETE
  const stepUpError = await requireRecentCurrentAuthMethod(req, session.user.id);
  if (stepUpError) return stepUpError;

  return revokeMemberPasskeys(req, {
    actor: session.user,
    tenantId: actor.tenantId,
    targetUserId,
    scope: { credentialId },
  });
}

export const DELETE = withRequestLog(handleDELETE);
