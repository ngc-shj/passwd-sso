import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSessionToken } from "@/app/api/sessions/helpers";
import { API_ERROR, type ApiErrorCode } from "@/lib/http/api-error-codes";
import { errorResponse, unauthorized } from "@/lib/http/api-response";
import { MS_PER_MINUTE } from "@/lib/constants/time";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";

export const STEP_UP_WINDOW_MS = 15 * MS_PER_MINUTE;

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
