import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSessionToken } from "@/app/api/sessions/helpers";
import { API_ERROR, type ApiErrorCode } from "@/lib/http/api-error-codes";
import { errorResponse, unauthorized } from "@/lib/http/api-response";
import { MS_PER_MINUTE } from "@/lib/constants/time";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";

export const STEP_UP_WINDOW_MS = 15 * MS_PER_MINUTE;
export const PASSKEY_STEP_UP_WINDOW_MS = 15 * MS_PER_MINUTE;

type RequireRecentSessionOptions = {
  maxAgeMs?: number;
  errorCode?: ApiErrorCode;
};

/**
 * Require that the current Auth.js session was created recently enough for
 * sensitive credential-issuance flows.
 */
export async function requireRecentSession(
  req: NextRequest,
  options: RequireRecentSessionOptions = {},
) {
  const {
    maxAgeMs = STEP_UP_WINDOW_MS,
    errorCode = API_ERROR.SESSION_STEP_UP_REQUIRED,
  } = options;
  const sessionToken = getSessionToken(req);
  if (!sessionToken) {
    return unauthorized();
  }

  const sessionRow = await withBypassRls(
    prisma,
    async () =>
      prisma.session.findUnique({
        where: { sessionToken },
        select: { createdAt: true },
      }),
    BYPASS_PURPOSE.AUTH_FLOW,
  );

  if (!sessionRow) {
    return unauthorized();
  }

  if (Date.now() - sessionRow.createdAt.getTime() > maxAgeMs) {
    return errorResponse(errorCode, 403);
  }

  return null;
}

/**
 * Require a fresh passkey verification on the current session row.
 *
 * Unlike `requireRecentSession`, this uses explicit session freshness metadata
 * and does not overload `createdAt` as a proxy for high-assurance reauth.
 */
export async function requireFreshPasskey(
  req: NextRequest,
  options: RequireRecentSessionOptions = {},
) {
  const {
    maxAgeMs = PASSKEY_STEP_UP_WINDOW_MS,
    errorCode = API_ERROR.SESSION_STEP_UP_REQUIRED,
  } = options;
  const sessionToken = getSessionToken(req);
  if (!sessionToken) {
    return unauthorized();
  }

  const sessionRow = await withBypassRls(
    prisma,
    async () =>
      prisma.session.findUnique({
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
    async () =>
      prisma.session.update({
        where: { sessionToken },
        data: { passkeyVerifiedAt: verifiedAt },
      }),
    BYPASS_PURPOSE.AUTH_FLOW,
  );
}
