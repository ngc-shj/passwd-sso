import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { transition } from "@/lib/emergency-access/emergency-access-state";
import { logAuditInTx, personalAuditBase } from "@/lib/audit/audit";
import { EA_ACTIVATE_OUTCOME } from "@/lib/emergency-access/vault-auto-promote";
import { sendEmail } from "@/lib/email";
import { emergencyAccessApprovedEmail } from "@/lib/email/templates/emergency-access";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { EA_STATUS, EA_ACTOR, AUDIT_TARGET_TYPE, AUDIT_ACTION } from "@/lib/constants";
import { resolveUserLocale } from "@/lib/locale";
import { withUserTenantRls, resolveUserTenantId } from "@/lib/tenant-context";
import { withBypassRls, withTenantRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse, notFound, unauthorized } from "@/lib/http/api-response";

// POST /api/emergency-access/[id]/approve — Owner early-approves emergency access request
async function handlePOST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { id } = await params;

  const grant = await withUserTenantRls(session.user.id, async () =>
    prisma.emergencyAccessGrant.findUnique({
      where: { id },
      select: { ownerId: true, granteeId: true },
    }),
  );

  if (!grant || grant.ownerId !== session.user.id) {
    return notFound();
  }

  // Atomic compare-and-swap on status: blocks concurrent transitions out of the
  // permitted from-set even if a parallel revoke/request/etc. lands between
  // the read above and this write.
  //
  // `withUserTenantRls` is opened into its two exported parts here so the
  // callback receives the `tx` and the caller holds the `tenantId` —
  // `logAuditInTx` needs both, and the wrapper's callback signature hands out
  // neither. The helper's own signature is unchanged; this is one call site
  // choosing the lower-level form, not a contract change.
  //
  // The callback holds ONLY the CAS and its audit row. The grantee lookup below
  // needs `withBypassRls` (the grantee may be in another tenant), which inside
  // this tenant context is a nesting the guard refuses; and `void sendEmail`
  // inside an open transaction would inherit its async scope. Both stay out.
  const tenantId = await resolveUserTenantId(session.user.id);
  if (!tenantId) {
    throw new Error("TENANT_NOT_RESOLVED");
  }

  const transitionResult = await withTenantRls(prisma, tenantId, async (tx) => {
    const result = await transition({
      db: tx,
      where: { id, ownerId: session.user.id },
      to: EA_STATUS.ACTIVATED,
      actor: EA_ACTOR.OWNER,
      extraData: { activatedAt: new Date() },
    });
    if (!result.ok) return result;

    // Atomic with the CAS. This route does NOT release the key material — it
    // flips the grant to ACTIVATED and the grantee fetches it on a later
    // request — so the row says `approved`, not `released`. It is still the
    // only record that the owner authorised the release, which is what makes
    // losing it to a crash between commit and enqueue the case that put this
    // action in CRITICAL_ACTIONS.
    await logAuditInTx(tx, tenantId, {
      ...personalAuditBase(req, session.user.id),
      action: AUDIT_ACTION.EMERGENCY_ACCESS_ACTIVATE,
      targetType: AUDIT_TARGET_TYPE.EMERGENCY_ACCESS_GRANT,
      targetId: id,
      metadata: {
        granteeId: grant.granteeId,
        earlyApproval: true,
        outcome: EA_ACTIVATE_OUTCOME.APPROVED,
      },
    });
    return result;
  });

  if (!transitionResult.ok) {
    return errorResponse(API_ERROR.INVALID_STATUS);
  }

  const granteeId = grant.granteeId;
  if (granteeId) {
    // Bypass RLS: grantee may be in a different tenant
    const grantee = await withBypassRls(prisma, async (tx) =>
      tx.user.findUnique({
        where: { id: granteeId },
        select: { email: true, name: true, locale: true },
      }),
    BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);
    if (grantee?.email) {
      const ownerName = session.user.name ?? session.user.email ?? "";
      const { subject, html, text } = emergencyAccessApprovedEmail(resolveUserLocale(grantee.locale), ownerName);
      void sendEmail({ to: grantee.email, subject, html, text });
    }
  }

  return NextResponse.json({ status: EA_STATUS.ACTIVATED });
}

export const POST = withRequestLog(handlePOST);
