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
  zodValidationError,
  unauthorized,
} from "@/lib/http/api-response";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { enforceAccessRestriction } from "@/lib/auth/policy/access-restriction";
import { readBytesWithCap } from "@/lib/http/parse-body";
import { MAX_JSON_BODY_BYTES } from "@/lib/validations/common.server";
import { withRequestLog } from "@/lib/http/with-request-log";
import { NO_STORE_HEADERS } from "@/lib/http/cache-headers";
import { getLogger } from "@/lib/logger";
import { MS_PER_MINUTE, MS_PER_SECOND } from "@/lib/constants/time";
import { canonicalHtu } from "@/lib/auth/dpop/htu-canonical";
import {
  verifyDpopProof,
  computeAth,
} from "@/lib/auth/dpop/verify";
import { getJtiCache } from "@/lib/auth/dpop/jti-cache";
import {
  refreshIosToken,
  IOS_TOKEN_IDLE_TIMEOUT_MS,
} from "@/lib/auth/tokens/mobile-token";
import {
  derivePasskeyState,
  passkeyEnforcementBlocks,
  recordPasskeyAuditEmit,
} from "@/lib/auth/policy/passkey-enforcement";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION } from "@/lib/constants/audit/audit";

export const runtime = "nodejs";

const refreshLimiter = createRateLimiter({
  windowMs: 15 * MS_PER_MINUTE,
  max: 20,
  failClosedOnRedisError: true,
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
  // for validation. Stream-read once under the byte cap, then reparse from the
  // buffer. The streaming cap is authoritative — it aborts mid-read on a
  // chunked body that omits Content-Length, unlike an after-read length check.
  const read = await readBytesWithCap(req, MAX_JSON_BODY_BYTES);
  if (!read.ok) {
    return errorResponse(API_ERROR.PAYLOAD_TOO_LARGE);
  }
  const rawBody = read.bytes;
  let parsedBody: unknown;
  try {
    parsedBody = rawBody.length === 0
      ? null
      : JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    return errorResponse(API_ERROR.INVALID_JSON);
  }
  const parsed = RefreshRequestSchema.safeParse(parsedBody);
  if (!parsed.success) {
    return zodValidationError(parsed.error);
  }
  const { refresh_token: bodyRefreshToken } = parsed.data;

  // Authorization header must carry the same refresh token.
  const headerToken = extractDpopBearer(req);
  if (!headerToken || !safeStringEqual(headerToken, bodyRefreshToken)) {
    return unauthorized();
  }

  // Look up the refresh-token row by its hash. Lookup is via bypass-RLS
  // because we only know which tenant to scope to AFTER reading the row.
  const refreshHash = hashToken(bodyRefreshToken);
  const oldRow = await withBypassRls(
    prisma,
    async (tx) =>
      tx.extensionToken.findUnique({
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
          clientKind: true,
        },
      }),
    BYPASS_PURPOSE.TOKEN_LIFECYCLE,
  );
  if (!oldRow || oldRow.clientKind !== "IOS_APP") {
    return unauthorized();
  }

  // C13: reject deactivated users before proceeding.
  // Lookup is tenant-scoped to the token's own tenantId.
  const member = await withBypassRls(
    prisma,
    async (tx) =>
      tx.tenantMember.findUnique({
        where: { tenantId_userId: { tenantId: oldRow.tenantId, userId: oldRow.userId } },
        select: { deactivatedAt: true },
      }),
    BYPASS_PURPOSE.TOKEN_LIFECYCLE,
  );
  if (!member || member.deactivatedAt !== null) {
    return unauthorized();
  }

  if (!oldRow.cnfJkt) {
    // Defensive — IOS_APP rows MUST have cnfJkt set. If we ever read a
    // row without it, something else has corrupted state.
    getLogger().error(
      {
        event: "mobile_token_refresh_missing_binding",
        tokenId: oldRow.id,
      },
      "IOS_APP token row missing cnfJkt",
    );
    return errorResponse(API_ERROR.MOBILE_REFRESH_TOKEN_REVOKED);
  }

  // Tenant network-boundary enforcement BEFORE rate limit so an off-network
  // holder of a stolen refresh token cannot burn the legitimate user's
  // per-user refresh budget. userId/tenantId come from the validated row.
  const denied = await enforceAccessRestriction(req, oldRow.userId, oldRow.tenantId);
  if (denied) return denied;

  // Per-userId rate limit (only after we know the user). A stranger holding
  // a stolen refresh token would have to know a valid token-hash to even
  // surface a userId, so leakage of "this token exists" is acceptable.
  const blocked = await checkRateLimitOrFail({
    req,
    limiter: refreshLimiter,
    key: `rl:mobile_refresh:${oldRow.userId}`,
    scope: "mobile.token_refresh",
    userId: oldRow.userId,
    tenantId: oldRow.tenantId,
  });
  if (blocked) return blocked;

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
    return errorResponse(API_ERROR.MOBILE_TOKEN_BINDING_INVALID);
  }

  // C8: Passkey enforcement gate — re-derive fresh from DB, fail closed.
  // Tenant source = token row's tenantId (cookieless; no active-session rebind).
  const passkeyState = await derivePasskeyState({
    userId: oldRow.userId,
    tenantId: oldRow.tenantId,
  });
  if (passkeyEnforcementBlocks(passkeyState)) {
    if (recordPasskeyAuditEmit(oldRow.userId, "/api/mobile/token/refresh", Date.now())) {
      await logAuditAsync({
        ...personalAuditBase(req, oldRow.userId),
        tenantId: oldRow.tenantId,
        action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED,
        metadata: { blockedPath: "/api/mobile/token/refresh" },
      });
    }
    return errorResponse(API_ERROR.PASSKEY_REQUIRED);
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
    },
    // cnfJkt IS the device-key thumbprint — same value threaded through.
    deviceJkt: oldRow.cnfJkt,
    cnfJkt: oldRow.cnfJkt,
  });

  if (!result.ok) {
    switch (result.error) {
      case "REFRESH_REPLAY_DETECTED":
        return errorResponse(API_ERROR.MOBILE_REFRESH_REUSE_DETECTED);
      case "REFRESH_TOKEN_FAMILY_EXPIRED":
        return errorResponse(API_ERROR.MOBILE_REFRESH_SESSION_EXPIRED);
    }
  }

  return NextResponse.json(
    {
      access_token: result.token.accessToken,
      refresh_token: result.token.refreshToken,
      expires_in: Math.floor(IOS_TOKEN_IDLE_TIMEOUT_MS / MS_PER_SECOND),
      token_type: "DPoP",
    },
    {
      status: 200,
      headers: { ...NO_STORE_HEADERS },
    },
  );
}

export const POST = withRequestLog(handlePOST);
