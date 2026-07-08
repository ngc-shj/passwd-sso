/**
 * GET /api/mobile/authorize — Issue a one-time bridge code for the iOS host app.
 *
 * Step 1 of the iOS pairing handshake. The web app reaches this URL inside
 * `ASWebAuthenticationSession` after the user completes Auth.js sign-in. The
 * iOS app sends along PKCE+state pre-binding (computed in the host app) and
 * the Secure-Enclave device pubkey it will use for DPoP on subsequent calls.
 *
 * The route:
 *   1. Verifies an Auth.js session is active (the user is signed in).
 *   2. Validates the four required query params.
 *   3. Persists a single-use bridge code (60s TTL) bound to {userId, tenantId,
 *      state, code_challenge, device_jkt}.
 *   4. Redirects (302) to the iOS app's custom URL scheme
 *      `passwd-sso://auth/callback?code=<bridge>&state=<state>`.
 *
 * When no Auth.js session is present (first arrival inside the ephemeral
 * ASWebAuthenticationSession), the route redirects to the sign-in page with
 * callbackUrl pointing back here, so Auth.js returns once signed in.
 *
 * `redirect_uri` is NOT a query parameter — the server computes the redirect
 * target itself (a fixed scheme constant). Any client-supplied `redirect_uri`
 * is silently ignored (closes open-redirect per F15). The custom scheme — not
 * an https Universal Link — lets sign-in work against any self-hosted server
 * host without baking each host into the app's associated-domains entitlement.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/crypto/crypto-server";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { errorResponse, zodValidationError } from "@/lib/http/api-response";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { withUserTenantRls } from "@/lib/tenant-context";
import { extractRequestMeta, logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { withRequestLog } from "@/lib/http/with-request-log";
import { getAppOrigin, resolveBasePath } from "@/lib/url-helpers";
import { DEFAULT_LOCALE } from "@/i18n/locales";
import { enforceAccessRestriction } from "@/lib/auth/policy/access-restriction";
import { BRIDGE_CODE_TTL_MS, MS_PER_MINUTE } from "@/lib/constants";
import { generateShareToken } from "@/lib/crypto/crypto-server";
import { requireRecentCurrentAuthMethod } from "@/lib/auth/session/recent-current-auth-method";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import {
  derivePasskeyState,
  passkeyEnforcementBlocks,
  recordPasskeyAuditEmit,
} from "@/lib/auth/policy/passkey-enforcement";

export const runtime = "nodejs";

// Bridge-code issuance is authenticated + step-up gated, but a valid session
// could still flood single-use code rows. Cap per authenticated user, mirroring
// the /api/mobile/token limiter.
const authorizeLimiter = createRateLimiter({
  windowMs: 15 * MS_PER_MINUTE,
  max: 10,
  failClosedOnRedisError: true,
});

// base64url-no-padding regex; accept lengths used by the iOS host app.
// state: 32 random bytes → 43 chars; code_challenge: 32-byte SHA-256 → 43 chars;
// device_jkt: RFC 7638 JWK thumbprint, SHA-256 over P-256 JCS → exactly 43 chars
// (base64url unpadded). Exact-length match is the shape gate; the semantic
// binding is enforced at /api/mobile/token by comparing stored.deviceJkt to
// the DPoP proof's own jwkThumbprint output (verify.ts:219).
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const JWK_THUMBPRINT_RE = /^[A-Za-z0-9_-]{43}$/;

// Fixed callback target — the iOS app's registered custom URL scheme. Never
// derived from client input, so this is not an open redirect (F15).
const IOS_CALLBACK_URL = "passwd-sso://auth/callback";

const AuthorizeQuerySchema = z.object({
  client_kind: z.literal("ios"),
  state: z.string().min(43).max(64).regex(BASE64URL_RE),
  code_challenge: z.string().min(43).max(64).regex(BASE64URL_RE),
  device_jkt: z.string().regex(JWK_THUMBPRINT_RE),
});

/**
 * Redirect an unauthenticated authorize request to the sign-in page, carrying
 * the original authorize URL as callbackUrl so Auth.js returns here once the
 * user signs in. The origin is read from configured env (APP_URL/AUTH_URL) —
 * never from request headers — matching the canonicalHtu host policy.
 */
function redirectToSignIn(req: NextRequest): Response {
  // Origin/basePath come from configured env (APP_URL/AUTH_URL), NOT the
  // request: this handler runs in the app server behind a reverse proxy, so
  // req.nextUrl.host is the internal upstream (e.g. localhost:3001). Only the
  // request PATH is taken from req.nextUrl (basePath stripped by Next, so we
  // re-add basePath). The callback target is basePath-qualified and carries no
  // locale prefix — the API route lives outside the [locale] segment.
  const origin = getAppOrigin();
  if (!origin) return errorResponse(API_ERROR.INTERNAL_ERROR);
  let signInUrl: URL;
  let basePath: string;
  try {
    const base = new URL(origin);
    basePath = resolveBasePath(base);
    signInUrl = new URL(`${base.origin}${basePath}/${DEFAULT_LOCALE}/auth/signin`);
  } catch {
    return errorResponse(API_ERROR.INTERNAL_ERROR);
  }
  const callbackTarget = `${basePath}${req.nextUrl.pathname}${req.nextUrl.search}`;
  signInUrl.searchParams.set("callbackUrl", callbackTarget);
  return NextResponse.redirect(signInUrl.toString(), 302);
}

