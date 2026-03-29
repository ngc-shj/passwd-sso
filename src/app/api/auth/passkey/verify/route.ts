import { NextRequest, NextResponse } from "next/server";
import { randomUUID, randomBytes } from "node:crypto";
import { createRateLimiter } from "@/lib/rate-limit";
import { withRequestLog } from "@/lib/with-request-log";
import { rateLimited } from "@/lib/api-response";
import { assertOrigin } from "@/lib/csrf";
import { authorizeWebAuthn } from "@/lib/webauthn-authorize";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { extractClientIp, rateLimitKeyFromIp } from "@/lib/ip-access";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
import { prisma } from "@/lib/prisma";
import { withBypassRls } from "@/lib/tenant-rls";
import { isHttps } from "@/lib/url-helpers";
import { PASSKEY_SESSION_MAX_AGE_SECONDS } from "@/lib/validations/common.server";

export const runtime = "nodejs";

const rateLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });

// Cookie name must match auth.config.ts
const SESSION_COOKIE_NAME = isHttps
  ? "__Secure-authjs.session-token"
  : "authjs.session-token";

// POST /api/auth/passkey/verify
// Unauthenticated endpoint — verifies a passkey authentication response
// and creates a database session directly (bypassing Auth.js Credentials
// provider which only supports JWT sessions).
async function handlePOST(req: NextRequest) {
  // Defense-in-depth: validate Origin header
  const originError = assertOrigin(req);
  if (originError) return originError;

  // Rate limit by IP
  const ip = extractClientIp(req) ?? "unknown";
  const rl = await rateLimiter.check(`rl:webauthn_signin_verify:${rateLimitKeyFromIp(ip)}`);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  // Parse request body
  let body: { credentialResponse: string; challengeId: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "INVALID_REQUEST" },
      { status: 400 },
    );
  }

  if (
    typeof body.credentialResponse !== "string" ||
    typeof body.challengeId !== "string"
  ) {
    return NextResponse.json(
      { error: "INVALID_REQUEST" },
      { status: 400 },
    );
  }

  // Verify WebAuthn authentication
  const user = await authorizeWebAuthn({
    credentialResponse: body.credentialResponse,
    challengeId: body.challengeId,
  });

  if (!user) {
    return NextResponse.json(
      { error: "AUTHENTICATION_FAILED" },
      { status: 401 },
    );
  }

  // SSO tenant guard: reject non-bootstrap (SSO) tenant users.
  // This is intentionally simpler than ensureTenantMembershipForSignIn() in auth.ts
  // because passkey sign-in is restricted to bootstrap-tenant users only (the sign-in
  // page hides the passkey button when SSO is configured). We don't need tenant claim
  // extraction, cross-tenant migration, or membership upsert here.
  const existingUser = await withBypassRls(prisma, async () =>
    prisma.user.findUnique({
      where: { email: user.email },
      select: { tenantId: true, tenant: { select: { isBootstrap: true } } },
    }),
  );
  if (!existingUser?.tenantId || !existingUser.tenant || !existingUser.tenant.isBootstrap) {
    return NextResponse.json(
      { error: "AUTHENTICATION_FAILED" },
      { status: 401 },
    );
  }

  // Create database session (same as Auth.js would for OAuth providers)
  const sessionToken = `${randomUUID()}${randomBytes(16).toString("hex")}`;
  const expires = new Date(Date.now() + PASSKEY_SESSION_MAX_AGE_SECONDS * 1000);

  const meta = extractRequestMeta(req);

  // Defense-in-depth: atomically delete all existing sessions and create
  // new one. Passkey sign-in requires physical device possession, so this
  // aggressive rotation is acceptable for a password manager.
  const evictedCount = await withBypassRls(prisma, async () => {
    const result = await prisma.$transaction(async (tx) => {
      const deleted = await tx.session.deleteMany({
        where: { userId: user.id },
      });
      await tx.session.create({
        data: {
          sessionToken,
          userId: user.id,
          tenantId: existingUser.tenantId,
          expires,
          ipAddress: meta.ip ?? null,
          userAgent: meta.userAgent?.slice(0, 512) ?? null,
        },
      });
      return deleted.count;
    });
    return result;
  });

  // Audit log
  if (evictedCount > 0) {
    logAudit({
      scope: AUDIT_SCOPE.PERSONAL,
      action: AUDIT_ACTION.SESSION_REVOKE_ALL,
      userId: user.id,
      metadata: { trigger: "passkey_signin", evictedCount },
      ...meta,
    });
  }
  logAudit({
    scope: AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.AUTH_LOGIN,
    userId: user.id,
    ...meta,
  });

  // Set session cookie
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
  const response = NextResponse.json({
    ok: true,
    ...(user.prf ? { prf: user.prf } : {}),
  });
  response.cookies.set(SESSION_COOKIE_NAME, sessionToken, {
    path: `${basePath}/`,
    httpOnly: true,
    sameSite: "lax",
    secure: isHttps,
    expires,
  });

  return response;
}

export const POST = withRequestLog(handlePOST);
