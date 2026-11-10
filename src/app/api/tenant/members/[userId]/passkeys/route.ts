import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTenantPermission } from "@/lib/auth/access/tenant-auth";
import { canRevokeMemberPasskey } from "@/lib/auth/access/tenant-role-hierarchy";
import { withBypassRls } from "@/lib/tenant-rls";
import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
import { TENANT_PERMISSION } from "@/lib/constants/auth/tenant-permission";
import { withRequestLog } from "@/lib/http/with-request-log";
import { requireRecentCurrentAuthMethod } from "@/lib/auth/session/recent-current-auth-method";
import { refuseMemberPasskeyTarget, revokeMemberPasskeys } from "@/lib/tenant/member-passkey-revoke";
import {
  listMemberContainment,
  refusedContainmentKinds,
  toContainmentRequest,
} from "@/lib/tenant/member-containment";
import { memberContainmentSchema } from "@/lib/validations/member-containment";
import { parseOptionalBody } from "@/lib/http/parse-body";
import { forbidden, handleAuthError, notFound, unauthorized } from "@/lib/http/api-response";

export const runtime = "nodejs";

type Params = { params: Promise<{ userId: string }> };

// GET /api/tenant/members/[userId]/passkeys — a member's passkeys, for an admin
// choosing one to revoke (#974). All of them: passkeys are user-global, so one
// registered under the member's previous tenant signs them in here too
// (`registeredInTenant` false). Same gate as the revoke. With them, what a
// revoke-all can contain (#1016): the member's linked IdP accounts and the live
// footholds they created, each kind only when the actor may contain it.
async function handleGET(_req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { userId: targetUserId } = await params;

  let actor;
  try {
    actor = await requireTenantPermission(session.user.id, TENANT_PERMISSION.MEMBER_MANAGE);
  } catch (err) {
    return handleAuthError(err);
  }
  if (targetUserId === session.user.id) {
    return forbidden();
  }

  const result = await withBypassRls(prisma, async (tx) => {
    // The member first, active in the actor's tenant: no credential of anyone
    // else is read.
    const member = await tx.tenantMember.findFirst({
      where: { tenantId: actor.tenantId, userId: targetUserId, deactivatedAt: null },
      select: { role: true },
    });
    if (!member) return null;
    if (!canRevokeMemberPasskey(actor.role, member.role)) return { forbidden: true as const };
    const passkeys = await tx.webAuthnCredential.findMany({
      where: { userId: targetUserId },
      select: {
        id: true,
        tenantId: true,
        nickname: true,
        deviceType: true,
        backedUp: true,
        registeredDevice: true,
        lastUsedDevice: true,
        createdAt: true,
        lastUsedAt: true,
      },
      orderBy: { createdAt: "asc" },
    });
    const containment = await listMemberContainment(tx, {
      tenantId: actor.tenantId,
      targetUserId,
      role: actor.role,
    });
    return { passkeys, ...containment };
  }, BYPASS_GRANT.TENANT_MEMBER_PASSKEY_LIST);
  if (!result) {
    return notFound();
  }
  if ("forbidden" in result) {
    return forbidden();
  }

  return NextResponse.json({
    passkeys: result.passkeys.map(({ tenantId, ...p }) => ({
      ...p,
      registeredInTenant: tenantId === actor.tenantId,
    })),
    linkedAccounts: result.linkedAccounts,
    createdFootholds: result.createdFootholds,
  });
}

// DELETE /api/tenant/members/[userId]/passkeys — revoke ALL of a member's
// passkeys and end their sessions and tokens in every tenant, in one
// transaction under the member's credential lock (revokeMemberPasskeys). The
// containment path: revoking one passkey leaves any other a compromised
// session registered first, to sign back in with. A member with no passkeys is
// contained the same way. An optional body names linked accounts to unlink and
// footholds the member created to revoke in the same transaction (#1016); no
// body, or one naming nothing, contains nothing more.
async function handleDELETE(req: NextRequest, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { userId: targetUserId } = await params;

  let actor;
  try {
    actor = await requireTenantPermission(session.user.id, TENANT_PERMISSION.MEMBER_MANAGE);
  } catch (err) {
    return handleAuthError(err);
  }

  // The body before the step-up: a malformed one is refused without asking.
  const parsed = await parseOptionalBody(req, memberContainmentSchema);
  if (!parsed.ok) return parsed.response;
  const containment = toContainmentRequest(parsed.data);

  const refused = await refuseMemberPasskeyTarget(actor, targetUserId);
  if (refused) return refused;
  if (containment && refusedContainmentKinds(actor.role, containment).length > 0) return forbidden();

  // @stepup id:tenant-member-passkeys-delete-all method:DELETE
  const stepUpError = await requireRecentCurrentAuthMethod(req, session.user.id);
  if (stepUpError) return stepUpError;

  return revokeMemberPasskeys(req, {
    actor: session.user,
    tenantId: actor.tenantId,
    targetUserId,
    scope: { all: true },
    containment,
  });
}

export const GET = withRequestLog(handleGET);
export const DELETE = withRequestLog(handleDELETE);