async function handleGET(req: NextRequest): Promise<Response> {
  // 1. Auth.js session. The iOS app opens this URL inside an *ephemeral*
  // ASWebAuthenticationSession, so on first arrival there is no session.
  // Bounce through the sign-in page; Auth.js returns to this same URL
  // (callbackUrl) once signed in, and we issue the bridge code on the
  // second pass.
  const session = await auth();
  if (!session?.user?.id) {
    return redirectToSignIn(req);
  }

  // A stale session needs re-authentication, not a JSON 403 the ephemeral
  // ASWebAuthenticationSession browser would strand on. Bounce through sign-in
  // exactly like the no-session path above; the sign-in page's reauth panel
  // refreshes the provider-appropriate freshness (passkey ceremony or
  // re-sign-in) and returns here via callbackUrl. The chooser still fails
  // closed on the unauthorized() paths (no/absent session row).
  // @stepup id:mobile-authorize-get method:GET
  const stepUpError = await requireRecentCurrentAuthMethod(req);
  if (stepUpError) {
    return stepUpError.status === 403 ? redirectToSignIn(req) : stepUpError;
  }

  // 2. Validate query params.
  const url = new URL(req.url);
  const parsed = AuthorizeQuerySchema.safeParse({
    client_kind: url.searchParams.get("client_kind"),
    state: url.searchParams.get("state"),
    code_challenge: url.searchParams.get("code_challenge"),
    device_jkt: url.searchParams.get("device_jkt"),
  });
  if (!parsed.success) {
    return zodValidationError(parsed.error);
  }
  const { state, code_challenge: codeChallenge, device_jkt: deviceJkt } =
    parsed.data;

  const userId = session.user.id;

  // 3. Tenant network-boundary enforcement. This route is classified
  // api-default at the proxy (not session-gated there, so the user can be
  // bounced to sign-in), so the IP access restriction the proxy applies to
  // session-required routes must be enforced here — matching /api/mobile/token.
  const accessDenied = await enforceAccessRestriction(req, userId);
  if (accessDenied) return accessDenied;

  // 3b. Rate-limit authenticated code issuance per user (caps bridge-code-row
  // flood from a valid session). Keyed by userId, not IP, since the route is
  // only reachable post-auth.
  const blocked = await checkRateLimitOrFail({
    req,
    limiter: authorizeLimiter,
    key: `rl:mobile_authorize:${userId}`,
    scope: "mobile.authorize",
    userId,
  });
  if (blocked) return blocked;

  // 4. Resolve the user's tenant via the RLS wrapper's tenantId callback —
  // saves a redundant SELECT on the users table.
  const code = generateShareToken();
  const codeHash = hashToken(code);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + BRIDGE_CODE_TTL_MS);
  const meta = extractRequestMeta(req);

  // Resolve the tenant first, then persist the bridge code. withBypassRls must
  // NOT nest inside withUserTenantRls (RLS guard, tenant-rls.ts) — so the bypass
  // insert runs at top level, after the tenant RLS scope has exited.
  const tenantId = await withUserTenantRls(userId, async (tid) => tid);

  // Passkey enforcement gate — re-derives from DB (fail-closed). tenantId is
  // NOT NULL (used unconditionally in the bridge-code create below); gate
  // unconditionally so a falsy value can never skip enforcement.
  const pkState = await derivePasskeyState({ userId, tenantId });
  if (passkeyEnforcementBlocks(pkState)) {
    if (recordPasskeyAuditEmit(userId, "/api/mobile/authorize", Date.now())) {
      await logAuditAsync({
        ...personalAuditBase(req, userId),
        action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED,
        tenantId,
        metadata: { blockedPath: "/api/mobile/authorize" },
      });
    }
    const refusalUrl = new URL(IOS_CALLBACK_URL);
    refusalUrl.searchParams.set("error", "passkey_required");
    return new NextResponse(null, {
      status: 302,
      headers: {
        Location: refusalUrl.toString(),
        "Cache-Control": "no-store",
      },
    });
  }

  const created = await withBypassRls(
    prisma,
    async (tx) =>
      tx.mobileBridgeCode.create({
        data: {
          codeHash,
          userId,
          tenantId,
          state,
          codeChallenge,
          deviceJkt,
          expiresAt,
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
      }),
    BYPASS_PURPOSE.TOKEN_LIFECYCLE,
  );

  // Audit the device-pairing initiation (step 1). deviceJkt is a public JWK
  // thumbprint; the bridge code itself is never logged.
  await logAuditAsync({
    ...personalAuditBase(req, userId),
    action: AUDIT_ACTION.MOBILE_BRIDGE_CODE_ISSUED,
    tenantId,
    targetType: AUDIT_TARGET_TYPE.MOBILE_BRIDGE_CODE,
    targetId: created.id,
    metadata: { deviceJkt },
  });

  // 5. Redirect the ASWebAuthenticationSession to the iOS app's custom URL
  // scheme with the bridge code. The scheme is a fixed server constant (never
  // a client-supplied redirect_uri), so this is not an open redirect (F15).
  const callbackUrl = new URL(IOS_CALLBACK_URL);
  callbackUrl.searchParams.set("code", code);
  callbackUrl.searchParams.set("state", state);

  return new NextResponse(null, {
    status: 302,
    headers: {
      Location: callbackUrl.toString(),
      "Cache-Control": "no-store",
    },
  });
}

export const GET = withRequestLog(handleGET);
