import { NextRequest, NextResponse } from "next/server";
import { randomUUID, randomBytes } from "node:crypto";
import { z } from "zod";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse } from "@/lib/http/api-response";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { parseBody } from "@/lib/http/parse-body";
import { assertOrigin } from "@/lib/auth/session/csrf";
import { authorizeWebAuthn } from "@/lib/auth/webauthn/webauthn-authorize";
import { logAuditAsync, extractRequestMeta, personalAuditBase } from "@/lib/audit/audit";
import { extractClientIp } from "@/lib/auth/policy/ip-access";
import { checkIpRateLimit } from "@/lib/security/ip-rate-limit";
import { AUDIT_ACTION } from "@/lib/constants";
import { prisma } from "@/lib/prisma";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import {
  getSessionCookieName,
  isSecureCookieFromAuthUrl,
} from "@/lib/auth/session/cookie-name";
import { invalidateUserSessions } from "@/lib/auth/session/user-session-invalidation";
import { invalidateCachedSessions } from "@/lib/auth/session/session-cache-helpers";
import { resolveEffectiveSessionTimeouts } from "@/lib/auth/session/session-timeout";
import { MS_PER_MINUTE } from "@/lib/constants/time";

export const runtime = "nodejs";

const rateLimiter = createRateLimiter({
  windowMs: MS_PER_MINUTE,
  max: 10,
  failClosedOnRedisError: true,
});

// Cookie name must match auth.config.ts — both paths use the shared
// getSessionCookieName helper + isSecureCookieFromAuthUrl so the
// selection cannot drift.
const SESSION_COOKIE_NAME = getSessionCookieName({
  useSecureCookies: isSecureCookieFromAuthUrl(),
  basePath: process.env.NEXT_PUBLIC_BASE_PATH,
});

// POST /api/auth/passkey/verify
// Unauthenticated endpoint — verifies a passkey authentication response
// and creates a database session directly (bypassing Auth.js Credentials
// provider which only supports JWT sessions).
async function handlePOST(req: NextRequest) {
  // Defense-in-depth: validate Origin header
  const originError = assertOrigin(req);
  if (originError) return originError;

  // Rate limit by IP
  const rl = await checkIpRateLimit({
    ip: extractClientIp(req),
    pathname: req.nextUrl.pathname,
    scope: "webauthn_signin_verify",
    limiter: rateLimiter,
  });
  const blocked = await checkRateLimitOrFail({
    req,
    result: rl,
    scope: "auth.passkey_verify",
    userId: null,
  });
  if (blocked) return blocked;

  // Parse request body
  const passkeyVerifySchema = z.object({
    credentialResponse: z.string(),
    challengeId: z.string(),
  });
  const bodyResult = await parseBody(req, passkeyVerifySchema);
  if (!bodyResult.ok) return bodyResult.response;
  const { credentialResponse, challengeId } = bodyResult.data;

  // Verify WebAuthn authentication
  const user = await authorizeWebAuthn({
    credentialResponse,
    challengeId,
  });

  if (!user) {
    return errorResponse(API_ERROR.AUTHENTICATION_FAILED);
  }

  // SSO tenant guard: reject non-bootstrap (SSO) tenant users.
  // This is intentionally simpler than ensureTenantMembershipForSignIn() in auth.ts
  // because passkey sign-in is restricted to bootstrap-tenant users only (the sign-in
  // page hides the passkey button when SSO is configured). We don't need tenant claim
  // extraction, cross-tenant migration, or membership upsert here.
  const existingUser = await withBypassRls(prisma, async (tx) =>
    tx.user.findUnique({
      where: { email: user.email },
      select: { tenantId: true, tenant: { select: { isBootstrap: true } } },
    }),
  BYPASS_PURPOSE.AUTH_FLOW);
  if (!existingUser?.tenantId || !existingUser.tenant || !existingUser.tenant.isBootstrap) {
    return errorResponse(API_ERROR.AUTHENTICATION_FAILED);
  }

  // Create database session (same as Auth.js would for OAuth providers)
  const sessionToken = `${randomUUID()}${randomBytes(16).toString("hex")}`;
  const verifiedAt = new Date();
  const resolvedTimeouts = await resolveEffectiveSessionTimeouts(user.id, "webauthn");
  const expires = new Date(
    verifiedAt.getTime() + resolvedTimeouts.idleMinutes * MS_PER_MINUTE,
  );

  const meta = extractRequestMeta(req);

  // Defense-in-depth: atomically delete all existing sessions and create
  // new one. Passkey sign-in requires physical device possession, so this
  // aggressive rotation is acceptable for a password manager.
  let evictedTokens: string[] = [];
  const evictedCount = await withBypassRls(prisma, async (tx) => {
    const result = await prisma.$transaction(async (tx) => {
      // SELECT tokens to invalidate before deleteMany — same tx so the read
      // sees only currently-live sessions (R3 / S-6 sequencing).
      const existing = await tx.session.findMany({
        where: { userId: user.id },
        select: { sessionToken: true },
      });
      evictedTokens = existing.map((s) => s.sessionToken);

      const deleted = await tx.session.deleteMany({
        where: { userId: user.id },
      });
      // Note on passkeyVerifiedAt ownership (split with auth-adapter):
      // Initial value is set HERE because the passkey sign-in route owns
      // session creation for the WebAuthn provider (not the Auth.js
      // adapter). The auth-adapter's createSession sets passkeyVerifiedAt
      // to null implicitly for OAuth/email sessions, which is correct —
      // those flows do not establish passkey freshness.
      // Subsequent updates: ordinary session activity in
      // `src/lib/auth/session/auth-adapter.ts:updateSession` writes only
      // {expires, lastActiveAt}; it MUST NOT refresh passkeyVerifiedAt
      // (C2 invariant). Refresh happens via the dedicated reauth flow at
      // `src/app/api/auth/passkey/reauth/verify/route.ts`.
      await tx.session.create({
        data: {
          sessionToken,
          userId: user.id,
          tenantId: existingUser.tenantId,
          expires,
          ipAddress: meta.ip ?? null,
          userAgent: meta.userAgent?.slice(0, 512) ?? null,
          passkeyVerifiedAt: verifiedAt,
          provider: "webauthn",
        },
      });
      return deleted.count;
    });
    return result;
  }, BYPASS_PURPOSE.AUTH_FLOW);

  // Invalidate cache AFTER $transaction resolves successfully (S-6).
  if (evictedTokens.length > 0) {
    await invalidateCachedSessions(evictedTokens);
  }

  // C7 (OWASP A07-3): passkey re-auth is an AAL3 credential freshness
  // re-establish event. Cascade revokes ALL bearer credentials across
  // all tenants — not just ExtensionToken, but also ApiKey,
  // McpAccessToken, McpRefreshToken, DelegationSession, OperatorToken.
  // Session deletion above already removed Session rows; this covers
  // the remaining bearer-class models. Sessions/tokens are scoped to
  // global User (not tenant), so allTenants=true matches.
  await invalidateUserSessions(user.id, {
    allTenants: true,
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
    secure: isSecureCookieFromAuthUrl(),
    expires,
  });

  return response;
}

export const POST = withRequestLog(handlePOST);
