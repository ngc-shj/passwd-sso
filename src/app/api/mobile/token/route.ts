/**
 * POST /api/mobile/token — Exchange a one-time bridge code for a DPoP-bound
 * access+refresh token pair.
 *
 * Step 2 of the iOS pairing handshake. Called from the iOS host app after it
 * receives the bridge code from the Universal-Link redirect target. The route:
 *
 *   1. Rate-limits per client IP (no session is available at this point).
 *   2. Validates the body shape.
 *   3. Atomically consumes the bridge code (single UPDATE + count check).
 *   4. Verifies the PKCE challenge (S256) and the client-supplied
 *      `device_pubkey` matches the value stored at authorize.
 *   5. Verifies the DPoP proof. The proof MUST be signed by the same key
 *      whose JWK thumbprint matches `device_pubkey` (i.e. the key the user
 *      registered at `/api/mobile/authorize`). No `ath` is required at this
 *      step because the client doesn't yet have an access token.
 *   6. Calls `issueIosToken()` to mint the access+refresh pair, stamps a
 *      fresh `DPoP-Nonce` on the response, and audits `MOBILE_TOKEN_ISSUED`.
 *
 * Compensating controls (no Auth.js session, no Origin check):
 *   - 256-bit single-use bridge code with 60s TTL.
 *   - PKCE binds the exchange to the device that initiated `/authorize`.
 *   - DPoP proof binds the exchange to the device pubkey.
 *   - Per-IP rate limit (10 req / 15 min) caps brute force.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createHash, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/crypto/crypto-server";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { API_ERROR } from "@/lib/http/api-error-codes";
import {
  errorResponse,
  rateLimited,
  zodValidationError,
} from "@/lib/http/api-response";
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
import { getDpopNonceService } from "@/lib/auth/dpop/nonce";
import {
  issueIosToken,
  IOS_TOKEN_IDLE_TIMEOUT_MS,
} from "@/lib/auth/tokens/mobile-token";
import { verifyPkceS256 } from "@/lib/mcp/oauth-server";

export const runtime = "nodejs";

const tokenLimiter = createRateLimiter({
  windowMs: 15 * MS_PER_MINUTE,
  max: 10,
});

const TokenRequestSchema = z
  .object({
    code: z.string().length(64).regex(/^[a-f0-9]+$/),
    code_verifier: z
      .string()
      .min(43)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
    device_pubkey: z
      .string()
      .min(64)
      .max(512)
      .regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();

function safeStringEqual(a: string, b: string): boolean {
  if (a.length === 0 || b.length === 0) return false;
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Recompute the JWK thumbprint expected for a given client-supplied
 * `device_pubkey`. The iOS app supplies the pubkey as base64url(SPKI-DER).
 * The DPoP proof carries the same key as a JWK in its header — we extract
 * the JWK's thumbprint via `verifyDpopProof` and compare to the thumbprint
 * SHA-256(device_pubkey) here. This anchors the proof to the registered key
 * even if the SPKI encoding differs, by hashing the client-supplied bytes
 * once on registration AND once at exchange.
 */
function devicePubkeyFingerprint(devicePubkey: string): string {
  return createHash("sha256").update(devicePubkey).digest("base64url");
}

