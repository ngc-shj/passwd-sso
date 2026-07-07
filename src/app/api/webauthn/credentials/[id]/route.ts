import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { notFound, unauthorized } from "@/lib/http/api-response";
import { parseBody } from "@/lib/http/parse-body";
import { withRequestLog } from "@/lib/http/with-request-log";
import { withUserTenantRls } from "@/lib/tenant-context";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { WEBAUTHN_NICKNAME_MAX_LENGTH } from "@/lib/validations/common";
import { requireRecentCurrentAuthMethod } from "@/lib/auth/session/recent-current-auth-method";

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
  const stepUp = await requireRecentCurrentAuthMethod(req);
  if (stepUp) return stepUp;

  const existing = await withUserTenantRls(userId, async () =>
    prisma.webAuthnCredential.findFirst({
      where: { id, userId },
      select: { id: true, credentialId: true },
    }),
  );

  if (!existing) {
    return notFound();
  }

  await withUserTenantRls(userId, async () =>
    prisma.webAuthnCredential.delete({
      where: { id, userId },
    }),
  );

  await logAuditAsync({
    ...personalAuditBase(req, userId),
    action: AUDIT_ACTION.WEBAUTHN_CREDENTIAL_DELETE,
    targetType: AUDIT_TARGET_TYPE.WEBAUTHN_CREDENTIAL,
    targetId: id,
    metadata: { credentialId: existing.credentialId },
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
