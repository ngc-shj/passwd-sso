import { NextRequest, NextResponse } from "next/server";
import { randomUUID, randomBytes } from "node:crypto";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse, rateLimited } from "@/lib/http/api-response";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { assertOrigin } from "@/lib/auth/session/csrf";
import { authorizeWebAuthn } from "@/lib/auth/webauthn/webauthn-authorize";
import { logAuditAsync, extractRequestMeta, personalAuditBase } from "@/lib/audit/audit";
import { extractClientIp, rateLimitKeyFromIp } from "@/lib/auth/policy/ip-access";
import { AUDIT_ACTION } from "@/lib/constants";
import { prisma } from "@/lib/prisma";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { isHttps } from "@/lib/url-helpers";
import { revokeAllExtensionTokensForUser } from "@/lib/auth/tokens/extension-token";
import { invalidateCachedSessions } from "@/lib/auth/session/session-cache-helpers";
import { resolveEffectiveSessionTimeouts } from "@/lib/auth/session/session-timeout";
import { MS_PER_MINUTE } from "@/lib/constants/time";

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
    return errorResponse(API_ERROR.INVALID_REQUEST);
  }

  if (
    typeof body.credentialResponse !== "string" ||
    typeof body.challengeId !== "string"
  ) {
    return errorResponse(API_ERROR.INVALID_REQUEST);
  }

  // Verify WebAuthn authentication
  const user = await authorizeWebAuthn({
    credentialResponse: body.credentialResponse,
    challengeId: body.challengeId,
  });

  if (!user) {
    return errorResponse(API_ERROR.AUTHENTICATION_FAILED);
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
  const evictedCount = await withBypassRls(prisma, async () => {
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
