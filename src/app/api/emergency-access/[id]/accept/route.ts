import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { acceptEmergencyGrantByIdSchema } from "@/lib/validations";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { createRateLimiter } from "@/lib/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import { EA_STATUS, AUDIT_TARGET_TYPE } from "@/lib/constants";

const acceptLimiter = createRateLimiter({ windowMs: 5 * 60_000, max: 10 });

// POST /api/emergency-access/[id]/accept — Accept a grant by ID (authenticated grantee)
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id || !session.user.email) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  if (!(await acceptLimiter.check(`rl:ea_accept:${session.user.id}`))) {
    return NextResponse.json({ error: API_ERROR.RATE_LIMIT_EXCEEDED }, { status: 429 });
  }

  const { id } = await params;

  const grant = await prisma.emergencyAccessGrant.findUnique({
    where: { id },
  });

  if (!grant) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }

  if (grant.status !== EA_STATUS.PENDING) {
    return NextResponse.json({ error: API_ERROR.GRANT_NOT_PENDING }, { status: 400 });
  }

  if (grant.tokenExpiresAt < new Date()) {
    return NextResponse.json({ error: API_ERROR.INVITATION_EXPIRED }, { status: 410 });
  }

  if (grant.granteeEmail.toLowerCase() !== session.user.email.toLowerCase()) {
    return NextResponse.json({ error: API_ERROR.NOT_AUTHORIZED_FOR_GRANT }, { status: 403 });
  }

  if (grant.ownerId === session.user.id) {
    return NextResponse.json(
      { error: API_ERROR.CANNOT_GRANT_SELF },
      { status: 400 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: API_ERROR.INVALID_JSON }, { status: 400 });
  }

  const parsed = acceptEmergencyGrantByIdSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: API_ERROR.VALIDATION_ERROR, details: parsed.error.flatten() }, { status: 400 });
  }

  const { granteePublicKey, encryptedPrivateKey } = parsed.data;

  await prisma.$transaction([
    prisma.emergencyAccessGrant.update({
      where: { id },
      data: {
        status: EA_STATUS.ACCEPTED,
        granteeId: session.user.id,
        granteePublicKey,
      },
    }),
    prisma.emergencyAccessKeyPair.create({
      data: {
        grantId: id,
        encryptedPrivateKey: encryptedPrivateKey.ciphertext,
        privateKeyIv: encryptedPrivateKey.iv,
        privateKeyAuthTag: encryptedPrivateKey.authTag,
      },
    }),
  ]);

  logAudit({
    scope: "PERSONAL",
    action: "EMERGENCY_GRANT_ACCEPT",
    userId: session.user.id,
    targetType: AUDIT_TARGET_TYPE.EMERGENCY_ACCESS_GRANT,
    targetId: id,
    metadata: { ownerId: grant.ownerId },
    ...extractRequestMeta(req),
  });

  return NextResponse.json({ status: EA_STATUS.ACCEPTED });
}
