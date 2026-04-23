import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { API_ERROR } from "@/lib/api-error-codes";
import { parseBody } from "@/lib/parse-body";
import { withRequestLog } from "@/lib/with-request-log";
import { withUserTenantRls } from "@/lib/tenant-context";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { WEBAUTHN_NICKNAME_MAX_LENGTH } from "@/lib/validations/common";

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
    return NextResponse.json(
      { error: API_ERROR.UNAUTHORIZED },
      { status: 401 },
    );
  }
  const userId = session.user.id;
  const { id } = await params;

  const existing = await withUserTenantRls(userId, async () =>
    prisma.webAuthnCredential.findFirst({
      where: { id, userId },
      select: { id: true, credentialId: true },
    }),
  );

  if (!existing) {
    return NextResponse.json(
      { error: API_ERROR.NOT_FOUND },
      { status: 404 },
    );
  }

  await withUserTenantRls(userId, async () =>
    prisma.webAuthnCredential.delete({
      where: { id },
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
    return NextResponse.json(
      { error: API_ERROR.UNAUTHORIZED },
      { status: 401 },
    );
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
    return NextResponse.json(
      { error: API_ERROR.NOT_FOUND },
      { status: 404 },
    );
  }

  const updated = await withUserTenantRls(userId, async () =>
    prisma.webAuthnCredential.update({
      where: { id },
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
