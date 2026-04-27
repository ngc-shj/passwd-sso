/**
 * Admin bearer token verification for admin-only API endpoints.
 *
 * Only accepts per-operator op_* DB-backed tokens. The legacy shared
 * ADMIN_API_TOKEN env value was removed; operators bootstrap by minting
 * a token via the tenant dashboard (session-authed Auth.js UI).
 */

import type { NextRequest } from "next/server";
import { OPERATOR_TOKEN_PREFIX, type OperatorTokenScope } from "@/lib/constants/auth/operator-token";
import { validateOperatorToken } from "@/lib/auth/tokens/operator-token";

// ─── Types ───────────────────────────────────────────────────

export interface AdminAuth {
  subjectUserId: string;
  tenantId: string;
  tokenId: string;
  scopes: readonly OperatorTokenScope[];
}

export type VerifyAdminFailReason = "MISSING_OR_MALFORMED" | "INVALID";

export type VerifyAdminResult =
  | { ok: true; auth: AdminAuth }
  | { ok: false; reason: VerifyAdminFailReason };

// ─── Verification ─────────────────────────────────────────────

/**
 * Verify the admin Bearer token from the request Authorization header.
 *
 * @param req - The incoming Next.js request.
 */
export async function verifyAdminToken(
  req: NextRequest,
): Promise<VerifyAdminResult> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return { ok: false, reason: "MISSING_OR_MALFORMED" };
  }

  const plaintext = authHeader.slice(7).trim();
  if (!plaintext.startsWith(OPERATOR_TOKEN_PREFIX)) {
    return { ok: false, reason: "MISSING_OR_MALFORMED" };
  }

  const result = await validateOperatorToken(req);
  if (!result.ok) {
    return { ok: false, reason: "INVALID" };
  }
  return {
    ok: true,
    auth: {
      subjectUserId: result.data.subjectUserId,
      tenantId: result.data.tenantId,
      tokenId: result.data.tokenId,
      scopes: result.data.scopes,
    },
  };
}
