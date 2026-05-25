/**
 * POST /api/extension/key/reset — Revoke extension tokens bound to the caller's DPoP key.
 *
 * Called by the extension Options page before the user discards an IDB key pair
 * (per FR12). The endpoint:
 *  1. Validates Bearer + DPoP (BROWSER_EXTENSION always requires DPoP).
 *  2. Enforces per-user rate limit (5 calls per 15 min — reset is rare).
 *  3. Parses body { cnfJkt } and verifies it equals the validated token's cnfJkt.
 *     This proves the caller holds the key they are asking to revoke — closing
 *     the stolen-Bearer revoke-DoS vector.
 *  4. Revokes all ExtensionToken rows for the userId with matching cnfJkt.
 *  5. Emits EXTENSION_TOKEN_FAMILY_REVOKED audit with reason "user_key_reset".
 *
 * No session cookie required — endpoint is in EXTENSION_TOKEN_ROUTES bypass list.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createHash, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { validateExtensionToken } from "@/lib/auth/tokens/extension-token";
import { unauthorized, errorResponse } from "@/lib/http/api-response";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { parseBody } from "@/lib/http/parse-body";
import { withRequestLog } from "@/lib/http/with-request-log";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { MS_PER_MINUTE } from "@/lib/constants/time";
import { getLogger } from "@/lib/logger";
import { extractClientIp } from "@/lib/auth/policy/ip-access";

export const runtime = "nodejs";

const keyResetLimiter = createRateLimiter({
  windowMs: 15 * MS_PER_MINUTE,
  max: 5,
  failClosedOnRedisError: true,
});

const KeyResetRequestSchema = z
  .object({ cnfJkt: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
  .strict();

function safeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

async function handlePOST(req: NextRequest) {
  // Authenticate via Bearer + DPoP (validateExtensionToken always requires DPoP
  // for BROWSER_EXTENSION rows post-migration).
  const validated = await validateExtensionToken(req);
  if (!validated.ok) {
    // Diagnostic: reset failures are silent at the wire (401 only); without
    // the reason field operators cannot tell a stale-token (INVALID/REVOKED)
    // case apart from a DPoP-binding bug (DPOP_INVALID). Log structured.
    getLogger().warn(
      {
        event: "extension_key_reset_auth_failure",
        reason: validated.error,
        ip: extractClientIp(req),
        userAgent: req.headers.get("user-agent"),
      },
      "extension key reset auth failed",
    );
    return unauthorized();
  }

  const { userId, tenantId, cnfJkt: tokenCnfJkt } = validated.data;

  // Per-user rate limit — 5 calls per 15 min (reset is rare).
  const blocked = await checkRateLimitOrFail({
    req,
    limiter: keyResetLimiter,
    key: `rl:ext_key_reset:${userId}`,
    scope: "extension.key_reset",
    userId,
    tenantId,
  });
  if (blocked) return blocked;

  // Parse body.
  const body = await parseBody(req, KeyResetRequestSchema);
  if (!body.ok) return body.response;

  // Critical invariant: body cnfJkt MUST equal the DPoP-validated token's cnfJkt.
  // This proves the caller holds the key they are asking to revoke — otherwise a
  // stolen Bearer could revoke the legitimate user's OTHER cnfJkt-bound tokens.
  if (!safeStringEqual(body.data.cnfJkt, tokenCnfJkt)) {
    return errorResponse(API_ERROR.INVALID_REQUEST);
  }

  // Revoke ONLY tokens belonging to the calling userId with matching cnfJkt.
  // Other users' tokens with the same jkt (statistically impossible collision)
  // are never touched.
  const result = await withBypassRls(
    prisma,
    async (tx) =>
      tx.extensionToken.updateMany({
        where: {
          userId,
          cnfJkt: body.data.cnfJkt,
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      }),
    BYPASS_PURPOSE.TOKEN_LIFECYCLE,
  );

  const cnfJktFingerprint = createHash("sha256")
    .update(body.data.cnfJkt)
    .digest("hex")
    .slice(0, 16);

  await logAuditAsync({
    ...personalAuditBase(req, userId),
    tenantId,
    action: AUDIT_ACTION.EXTENSION_TOKEN_FAMILY_REVOKED,
    targetType: AUDIT_TARGET_TYPE.EXTENSION_TOKEN,
    metadata: {
      reason: "user_key_reset",
      cnfJktFingerprint,
      rowsRevoked: result.count,
    },
  });

  return NextResponse.json({ revoked: result.count }, { status: 200 });
}

export const POST = withRequestLog(handlePOST);
