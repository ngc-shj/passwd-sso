/**
 * POST /api/mobile/token — Exchange a one-time bridge code for a DPoP-bound
 * access+refresh token pair.
 *
 * Step 2 of the iOS pairing handshake. Called from the iOS host app after it
 * receives the bridge code from the Universal-Link redirect target. The route:
 *
 *   1. Rate-limits per client IP (no session is available at this point).
 *   2. Validates the body shape.
 *   3. Reads the bridge code (no consumption yet) and verifies the PKCE
 *      challenge (S256), the client-supplied `device_jkt` against the value
 *      stored at authorize, and the DPoP proof. All failures return the
 *      same MOBILE_BRIDGE_CODE_INVALID error (uniform — closes the validity
 *      oracle); only after every check passes does step 7 CAS-consume the
 *      bridge code (sets `used_at`). PKCE/DPoP failures leave `used_at`
 *      null so the legitimate client can retry within TTL.
 *   4. The DPoP proof MUST be signed by the same key whose RFC 7638 JWK
 *      thumbprint equals `stored.deviceJkt`. No `ath` required at this
 *      step because the client doesn't yet have an access token.
 *   5. Calls `issueIosToken()` to mint the access+refresh pair, and
 *      audits `MOBILE_TOKEN_ISSUED`. JTI cache provides replay defense.
 *
 * Compensating controls (no Auth.js session, no Origin check):
 *   - 256-bit single-use bridge code with 60s TTL.
 *   - PKCE binds the exchange to the device that initiated `/authorize`.
 *   - DPoP proof binds the exchange to the device pubkey.
 *   - Per-IP rate limit (10 req / 15 min) caps brute force.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/crypto/crypto-server";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { API_ERROR } from "@/lib/http/api-error-codes";
import {
  errorResponse,
} from "@/lib/http/api-response";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import { parseBody } from "@/lib/http/parse-body";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { extractClientIp, rateLimitKeyFromIp } from "@/lib/auth/policy/ip-access";
import { withRequestLog } from "@/lib/http/with-request-log";
import { getLogger } from "@/lib/logger";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { MS_PER_MINUTE } from "@/lib/constants/time";
import { canonicalHtu } from "@/lib/auth/dpop/htu-canonical";
import { verifyDpopProof } from "@/lib/auth/dpop/verify";
import { getJtiCache } from "@/lib/auth/dpop/jti-cache";
import {
  issueIosToken,
  IOS_TOKEN_IDLE_TIMEOUT_MS,
} from "@/lib/auth/tokens/mobile-token";
import { verifyPkceS256 } from "@/lib/mcp/oauth-server";

export const runtime = "nodejs";

const tokenLimiter = createRateLimiter({
  windowMs: 15 * MS_PER_MINUTE,
  max: 10,
  failClosedOnRedisError: true,
});

const TokenRequestSchema = z
  .object({
    code: z.string().length(64).regex(/^[a-f0-9]+$/),
    code_verifier: z
      .string()
      .min(43)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
    // RFC 7638 JWK thumbprint — exactly 43 base64url chars.
    device_jkt: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();

function safeStringEqual(a: string, b: string): boolean {
  if (a.length === 0 || b.length === 0) return false;
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

async function handlePOST(req: NextRequest): Promise<Response> {
  // 1. Rate limit BEFORE DB lookup. Keyed by client IP.
  const clientIp = extractClientIp(req);
  const blocked = await checkRateLimitOrFail({
    req,
    limiter: tokenLimiter,
    key: `rl:mobile_token:${rateLimitKeyFromIp(clientIp ?? "unknown")}`,
    scope: "mobile.token",
    userId: null,
  });
  if (blocked) return blocked;

  // 2. Parse + validate body.
  const bodyResult = await parseBody(req, TokenRequestSchema);
  if (!bodyResult.ok) {
    getLogger().warn(
      {
        event: "mobile_token_failure",
        reason: "invalid_request",
        ip: clientIp,
      },
      "mobile token failed: malformed body",
    );
    return bodyResult.response;
  }
  const { code, code_verifier: codeVerifier, device_jkt: deviceJkt } =
    bodyResult.data;

  // 3. Read the bridge code WITHOUT consuming it (CAS pattern per C7).
  // Consumption happens after all binding checks pass — failures leave the
  // code unused so the legitimate client can retry within TTL. ALL failure
  // paths return the SAME MOBILE_BRIDGE_CODE_INVALID error to close the
  // bridge-code validity oracle (per S7); internal logging differentiates
  // for operator debugging.
  const codeHash = hashToken(code);
  const now = new Date();
  const stored = await withBypassRls(
    prisma,
    async () =>
      prisma.mobileBridgeCode.findUnique({
        where: { codeHash },
        select: {
          userId: true,
          tenantId: true,
          state: true,
          codeChallenge: true,
          deviceJkt: true,
          usedAt: true,
          expiresAt: true,
        },
      }),
    BYPASS_PURPOSE.TOKEN_LIFECYCLE,
  );
  // In-memory freshness check (informational — CAS at step 7 is authoritative).
  // We still verify subsequent bindings even when stored looks "stale" because
  // the CAS will reject and we want failure paths to be timing-uniform.
  const looksFresh =
    stored !== null &&
    stored.usedAt === null &&
    stored.expiresAt.getTime() > now.getTime();
  if (!stored) {
    getLogger().warn(
      { event: "mobile_token_failure", reason: "bridge_code_unknown", ip: clientIp },
      "mobile token failed: bridge code unknown",
    );
    return errorResponse(API_ERROR.MOBILE_BRIDGE_CODE_INVALID);
  }

  // 4. Verify device_jkt binding (constant-time). Uniform error per S7.
  if (!safeStringEqual(stored.deviceJkt, deviceJkt)) {
    getLogger().warn(
      {
        event: "mobile_token_failure",
        reason: "device_jkt_mismatch",
        userId: stored.userId,
      },
      "mobile token failed: device_jkt mismatch",
    );
    return errorResponse(API_ERROR.MOBILE_BRIDGE_CODE_INVALID);
  }

  // 5. PKCE: stored.codeChallenge must equal base64url(SHA-256(code_verifier)).
  if (!verifyPkceS256(stored.codeChallenge, codeVerifier)) {
    getLogger().warn(
      {
        event: "mobile_token_failure",
        reason: "pkce_mismatch",
        userId: stored.userId,
      },
      "mobile token failed: PKCE challenge did not match",
    );
    return errorResponse(API_ERROR.MOBILE_BRIDGE_CODE_INVALID);
  }

  // 6. Verify DPoP proof. No `ath` at this step (no access token yet); the
  // proof's JWK thumbprint MUST equal the stored deviceJkt. Uniform error
  // per S7.
  const dpopHeader = req.headers.get("dpop");
  const dpopResult = await verifyDpopProof(dpopHeader, {
    expectedHtm: "POST",
    expectedHtu: canonicalHtu({ route: "/api/mobile/token" }),
    expectedCnfJkt: stored.deviceJkt,
    expectedNonce: null,
    jtiCache: getJtiCache(),
  });
  if (!dpopResult.ok) {
    getLogger().warn(
      {
        event: "mobile_token_failure",
        reason: "dpop_invalid",
        dpopError: dpopResult.error,
        userId: stored.userId,
      },
      "mobile token failed: DPoP verification failed",
    );
    return errorResponse(API_ERROR.MOBILE_BRIDGE_CODE_INVALID);
  }

  // 7. CAS-consume the bridge code. count===0 means lost a race or the row
  // was used/expired between steps 3 and 7.
  const cas = await withBypassRls(
    prisma,
    async (tx) =>
      tx.mobileBridgeCode.updateMany({
        where: { codeHash, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      }),
    BYPASS_PURPOSE.TOKEN_LIFECYCLE,
  );
  if (cas.count === 0) {
    getLogger().warn(
      {
        event: "mobile_token_failure",
        reason: looksFresh ? "cas_race_lost" : "bridge_code_stale",
        userId: stored.userId,
      },
      "mobile token failed: bridge code CAS-consume returned 0",
    );
    return errorResponse(API_ERROR.MOBILE_BRIDGE_CODE_INVALID);
  }

  // 8. Issue the token pair. cnfJkt is the verifier-computed thumbprint of
  // the proof's own JWK — same value as stored.deviceJkt post-verify.
  let issued: Awaited<ReturnType<typeof issueIosToken>>;
  try {
    issued = await issueIosToken({
      userId: stored.userId,
      tenantId: stored.tenantId,
      deviceJkt: stored.deviceJkt,
      cnfJkt: dpopResult.jkt,
      ip: clientIp,
      userAgent: req.headers.get("user-agent"),
    });
  } catch (err) {
    getLogger().error(
      {
        event: "mobile_token_issue_failed",
        userId: stored.userId,
        err,
      },
      "mobile token issuance threw",
    );
    return errorResponse(API_ERROR.INTERNAL_ERROR);
  }

  await logAuditAsync({
    ...personalAuditBase(req, stored.userId),
    action: AUDIT_ACTION.MOBILE_TOKEN_ISSUED,
    tenantId: stored.tenantId,
    targetType: AUDIT_TARGET_TYPE.EXTENSION_TOKEN,
    targetId: issued.tokenId,
    metadata: {
      familyId: issued.familyId,
      cnfJkt: dpopResult.jkt,
    },
  });

  // Replay protection is provided by the JTI cache (per-jkt, TTL-bounded).
  // The previous DPoP-Nonce emission was removed because the verifier passed
  // expectedNonce: null, making the emit-without-verify pattern a spec/impl
  // inconsistency without security benefit.
  return NextResponse.json(
    {
      access_token: issued.accessToken,
      refresh_token: issued.refreshToken,
      expires_in: Math.floor(IOS_TOKEN_IDLE_TIMEOUT_MS / 1000),
      token_type: "DPoP",
    },
    {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

export const POST = withRequestLog(handlePOST);
