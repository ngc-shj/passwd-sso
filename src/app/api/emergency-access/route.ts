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
import { resolveUserLocale } from "@/lib/locale";
import { withUserTenantRls } from "@/lib/tenant-context";
import { parseBody } from "@/lib/parse-body";
import { withRequestLog } from "@/lib/with-request-log";

const createLimiter = createRateLimiter({ windowMs: 15 * 60_000, max: 5 });

// POST /api/emergency-access — Create a new emergency access grant
async function handlePOST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id || !session.user.email) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }
  const sessionEmail = session.user.email;

  if (!(await createLimiter.check(`rl:ea_create:${session.user.id}`)).allowed) {
    return NextResponse.json({ error: API_ERROR.RATE_LIMIT_EXCEEDED }, { status: 429 });
  }

  const result = await parseBody(req, createEmergencyGrantSchema);
  if (!result.ok) return result.response;
  const { granteeEmail, waitDays } = result.data;

  // Cannot grant to self
  if (granteeEmail.toLowerCase() === sessionEmail.toLowerCase()) {
    return NextResponse.json(
      { error: API_ERROR.CANNOT_GRANT_SELF },
      { status: 400 }
    );
  }

  // Check for duplicate active grant
  const existing = await withUserTenantRls(session.user.id, async () =>
    prisma.emergencyAccessGrant.findFirst({
      where: {
        ownerId: session.user.id,
        granteeEmail: { equals: granteeEmail, mode: "insensitive" },
        status: { notIn: [EA_STATUS.REVOKED, EA_STATUS.REJECTED] },
      },
    }),
  );

  if (existing) {
    return NextResponse.json(
      { error: API_ERROR.DUPLICATE_GRANT },
      { status: 409 }
    );
  }

  const token = generateShareToken();
  const tokenExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const operator = await withUserTenantRls(session.user.id, async () =>
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: { tenantId: true },
    }),
  );
  if (!operator) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const grant = await withUserTenantRls(session.user.id, async () =>
    prisma.emergencyAccessGrant.create({
      data: {
        ownerId: session.user.id,
        tenantId: operator.tenantId,
        granteeEmail,
        waitDays,
        tokenHash: hashToken(token),
        tokenExpiresAt,
      },
    }),
  );

  logAudit({
    scope: AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.EMERGENCY_GRANT_CREATE,
    userId: session.user.id,
    targetType: AUDIT_TARGET_TYPE.EMERGENCY_ACCESS_GRANT,
    targetId: grant.id,
    metadata: { granteeEmail, waitDays },
    ...extractRequestMeta(req),
  });

  // Best-effort: look up grantee's locale if they already have an account
  const granteeUser = await withUserTenantRls(session.user.id, async () =>
    prisma.user.findFirst({
      where: { email: { equals: granteeEmail, mode: "insensitive" } },
      select: { locale: true },
    }),
  );
  const locale = resolveUserLocale(granteeUser?.locale);
  const ownerName = session.user.name ?? session.user.email ?? "";
  const { subject, html, text } = emergencyInviteEmail(locale, ownerName);
  void sendEmail({ to: granteeEmail, subject, html, text });

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
async function handleGET() {
  const session = await auth();
  if (!session?.user?.id || !session.user.email) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }
  const sessionEmail = session.user.email;

  const grants = await withUserTenantRls(session.user.id, async () =>
    prisma.emergencyAccessGrant.findMany({
      where: {
        OR: [
          { ownerId: session.user.id },
          { granteeId: session.user.id },
          {
            granteeEmail: { equals: sessionEmail, mode: "insensitive" },
            status: EA_STATUS.PENDING,
          },
        ],
      },
      include: {
        owner: { select: { id: true, name: true, email: true, image: true } },
        grantee: { select: { id: true, name: true, email: true, image: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
  );

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

export const POST = withRequestLog(handlePOST);
export const GET = withRequestLog(handleGET);
