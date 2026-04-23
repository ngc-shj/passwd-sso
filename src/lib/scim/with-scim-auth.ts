import type { NextRequest, NextResponse } from "next/server";
import { validateScimToken, type ValidatedScimToken } from "@/lib/auth/scim-token";
import { scimError } from "@/lib/scim/response";
import { enforceAccessRestriction } from "@/lib/auth/access-restriction";
import { checkScimRateLimit } from "@/lib/scim/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import { SYSTEM_ACTOR_ID } from "@/lib/constants/app";

/**
 * Authenticate + authorize a SCIM request.
 * Runs: token validation → tenant access restriction → rate limit.
 * Returns the validated token data or a Response to short-circuit the handler.
 *
 * Usage:
 *   const auth = await authorizeScim(req);
 *   if (!auth.ok) return auth.response;
 *   const { tenantId, auditUserId, actorType } = auth.data;
 */
export async function authorizeScim(
  req: NextRequest,
): Promise<{ ok: true; data: ValidatedScimToken } | { ok: false; response: NextResponse }> {
  const result = await validateScimToken(req);
  if (!result.ok) {
    return { ok: false, response: scimError(401, API_ERROR[result.error]) };
  }
  const { tenantId } = result.data;
  const denied = await enforceAccessRestriction(req, SYSTEM_ACTOR_ID, tenantId);
  if (denied) return { ok: false, response: denied };
  if (!(await checkScimRateLimit(tenantId))) {
    return { ok: false, response: scimError(429, "Too many requests") };
  }
  return { ok: true, data: result.data };
}
