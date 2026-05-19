import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSessionToken } from "@/app/api/sessions/helpers";
import { API_ERROR, type ApiErrorCode } from "@/lib/http/api-error-codes";
import { errorResponse, unauthorized } from "@/lib/http/api-response";
import { MS_PER_MINUTE } from "@/lib/constants/time";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";

export const PASSKEY_VERIFICATION_WINDOW_MS = 15 * MS_PER_MINUTE;

type RequireRecentPasskeyVerificationOptions = {
  maxAgeMs?: number;
  errorCode?: ApiErrorCode;
};

/**
 * Route-specific stricter guard for WebAuthn-backed freshness.
 *
 * This is intentionally separate from the generic recent-session gate in
 * `session/step-up.ts`: recent passkey verification is a WebAuthn-sensitive
 * authorization check for selected routes, not a baseline session policy
 * applied by the proxy layer.
 */
export async function requireRecentPasskeyVerification(
  req: NextRequest,
  options: RequireRecentPasskeyVerificationOptions = {},
) {
  const {
    maxAgeMs = PASSKEY_VERIFICATION_WINDOW_MS,
    errorCode = API_ERROR.SESSION_STEP_UP_REQUIRED,
  } = options;
  const sessionToken = getSessionToken(req);
  if (!sessionToken) {
    return unauthorized();
  }

  const sessionRow = await withBypassRls(
    prisma,
    async (tx) =>
      tx.session.findUnique({
        where: { sessionToken },
        select: { passkeyVerifiedAt: true },
      }),
    BYPASS_PURPOSE.AUTH_FLOW,
  );

  if (!sessionRow) {
    return unauthorized();
  }

  if (!sessionRow.passkeyVerifiedAt) {
    return errorResponse(errorCode, 403);
  }

  if (Date.now() - sessionRow.passkeyVerifiedAt.getTime() > maxAgeMs) {
    return errorResponse(errorCode, 403);
  }

  return null;
}

export async function markCurrentSessionPasskeyVerified(
  sessionToken: string,
  verifiedAt: Date,
): Promise<void> {
  await withBypassRls(
    prisma,
    async (tx) =>
      tx.session.update({
        where: { sessionToken },
        data: { passkeyVerifiedAt: verifiedAt },
      }),
    BYPASS_PURPOSE.AUTH_FLOW,
  );
}
