import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { withRequestLog } from "@/lib/http/with-request-log";
import { NO_STORE_HEADERS } from "@/lib/http/cache-headers";
import { parseBody } from "@/lib/http/parse-body";
import { validateExtensionToken, hasScope } from "@/lib/auth/tokens/extension-token";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { errorResponse, unauthorized } from "@/lib/http/api-response";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import { MS_PER_HOUR } from "@/lib/constants/time";
import { EXTENSION_TOKEN_SCOPE } from "@/lib/constants/auth/extension-token";
import { jwkThumbprint } from "@/lib/auth/dpop/verify";
import { issueAutofillToken } from "@/lib/auth/tokens/mobile-token";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { enforceAccessRestriction } from "@/lib/auth/policy/access-restriction";

export const runtime = "nodejs";

// 30 req / h per user. The host mints once per unlock and once per app
// foreground — generous for real use, but a stolen host token cannot flood
// extensionToken rows or keep revoking the live AutoFill token (each mint
// revokes the prior one) at full speed.
const mintLimiter = createRateLimiter({
  windowMs: MS_PER_HOUR,
  max: 30,
  failClosedOnRedisError: true,
});

// The AutoFill extension's own DPoP public key (P-256). The minted token binds
// to its RFC 7638 thumbprint so only that extension can present it.
const BodySchema = z
  .object({
    jwk: z
      .object({
        kty: z.literal("EC"),
        crv: z.literal("P-256"),
        x: z.string().min(1),
        y: z.string().min(1),
      })
      .strict(),
  })
  .strict();

/**
 * POST /api/mobile/autofill-token
 *
 * Host-authenticated mint of a short-lived, passwords:write-only, DPoP-bound
 * token for the iOS AutoFill extension's passkey-registration upload. The host
 * (already paired, holding an IOS_APP token) authenticates with its own token +
 * DPoP; the body carries the EXTENSION's public JWK, which the server binds the
 * new token to. Returns the bearer once; never refreshable.
 *
 * Bearer-only (#959 D1): validates the host's extension-token row directly
 * via `validateExtensionToken`, like `favicon-pref`, instead of `checkAuth`'s
 * session-aware `authOrToken` path — this route never reads the session
 * cookie, so a stale cookie is simply ignored and a valid IOS_APP token still
 * mints (it was never actually reachable via a session anyway: the type/
 * clientKind check below always refused one). This also keeps the route off
 * the proxy's `API_DEFAULT_SESSION_READERS` list. `validateExtensionToken`
 * runs the host's DPoP check and the per-use passkey gate (`passkeyGateBlocks`,
 * `#965`) before returning.
 */
export const POST = withRequestLog(async (req: NextRequest) => {
  // Any extension-token failure is a bare 401 and the passkey gate answers
  // PASSKEY_REQUIRED, as on the former checkAuth path; scope is checked before
  // the client kind. One outcome differs: an `api_` key is not an extension
  // token, so a passkey-blocked one now gets 401 where checkAuth gave 403.
  // Harmless — an `api_` key never passed the IOS_APP check, so it could never
  // mint here either way.
  const authed = await validateExtensionToken(req);
  if (!authed.ok) {
    if (authed.error === "PASSKEY_REQUIRED") {
      return errorResponse(API_ERROR.PASSKEY_REQUIRED);
    }
    return unauthorized();
  }
  const { userId, tenantId, clientKind, scopes } = authed.data;

  // Gate on passwords:write — the same scope POST /api/passwords requires,
  // which the host's token already carries.
  if (!hasScope(scopes, EXTENSION_TOKEN_SCOPE.PASSWORDS_WRITE)) {
    return errorResponse(API_ERROR.EXTENSION_TOKEN_SCOPE_INSUFFICIENT);
  }
  // Only the host app's own bearer token (clientKind IOS_APP) may broker an
  // AutoFill upload token. A BROWSER_EXTENSION / IOS_AUTOFILL token — which
  // shares the passwords:write scope — must not be able to mint or rotate the
  // AutoFill token either.
  if (clientKind !== "IOS_APP") {
    return unauthorized();
  }

  // Tenant network access restriction — a stolen IOS_APP bearer token must not
  // mint a passwords:write AutoFill token from an off-network IP. Enforced on the
  // authenticated tenantId before the mint, matching the MCP gateway / token
  // endpoint and the D5a control.
  const denied = await enforceAccessRestriction(req, userId, tenantId, ACTOR_TYPE.HUMAN);
  if (denied) return denied;

  // Rate-limit per user, after auth (the bucket key is the authenticated
  // identity) and before the mint/audit work.
  const blocked = await checkRateLimitOrFail({
    req,
    limiter: mintLimiter,
    key: `rl:mobile_autofill_token:${userId}`,
    scope: "mobile.autofill_token",
    userId,
    tenantId,
  });
  if (blocked) return blocked;

  const parsed = await parseBody(req, BodySchema);
  if (!parsed.ok) return parsed.response;
  const { jwk } = parsed.data;

  const cnfJkt = jwkThumbprint({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });
  const issued = await issueAutofillToken({ userId, tenantId, cnfJkt });

  await logAuditAsync({
    ...personalAuditBase(req, userId),
    action: AUDIT_ACTION.MOBILE_TOKEN_ISSUED,
    tenantId,
    targetType: AUDIT_TARGET_TYPE.EXTENSION_TOKEN,
    metadata: { clientKind: "IOS_AUTOFILL", scope: issued.scope },
  });

  return NextResponse.json(
    {
      token: issued.token,
      expiresAt: issued.expiresAt.toISOString(),
      scope: [issued.scope],
      cnfJkt,
    },
    { status: 201, headers: { ...NO_STORE_HEADERS } },
  );
});
