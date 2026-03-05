import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { API_ERROR } from "@/lib/api-error-codes";
import { withRequestLog } from "@/lib/with-request-log";
import { withUserTenantRls } from "@/lib/tenant-context";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";

export const runtime = "nodejs";

const patchSchema = z.object({
  nickname: z.string().max(100),
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

  logAudit({
    scope: AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.WEBAUTHN_CREDENTIAL_DELETE,
    userId,
    targetType: AUDIT_TARGET_TYPE.WEBAUTHN_CREDENTIAL,
    targetId: id,
    metadata: { credentialId: existing.credentialId },
    ...extractRequestMeta(req),
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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: API_ERROR.INVALID_JSON },
      { status: 400 },
    );
  }

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR, details: parsed.error.flatten() },
      { status: 400 },
    );
  }

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
      data: { nickname: parsed.data.nickname },
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