async function handlePOST(req: NextRequest): Promise<Response> {
  // 1. Rate limit BEFORE DB lookup. Keyed by client IP.
  const ip = extractClientIp(req) ?? "unknown";
  const rl = await tokenLimiter.check(`rl:mobile_token:${rateLimitKeyFromIp(ip)}`);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  // 2. Parse + validate body.
  const body = await req.json().catch(() => null);
  const parsed = TokenRequestSchema.safeParse(body);
  if (!parsed.success) {
    getLogger().warn(
      {
        event: "mobile_token_failure",
        reason: "invalid_request",
        ip,
      },
      "mobile token failed: malformed body",
    );
    return zodValidationError(parsed.error);
  }
  const { code, code_verifier: codeVerifier, device_pubkey: devicePubkey } =
    parsed.data;

  // 3. Atomically consume the bridge code.
  const codeHash = hashToken(code);
  const now = new Date();
  const consumeResult = await withBypassRls(
    prisma,
    async () =>
      prisma.mobileBridgeCode.updateMany({
        where: {
          codeHash,
          usedAt: null,
          expiresAt: { gt: now },
        },
        data: { usedAt: now },
      }),
    BYPASS_PURPOSE.TOKEN_LIFECYCLE,
  );
  if (consumeResult.count === 0) {
    getLogger().warn(
      {
        event: "mobile_token_failure",
        reason: "bridge_code_invalid",
        ip,
      },
      "mobile token failed: bridge code unknown, expired, or already consumed",
    );
    return errorResponse(API_ERROR.MOBILE_BRIDGE_CODE_INVALID, 400);
  }

  // 4. Load the consumed row to recover stored bindings.
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
          devicePubkey: true,
        },
      }),
    BYPASS_PURPOSE.TOKEN_LIFECYCLE,
  );
  if (!stored) {
    getLogger().error(
      {
        event: "mobile_token_invariant_violation",
        codeHash,
      },
      "consumed mobile bridge code missing after successful update",
    );
    return errorResponse(API_ERROR.INTERNAL_ERROR, 500);
  }

  // 5. Verify device_pubkey binding (constant-time).
  if (!safeStringEqual(stored.devicePubkey, devicePubkey)) {
    getLogger().warn(
      {
        event: "mobile_token_failure",
        reason: "device_pubkey_mismatch",
        userId: stored.userId,
      },
      "mobile token failed: device_pubkey mismatch",
    );
    return errorResponse(API_ERROR.MOBILE_DEVICE_PUBKEY_MISMATCH, 400);
  }

  // 6. PKCE: stored.codeChallenge must equal base64url(SHA-256(code_verifier)).
  if (!verifyPkceS256(stored.codeChallenge, codeVerifier)) {
    getLogger().warn(
      {
        event: "mobile_token_failure",
        reason: "pkce_mismatch",
        userId: stored.userId,
      },
      "mobile token failed: PKCE challenge did not match",
    );
    return errorResponse(API_ERROR.MOBILE_PKCE_MISMATCH, 400);
  }

  // 7. Verify DPoP proof. No `ath` at this step (no access token yet); the
  // proof's JWK thumbprint MUST equal the fingerprint of the registered key.
  const expectedCnfJkt = devicePubkeyFingerprint(devicePubkey);
  const dpopHeader = req.headers.get("dpop");
  const dpopResult = await verifyDpopProof(dpopHeader, {
    expectedHtm: "POST",
    expectedHtu: canonicalHtu({ route: "/api/mobile/token" }),
    expectedCnfJkt,
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
    return errorResponse(API_ERROR.MOBILE_DPOP_INVALID, 401);
  }

  // 8. Issue the token pair. cnfJkt is the verifier-computed thumbprint of
  // the proof's own JWK — same value as `expectedCnfJkt` post-verify.
  let issued: Awaited<ReturnType<typeof issueIosToken>>;
  try {
    issued = await issueIosToken({
      userId: stored.userId,
      tenantId: stored.tenantId,
      devicePubkey,
      cnfJkt: dpopResult.jkt,
      ip: extractClientIp(req),
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
    return errorResponse(API_ERROR.INTERNAL_ERROR, 500);
  }

  await logAuditAsync({
    ...personalAuditBase(req, stored.userId),
    action: AUDIT_ACTION.MOBILE_TOKEN_ISSUED,
    tenantId: stored.tenantId,
    targetType: AUDIT_TARGET_TYPE.EXTENSION_TOKEN,
    targetId: issued.tokenId,
    metadata: {
      familyId: issued.familyId,
      cnfJkt: issued.tokenId ? dpopResult.jkt : undefined,
    },
  });

  // 9. Stamp DPoP-Nonce on the response (RFC 9449 §8 — clients MUST echo on
  // subsequent calls). Best-effort rotation tick.
  const nonceService = getDpopNonceService();
  void nonceService.rotateIfDue().catch(() => {});
  const nonce = await nonceService.current();

  return NextResponse.json(
    {
      access_token: issued.accessToken,
      refresh_token: issued.refreshToken,
      expires_in: Math.floor(IOS_TOKEN_IDLE_TIMEOUT_MS / 1000),
      token_type: "DPoP",
    },
    {
      status: 200,
      headers: {
        "DPoP-Nonce": nonce,
        "Cache-Control": "no-store",
      },
    },
  );
}

export const POST = withRequestLog(handlePOST);
