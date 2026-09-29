import { NextRequest, NextResponse } from "next/server";
import { randomUUID, randomBytes } from "node:crypto";
import { z } from "zod";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse } from "@/lib/http/api-response";
import { NO_STORE_HEADERS } from "@/lib/http/cache-headers";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { parseBody } from "@/lib/http/parse-body";
import { WEBAUTHN_RESPONSE_MAX } from "@/lib/validations/common";
import { assertOrigin } from "@/lib/auth/session/csrf";
import { authorizeWebAuthn } from "@/lib/auth/webauthn/webauthn-authorize";
import { CHALLENGE_ID_RE } from "@/lib/auth/webauthn/webauthn-server";
import { logAuditAsync, extractRequestMeta, personalAuditBase } from "@/lib/audit/audit";
import { extractClientIp } from "@/lib/auth/policy/ip-access";
import { checkIpRateLimit } from "@/lib/security/ip-rate-limit";
import { AUDIT_ACTION } from "@/lib/constants";
import { prisma } from "@/lib/prisma";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { resolveOwningTenantIdFromClient } from "@/lib/tenant-context";
import {
  getSessionCookieName,
  isSecureCookieFromAuthUrl,
} from "@/lib/auth/session/cookie-name";
import { createCappedSession } from "@/lib/auth/session/session-concurrency";
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
    boundUnknownIp: true,
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
    credentialResponse: z.string().min(1).max(WEBAUTHN_RESPONSE_MAX),
    challengeId: z.string().regex(CHALLENGE_ID_RE),
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
  //
  // The bootstrap check and the tenant stamped on the session below must be the
  // SAME id, and it must be the active membership's: `User.tenantId` is a
  // denormalized copy with no invalidation, so against the stale value this gate
  // reads the old bootstrap tenant and admits a sign-in the user's actual SSO
  // tenant forbids — and then files the session under a tenant `/api/sessions`
  // (which opens the membership) cannot list or revoke.
  const existingUser = await withBypassRls(prisma, async (tx) => {
    const found = await tx.user.findUnique({ where: { email: user.email }, select: { id: true } });
    if (!found) return null;
    const tenantId = await resolveOwningTenantIdFromClient(tx, found.id);
    if (!tenantId) return null;
    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { isBootstrap: true },
    });
    return { tenantId, tenant };
  }, BYPASS_PURPOSE.AUTH_FLOW);
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

  // Create the session through the shared capped creator — the one the
  // adapter's OAuth/SAML/magic-link sign-ins use — so passkey sign-in behaves
  // like every other sign-in path: it evicts only the oldest Web session over
  // the tenant's concurrent-session cap and touches no bearer token. A
  // sign-in proves possession of the credential, not that anything else was
  // compromised, so it does not sign the user out of the extension or the iOS
  // app (this supersedes owasp-batch-3 C7). Revocation belongs to
  // secret-changing operations (passphrase change, key rotation, resets) and
  // explicit sign-out (DELETE /api/sessions); see
  // docs/archive/review/passkey-signin-client-token-cascade-plan.md.
  //
  // Note on passkeyVerifiedAt ownership (split with auth-adapter): the
  // initial value is set HERE because the passkey sign-in route owns session
  // creation for the WebAuthn provider (not the Auth.js adapter). The
  // auth-adapter's createSession leaves it null for OAuth/email sessions,
  // which is correct — those flows do not establish passkey freshness.
  // Subsequent updates: ordinary session activity in
  // `src/lib/auth/session/auth-adapter.ts:updateSession` writes only
  // {expires, lastActiveAt}; it MUST NOT refresh passkeyVerifiedAt (C2
  // invariant). Refresh happens via the dedicated reauth flow at
  // `src/app/api/auth/passkey/reauth/verify/route.ts`.
  // createCappedSession also runs the new-device check and reports any
  // cap eviction once the session has committed — the same post-sign-in
  // work the adapter's paths get.
  await createCappedSession({
    userId: user.id,
    tenantId: existingUser.tenantId,
    sessionToken,
    expires,
    ip: meta.ip,
    userAgent: meta.userAgent,
    acceptLanguage: meta.acceptLanguage,
    provider: "webauthn",
    passkeyVerifiedAt: verifiedAt,
    authCredentialId: user.credentialRowId,
  });

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
  response.headers.set("Cache-Control", NO_STORE_HEADERS["Cache-Control"]);
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
