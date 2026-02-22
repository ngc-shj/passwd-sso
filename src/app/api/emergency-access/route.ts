import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createEmergencyGrantSchema } from "@/lib/validations";
import { generateShareToken, hashToken } from "@/lib/crypto-server";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { sendEmail } from "@/lib/email";
import { emergencyInviteEmail } from "@/lib/email/templates/emergency-access";
import { createRateLimiter } from "@/lib/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import { EA_STATUS, AUDIT_TARGET_TYPE, AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";

const createLimiter = createRateLimiter({ windowMs: 15 * 60_000, max: 5 });

// POST /api/emergency-access — Create a new emergency access grant
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id || !session.user.email) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  if (!(await createLimiter.check(`rl:ea_create:${session.user.id}`))) {
    return NextResponse.json({ error: API_ERROR.RATE_LIMIT_EXCEEDED }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: API_ERROR.INVALID_JSON }, { status: 400 });
  }

  const parsed = createEmergencyGrantSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: API_ERROR.VALIDATION_ERROR, details: parsed.error.flatten() }, { status: 400 });
  }

  const { granteeEmail, waitDays } = parsed.data;

  // Cannot grant to self
  if (granteeEmail.toLowerCase() === session.user.email.toLowerCase()) {
    return NextResponse.json(
      { error: API_ERROR.CANNOT_GRANT_SELF },
      { status: 400 }
    );
  }

  // Check for duplicate active grant
  const existing = await prisma.emergencyAccessGrant.findFirst({
    where: {
      ownerId: session.user.id,
      granteeEmail: { equals: granteeEmail, mode: "insensitive" },
      status: { notIn: [EA_STATUS.REVOKED, EA_STATUS.REJECTED] },
    },
  });

  if (existing) {
    return NextResponse.json(
      { error: API_ERROR.DUPLICATE_GRANT },
      { status: 409 }
    );
  }

  const token = generateShareToken();
  const tokenExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const grant = await prisma.emergencyAccessGrant.create({
    data: {
      ownerId: session.user.id,
      granteeEmail,
      waitDays,
      tokenHash: hashToken(token),
      tokenExpiresAt,
    },
  });

  logAudit({
    scope: AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.EMERGENCY_GRANT_CREATE,
    userId: session.user.id,
    targetType: AUDIT_TARGET_TYPE.EMERGENCY_ACCESS_GRANT,
    targetId: grant.id,
    metadata: { granteeEmail, waitDays },
    ...extractRequestMeta(req),
  });

  const ownerName = session.user.name ?? session.user.email ?? "";
  const { subject, html, text } = emergencyInviteEmail("ja", ownerName);
  sendEmail({ to: granteeEmail, subject, html, text });

  // Return plaintext token only at creation time; DB stores only the hash
  return NextResponse.json({
    id: grant.id,
    token,
    status: grant.status,
    granteeEmail: grant.granteeEmail,
    waitDays: grant.waitDays,
    tokenExpiresAt: grant.tokenExpiresAt.toISOString(),
  });
}

// GET /api/emergency-access — List emergency access grants
export async function GET() {
  const session = await auth();
  if (!session?.user?.id || !session.user.email) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const grants = await prisma.emergencyAccessGrant.findMany({
    where: {
      OR: [
        { ownerId: session.user.id },
        { granteeId: session.user.id },
        {
          granteeEmail: { equals: session.user.email, mode: "insensitive" },
          status: EA_STATUS.PENDING,
        },
      ],
    },
    include: {
      owner: { select: { id: true, name: true, email: true, image: true } },
      grantee: { select: { id: true, name: true, email: true, image: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  const result = grants.map((g) => ({
    id: g.id,
    ownerId: g.ownerId,
    granteeId: g.granteeId,
    granteeEmail: g.granteeEmail,
    status: g.status,
    waitDays: g.waitDays,
    keyAlgorithm: g.keyAlgorithm,
    requestedAt: g.requestedAt?.toISOString() ?? null,
    activatedAt: g.activatedAt?.toISOString() ?? null,
    waitExpiresAt: g.waitExpiresAt?.toISOString() ?? null,
    revokedAt: g.revokedAt?.toISOString() ?? null,
    createdAt: g.createdAt.toISOString(),
    // Token hash is never exposed — plaintext token only returned at creation time
    owner: g.owner,
    grantee: g.grantee,
  }));

  return NextResponse.json(result);
}
