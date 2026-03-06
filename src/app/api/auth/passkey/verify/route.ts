import { NextRequest, NextResponse } from "next/server";
import { randomUUID, randomBytes } from "node:crypto";
import { getRedis } from "@/lib/redis";
import { createRateLimiter } from "@/lib/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import { withRequestLog } from "@/lib/with-request-log";
import { assertOrigin } from "@/lib/csrf";
import { authorizeWebAuthn } from "@/lib/webauthn-authorize";
import { createCustomAdapter } from "@/lib/auth-adapter";
import { sessionMetaStorage } from "@/lib/session-meta";
import { logAudit } from "@/lib/audit";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
import { prisma } from "@/lib/prisma";
import { withBypassRls } from "@/lib/tenant-rls";
import { isHttps } from "@/lib/url-helpers";

export const runtime = "nodejs";

const rateLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });

const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60; // 8 hours (matches auth.ts)

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
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const rl = await rateLimiter.check(`webauthn:signin-verify:${ip}`);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: API_ERROR.RATE_LIMIT_EXCEEDED },
      { status: 429 },
    );
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
      select: { tenant: { select: { isBootstrap: true } } },
    }),
  );
  if (existingUser?.tenant && !existingUser.tenant.isBootstrap) {
    return NextResponse.json(
      { error: "AUTHENTICATION_FAILED" },
      { status: 401 },
    );
  }

  // Create database session (same as Auth.js would for OAuth providers)
  const sessionToken = `${randomUUID()}${randomBytes(16).toString("hex")}`;
  const expires = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);

  const adapter = createCustomAdapter();

  // Run createSession inside sessionMetaStorage so IP/UA are captured
  const meta = {
    ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: req.headers.get("user-agent") ?? null,
    acceptLanguage: req.headers.get("accept-language") ?? null,
  };

  await sessionMetaStorage.run(meta, async () => {
    await adapter.createSession!({
      sessionToken,
      userId: user.id,
      expires,
    });
  });

  // Audit log
  logAudit({
    scope: AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.AUTH_LOGIN,
    userId: user.id,
  });

  // Set session cookie
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
  const response = NextResponse.json({ ok: true });
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
