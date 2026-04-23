import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createEmergencyGrantSchema } from "@/lib/validations";
import { generateShareToken, hashToken } from "@/lib/crypto/crypto-server";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { sendEmail } from "@/lib/email";
import { emergencyInviteEmail } from "@/lib/email/templates/emergency-access";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import { errorResponse, rateLimited, unauthorized } from "@/lib/api-response";
import { EA_STATUS, AUDIT_TARGET_TYPE, AUDIT_ACTION } from "@/lib/constants";
import { resolveUserLocale } from "@/lib/locale";
import { withUserTenantRls } from "@/lib/tenant-context";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { parseBody } from "@/lib/parse-body";
import { withRequestLog } from "@/lib/with-request-log";
import { MS_PER_DAY, MS_PER_MINUTE } from "@/lib/constants/time";

const createLimiter = createRateLimiter({ windowMs: 15 * MS_PER_MINUTE, max: 5 });

// POST /api/emergency-access — Create a new emergency access grant
async function handlePOST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id || !session.user.email) {
    return unauthorized();
  }
  const sessionEmail = session.user.email;

  const rl = await createLimiter.check(`rl:ea_create:${session.user.id}`);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  const result = await parseBody(req, createEmergencyGrantSchema);
  if (!result.ok) return result.response;
  const { granteeEmail, waitDays } = result.data;

  // Cannot grant to self
  if (granteeEmail.toLowerCase() === sessionEmail.toLowerCase()) {
    return errorResponse(API_ERROR.CANNOT_GRANT_SELF, 400);
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
    return errorResponse(API_ERROR.DUPLICATE_GRANT, 409);
  }

  const token = generateShareToken();
  const tokenExpiresAt = new Date(Date.now() + 7 * MS_PER_DAY);
  const grant = await withUserTenantRls(session.user.id, async (tenantId) =>
    prisma.emergencyAccessGrant.create({
      data: {
        ownerId: session.user.id,
        tenantId,
        granteeEmail,
        waitDays,
        tokenHash: hashToken(token),
        tokenExpiresAt,
      },
    }),
  );

  await logAuditAsync({
    ...personalAuditBase(req, session.user.id),
    action: AUDIT_ACTION.EMERGENCY_GRANT_CREATE,
    targetType: AUDIT_TARGET_TYPE.EMERGENCY_ACCESS_GRANT,
    targetId: grant.id,
    metadata: { granteeEmail, waitDays },
  });

  // Best-effort: look up grantee's locale (bypass RLS — grantee may be in another tenant)
  const granteeUser = await withBypassRls(prisma, async () =>
    prisma.user.findFirst({
      where: { email: { equals: granteeEmail, mode: "insensitive" } },
      select: { locale: true },
    }),
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);
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
  }, { status: 201 });
}

// GET /api/emergency-access — List emergency access grants
async function handleGET() {
  const session = await auth();
  if (!session?.user?.id || !session.user.email) {
    return unauthorized();
  }
  const sessionEmail = session.user.email;

  // Bypass RLS: grants span owner/grantee tenants
  const grants = await withBypassRls(prisma, async () =>
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
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);

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
