import { NextRequest, NextResponse } from "next/server";
import { randomUUID, randomBytes } from "node:crypto";
import { createRateLimiter } from "@/lib/rate-limit";
import { withRequestLog } from "@/lib/with-request-log";
import { rateLimited } from "@/lib/api-response";
import { assertOrigin } from "@/lib/auth/csrf";
import { authorizeWebAuthn } from "@/lib/auth/webauthn-authorize";
import { logAuditAsync, extractRequestMeta, personalAuditBase } from "@/lib/audit/audit";
import { extractClientIp, rateLimitKeyFromIp } from "@/lib/auth/ip-access";
import { AUDIT_ACTION } from "@/lib/constants";
import { prisma } from "@/lib/prisma";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { isHttps } from "@/lib/url-helpers";
import { PASSKEY_SESSION_MAX_AGE_SECONDS } from "@/lib/validations/common.server";
import { revokeAllExtensionTokensForUser } from "@/lib/auth/extension-token";

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
  BYPASS_PURPOSE.AUTH_FLOW);
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
          // AAL3 provenance: the resolver clamps idle/absolute to NIST SP
          // 800-63B-4 §2.3.3 AAL3 reauthentication ceilings (12h absolute /
          // 15min inactivity) for sessions with provider="webauthn".
          provider: "webauthn",
        },
      });
      return deleted.count;
    });
    return result;
  }, BYPASS_PURPOSE.AUTH_FLOW);

  // Passkey re-auth invalidates all prior bearer credentials (extension tokens).
  // Maintains the "credential freshness" invariant for AAL3 auth events.
  await revokeAllExtensionTokensForUser({
    userId: user.id,
    tenantId: existingUser.tenantId,
    reason: "passkey_reauth",
  });

  // Audit log
  if (evictedCount > 0) {
    await logAuditAsync({
      ...personalAuditBase(req, user.id),
      action: AUDIT_ACTION.SESSION_REVOKE_ALL,
      metadata: { trigger: "passkey_signin", evictedCount },
    });
  }
  await logAuditAsync({
    ...personalAuditBase(req, user.id),
    action: AUDIT_ACTION.AUTH_LOGIN,
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
