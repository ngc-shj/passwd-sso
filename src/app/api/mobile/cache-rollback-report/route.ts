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
 * Rate limit: per-(tenantId, token family) 5 req / 24 h (per S34) — the legitimate
 * burst should be ≤ 1 per detection event; anything more is forensic noise.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { API_ERROR } from "@/lib/http/api-error-codes";
import {
  errorResponse,
  rateLimited,
} from "@/lib/http/api-response";
import { parseBody } from "@/lib/http/parse-body";
import { validateExtensionToken } from "@/lib/auth/tokens/extension-token";
import { enforceAccessRestriction } from "@/lib/auth/policy/access-restriction";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { withRequestLog } from "@/lib/http/with-request-log";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { MS_PER_HOUR } from "@/lib/constants/time";

export const runtime = "nodejs";

// 5 req / 24 h per (tenantId, token family).
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

const U64_MAX = 18446744073709551615n;

// Cache counters are seeded from 64 random bits on iOS, so they are almost
// always beyond Number's exact-integer range: they travel as decimal strings.
// A plain JSON number is accepted only as a safe integer (builds that predate
// the string form, with small counters); a larger number already lost its low
// digits in JSON.parse and cannot be recovered, so int() rejects it. Both forms
// normalise to the decimal string the audit metadata records.
const u64Counter = z
  .union([
    // One refine, not regex().refine(): Zod 4 still runs the refine after a
    // failed regex, and BigInt("12a") throws instead of returning false.
    z
      .string()
      .refine((v) => /^(0|[1-9][0-9]{0,19})$/.test(v) && BigInt(v) <= U64_MAX),
    z.number().int().nonnegative(),
  ])
  .transform((v) => String(v));

const ReportRequestSchema = z
  .object({
    deviceId: z.string().min(1).max(128),
    expectedCounter: u64Counter,
    observedCounter: u64Counter,
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
  const { userId, tenantId, familyId } = auth.data;
  // Only the iOS host app keeps the AutoFill cache these reports describe; an
  // extension (or any future) token must not feed this tamper-detection signal.
  if (auth.data.clientKind !== "IOS_APP") {
    return errorResponse(API_ERROR.FORBIDDEN);
  }

  // Tenant network-boundary enforcement — reject off-network reports from a
  // stolen bearer before parsing body or emitting audit.
  const denied = await enforceAccessRestriction(req, userId, tenantId);
  if (denied) return denied;

  // 2. Body validation. Reject any unknown field (Zod strict).
  const bodyResult = await parseBody(req, ReportRequestSchema);
  if (!bodyResult.ok) return bodyResult.response;
  const data = bodyResult.data;

  // 3. Rate-limit per token family (one per signed-in device). deviceId is
  // client-chosen text, so keying on it let a token holder mint a fresh bucket
  // per request; a new family needs a fresh sign-in. After auth so we know the
  // family, before the audit emit so we don't burn an audit row on flood.
  const rl = await reportLimiter.check(
    `rl:mobile_cache_rollback:${tenantId}:${familyId}`,
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
