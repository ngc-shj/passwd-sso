/**
 * POST /api/mobile/cache-rollback-report — Audit emission for AutoFill-cache
 * rollback rejections detected by the iOS host app.
 *
 * The host app (or AutoFill extension) computes a content fingerprint over its
 * encrypted credential cache; when a counter / header / AEAD check fails, it
 * reports the kind of rejection here so server-side audit can spot a pattern
 * that indicates a tampered or rolled-back device cache.
 *
 * Auth: validated via `validateExtensionToken` (which dispatches to the iOS
 * DPoP path for IOS_APP rows). The proof's `ath` MUST equal SHA-256(access
 * token); `cnf.jkt` MUST match the row's stored thumbprint.
 *
 * Audit:
 *   - `rejectionKind === ROLLBACK_REJECTION_KIND.FLAG_FORGED` → MOBILE_CACHE_FLAG_FORGED.
 *   - All other rejection kinds        → MOBILE_CACHE_ROLLBACK_REJECTED.
 *
 * Rate limit: per-(tenantId, deviceId) 5 req / 24 h (per S34) — the legitimate
 * burst should be ≤ 1 per detection event; anything more is forensic noise.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { API_ERROR } from "@/lib/http/api-error-codes";
import {
  errorResponse,
  rateLimited,
  zodValidationError,
} from "@/lib/http/api-response";
import { validateExtensionToken } from "@/lib/auth/tokens/extension-token";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { withRequestLog } from "@/lib/http/with-request-log";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { MS_PER_HOUR } from "@/lib/constants/time";

export const runtime = "nodejs";

// 5 req / 24 h per (tenantId, deviceId).
const reportLimiter = createRateLimiter({
  windowMs: 24 * MS_PER_HOUR,
  max: 5,
});

/**
 * AutoFill-extension-detected reasons for rejecting a cached entries
 * blob. Exposed as a const-object so call sites and tests reference
 * symbols rather than copy-pasted string literals (matches the
 * AUDIT_ACTION / DPOP_VERIFY_ERROR pattern). The string values are the
 * stable wire format the iOS client sends in the request body and the
 * audit pipeline persists in metadata.
 */
export const ROLLBACK_REJECTION_KIND = {
  COUNTER_MISMATCH: "counter_mismatch",
  HEADER_STALE: "header_stale",
  AAD_MISMATCH: "aad_mismatch",
  AUTHTAG_INVALID: "authtag_invalid",
  HEADER_CLOCK_SKEW: "header_clock_skew",
  HEADER_MISSING: "header_missing",
  ENTRY_COUNT_MISMATCH: "entry_count_mismatch",
  HEADER_INVALID: "header_invalid",
  FLAG_FORGED: "flag_forged",
} as const;

export type RollbackRejectionKind =
  (typeof ROLLBACK_REJECTION_KIND)[keyof typeof ROLLBACK_REJECTION_KIND];

const REJECTION_KIND_VALUES = Object.values(ROLLBACK_REJECTION_KIND) as [
  RollbackRejectionKind,
  ...RollbackRejectionKind[],
];

const ReportRequestSchema = z
  .object({
    deviceId: z.string().min(1).max(128),
    expectedCounter: z.number().int().nonnegative(),
    observedCounter: z.number().int().nonnegative(),
    headerIssuedAt: z.number().int().nonnegative(),
    lastSuccessfulRefreshAt: z.number().int().nonnegative(),
    rejectionKind: z.enum(REJECTION_KIND_VALUES),
  })
  .strict();

async function handlePOST(req: NextRequest): Promise<Response> {
  // 1. Validate token via the unified entry point — dispatches to DPoP for
  // IOS_APP rows. The DPoP proof's `ath` and `cnf.jkt` are checked there.
  const auth = await validateExtensionToken(req);
  if (!auth.ok) {
    return errorResponse(API_ERROR[auth.error], 401);
  }
  const { userId, tenantId } = auth.data;

  // 2. Body validation. Reject any unknown field (Zod strict).
  const body = await req.json().catch(() => null);
  const parsed = ReportRequestSchema.safeParse(body);
  if (!parsed.success) {
    return zodValidationError(parsed.error);
  }
  const data = parsed.data;

  // 3. Rate-limit per (tenantId, deviceId). After auth so we know the tenant
  // bucket, before the audit emit so we don't burn an audit row on flood.
  const rl = await reportLimiter.check(
    `rl:mobile_cache_rollback:${tenantId}:${data.deviceId}`,
  );
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  // 4. Audit emit. flag_forged is its own action so SIEM can filter it.
  const action =
    data.rejectionKind === ROLLBACK_REJECTION_KIND.FLAG_FORGED
      ? AUDIT_ACTION.MOBILE_CACHE_FLAG_FORGED
      : AUDIT_ACTION.MOBILE_CACHE_ROLLBACK_REJECTED;
  await logAuditAsync({
    ...personalAuditBase(req, userId),
    action,
    tenantId,
    targetType: AUDIT_TARGET_TYPE.EXTENSION_TOKEN,
    targetId: auth.data.tokenId,
    metadata: data,
  });

  return NextResponse.json({ ok: true }, { status: 200 });
}

export const POST = withRequestLog(handlePOST);
