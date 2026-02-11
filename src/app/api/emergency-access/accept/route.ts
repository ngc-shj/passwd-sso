import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { acceptEmergencyGrantSchema } from "@/lib/validations";
import { hashToken } from "@/lib/crypto-server";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { createRateLimiter } from "@/lib/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";

const acceptLimiter = createRateLimiter({ windowMs: 5 * 60_000, max: 10 });

// POST /api/emergency-access/accept — Accept an emergency access invitation
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id || !session.user.email) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  if (!(await acceptLimiter.check(`rl:ea_accept:${session.user.id}`))) {
    return NextResponse.json({ error: API_ERROR.RATE_LIMIT_EXCEEDED }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: API_ERROR.INVALID_JSON }, { status: 400 });
  }

  const parsed = acceptEmergencyGrantSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: API_ERROR.VALIDATION_ERROR, details: parsed.error.flatten() }, { status: 400 });
  }

  const { token, granteePublicKey, encryptedPrivateKey } = parsed.data;

  // Hash the token for DB lookup (DB stores only the hash)
  const grant = await prisma.emergencyAccessGrant.findUnique({
    where: { tokenHash: hashToken(token) },
  });

  if (!grant) {
    return NextResponse.json(
      { error: API_ERROR.NOT_FOUND },
      { status: 404 }
    );
  }

  if (grant.status !== "PENDING") {
    return NextResponse.json({ error: API_ERROR.INVITATION_ALREADY_USED }, { status: 410 });
  }

  if (grant.tokenExpiresAt < new Date()) {
    return NextResponse.json({ error: API_ERROR.INVITATION_EXPIRED }, { status: 410 });
  }

  if (grant.granteeEmail.toLowerCase() !== session.user.email.toLowerCase()) {
    return NextResponse.json(
      { error: API_ERROR.INVITATION_WRONG_EMAIL },
      { status: 403 }
    );
  }

  // Cannot accept own grant
  if (grant.ownerId === session.user.id) {
    return NextResponse.json(
      { error: API_ERROR.CANNOT_GRANT_SELF },
      { status: 400 }
    );
  }

  await prisma.$transaction([
    prisma.emergencyAccessGrant.update({
      where: { id: grant.id },
      data: {
        status: "ACCEPTED",
        granteeId: session.user.id,
        granteePublicKey,
      },
    }),
    prisma.emergencyAccessKeyPair.create({
      data: {
        grantId: grant.id,
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
    targetType: "EmergencyAccessGrant",
    targetId: grant.id,
    metadata: { ownerId: grant.ownerId },
    ...extractRequestMeta(req),
  });

  return NextResponse.json({ status: "ACCEPTED" });
}
