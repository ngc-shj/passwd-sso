/**
 * POST /api/mobile/token/refresh — Rotate an iOS access+refresh token pair.
 *
 * Required headers:
 *   - `Authorization: DPoP <refresh_token>` — bearer is the *refresh* token,
 *     not the access token.
 *   - `DPoP: <proof>` — proof's `ath` claim MUST equal SHA-256(refresh_token),
 *     base64url. RFC 9449 traditionally pins `ath` to the access token; this
 *     route deliberately points it at the refresh token because that is the
 *     bearer presented on this request. The `cnf.jkt` of the proof MUST match
 *     the row's stored `cnfJkt`.
 *
 * Body:
 *   - `refresh_token` — must equal the bearer; checked for equality so a
 *     proxy that strips the Authorization header can't slip a different
 *     token through the body.
 *
 * Side effects under transactional lock (handled by `refreshIosToken`):
 *   - Happy path → revoke old pair atomically, mint new pair, audit
 *     `MOBILE_TOKEN_REFRESHED`.
 *   - Replay of an already-revoked refresh token (different body) → revoke
 *     the entire family, audit `MOBILE_TOKEN_REPLAY_DETECTED`, return 401.
 *   - Legitimate retry-after-network-failure (revoked + byte-identical body
 *     within the grace window) → return the cached new pair, no extra audit.
 *   - Family absolute-expiry → return 401, no new pair.
 *
 * Rate limit: per-userId 20 req / 15 min.
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
  rateLimited,
  zodValidationError,
} from "@/lib/http/api-response";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/http/with-request-log";
import { getLogger } from "@/lib/logger";
import { MS_PER_MINUTE } from "@/lib/constants/time";
import { canonicalHtu } from "@/lib/auth/dpop/htu-canonical";
import {
  verifyDpopProof,
  computeAth,
} from "@/lib/auth/dpop/verify";
import { getJtiCache } from "@/lib/auth/dpop/jti-cache";
import { getDpopNonceService } from "@/lib/auth/dpop/nonce";
import {
  refreshIosToken,
  IOS_TOKEN_IDLE_TIMEOUT_MS,
} from "@/lib/auth/tokens/mobile-token";

export const runtime = "nodejs";

const refreshLimiter = createRateLimiter({
  windowMs: 15 * MS_PER_MINUTE,
  max: 20,
});

const RefreshRequestSchema = z
  .object({
    refresh_token: z
      .string()
      .min(64)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();

function safeStringEqual(a: string, b: string): boolean {
  if (a.length === 0 || b.length === 0) return false;
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function extractDpopBearer(req: NextRequest): string | null {
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  const m = auth.match(/^DPoP\s+(.+)$/i);
  return m?.[1]?.trim() ?? null;
}

async function handlePOST(req: NextRequest): Promise<Response> {
  // We need raw body bytes for the replay-vs-retry hash AND a parsed copy
  // for validation. Read once, then reparse from the buffer.
  const rawBody = new Uint8Array(await req.arrayBuffer());
  let parsedBody: unknown;
  try {
    parsedBody = rawBody.length === 0
      ? null
      : JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return errorResponse(API_ERROR.INVALID_JSON, 400);
  }
  const parsed = RefreshRequestSchema.safeParse(parsedBody);
  if (!parsed.success) {
    return zodValidationError(parsed.error);
  }
  const { refresh_token: bodyRefreshToken } = parsed.data;

  // Authorization header must carry the same refresh token.
  const headerToken = extractDpopBearer(req);
  if (!headerToken || !safeStringEqual(headerToken, bodyRefreshToken)) {
    return errorResponse(API_ERROR.UNAUTHORIZED, 401);
  }

  // Look up the refresh-token row by its hash. Lookup is via bypass-RLS
  // because we only know which tenant to scope to AFTER reading the row.
  const refreshHash = hashToken(bodyRefreshToken);
  const oldRow = await withBypassRls(
    prisma,
    async () =>
      prisma.extensionToken.findUnique({
        where: { tokenHash: refreshHash },
        select: {
          id: true,
          userId: true,
          tenantId: true,
          tokenHash: true,
          cnfJkt: true,
          scope: true,
          expiresAt: true,
          familyId: true,
          familyCreatedAt: true,
          revokedAt: true,
          devicePubkey: true,
          clientKind: true,
        },
      }),
    BYPASS_PURPOSE.TOKEN_LIFECYCLE,
  );
  if (!oldRow || oldRow.clientKind !== "IOS_APP") {
    return errorResponse(API_ERROR.UNAUTHORIZED, 401);
  }
  if (!oldRow.cnfJkt || !oldRow.devicePubkey) {
    // Defensive — IOS_APP rows MUST have these set. If we ever read a
    // row without them, something else has corrupted state.
    getLogger().error(
      {
        event: "mobile_token_refresh_missing_binding",
        tokenId: oldRow.id,
      },
      "IOS_APP token row missing cnfJkt/devicePubkey",
    );
    return errorResponse(API_ERROR.MOBILE_REFRESH_TOKEN_REVOKED, 401);
  }

  // Per-userId rate limit (only after we know the user). A stranger holding
  // a stolen refresh token would have to know a valid token-hash to even
  // surface a userId, so leakage of "this token exists" is acceptable.
  const rl = await refreshLimiter.check(`rl:mobile_refresh:${oldRow.userId}`);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  // Verify DPoP proof. `ath` = SHA-256(refresh_token), `cnf.jkt` = row's cnfJkt.
  const expectedAth = computeAth(bodyRefreshToken);
  const dpopHeader = req.headers.get("dpop");
  const dpopResult = await verifyDpopProof(dpopHeader, {
    expectedHtm: "POST",
    expectedHtu: canonicalHtu({ route: "/api/mobile/token/refresh" }),
    expectedAth,
    expectedCnfJkt: oldRow.cnfJkt,
    expectedNonce: null,
    jtiCache: getJtiCache(),
  });
  if (!dpopResult.ok) {
    return errorResponse(API_ERROR.MOBILE_DPOP_INVALID, 401);
  }

  // Hand off to `refreshIosToken` — it owns rotation, replay-vs-retry
  // disambiguation, family-expiry, and the success audit.
  const result = await refreshIosToken({
    req,
    bodyBytes: rawBody,
    oldRow: {
      id: oldRow.id,
      userId: oldRow.userId,
      tenantId: oldRow.tenantId,
      cnfJkt: oldRow.cnfJkt,
      scope: oldRow.scope,
      expiresAt: oldRow.expiresAt,
      familyId: oldRow.familyId,
      familyCreatedAt: oldRow.familyCreatedAt,
      revokedAt: oldRow.revokedAt,
      tokenHash: oldRow.tokenHash,
      devicePubkey: oldRow.devicePubkey,
    },
    devicePubkey: oldRow.devicePubkey,
    cnfJkt: oldRow.cnfJkt,
  });

  if (!result.ok) {
    switch (result.error) {
      case "REFRESH_REPLAY_DETECTED":
        return errorResponse(API_ERROR.MOBILE_REFRESH_REPLAY_DETECTED, 401);
      case "REFRESH_TOKEN_FAMILY_EXPIRED":
        return errorResponse(API_ERROR.MOBILE_REFRESH_FAMILY_EXPIRED, 401);
      case "REFRESH_TOKEN_REVOKED":
        return errorResponse(API_ERROR.MOBILE_REFRESH_TOKEN_REVOKED, 401);
    }
  }

  const nonceService = getDpopNonceService();
  void nonceService.rotateIfDue().catch(() => {});
  const nonce = await nonceService.current();

  return NextResponse.json(
    {
      access_token: result.token.accessToken,
      refresh_token: result.token.refreshToken,
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
