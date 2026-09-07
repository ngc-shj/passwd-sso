import { type NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { resolveOwningTenantIdFromClient } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/http/with-request-log";
import { checkAuth } from "@/lib/auth/session/check-auth";
import { errorResponse, rateLimited } from "@/lib/http/api-response";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { MS_PER_DAY } from "@/lib/constants/time";
import { RATE_WINDOW_MS } from "@/lib/validations/common.server";

export const runtime = "nodejs";

const rateLimiter = createRateLimiter({ windowMs: RATE_WINDOW_MS, max: 60 });

/**
 * GET /api/user/passkey-status
 * Returns passkey enforcement status for the current user's tenant.
 * Used by the dashboard to show enforcement banners during grace period.
 */
async function handleGET(request: NextRequest) {
  const result = await checkAuth(request);
  if (!result.ok) return result.response;
  const { userId } = result.auth;

  const rl = await rateLimiter.check(`rl:passkey_status:${userId}`);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  try {
    const data = await withBypassRls(prisma, async (tx) => {
      // Whose passkey enforcement applies is decided by the ACTIVE MEMBERSHIP.
      // Traversing `user.tenant` follows the `User.tenantId` column instead — a
      // denormalized copy with no invalidation, uncorrected here because the read
      // is bypass-scoped.
      const [credCount, tenantId] = await Promise.all([
        tx.webAuthnCredential.count({ where: { userId } }),
        resolveOwningTenantIdFromClient(tx, userId),
      ]);
      const tenant = tenantId
        ? await tx.tenant.findUnique({
            where: { id: tenantId },
            select: {
              requirePasskey: true,
              requirePasskeyEnabledAt: true,
              passkeyGracePeriodDays: true,
            },
          })
        : null;
      return { credCount, tenant };
    }, BYPASS_PURPOSE.AUTH_FLOW);

    const hasPasskey = data.credCount > 0;
    const required = data.tenant?.requirePasskey ?? false;
    const enabledAt = data.tenant?.requirePasskeyEnabledAt ?? null;
    const gracePeriodDays = data.tenant?.passkeyGracePeriodDays ?? null;

    let gracePeriodRemaining: number | null = null;
    if (required && !hasPasskey && enabledAt && gracePeriodDays != null && gracePeriodDays > 0) {
      const enabledAtMs = new Date(enabledAt).getTime();
      const gracePeriodMs = gracePeriodDays * MS_PER_DAY;
      const remainingMs = enabledAtMs + gracePeriodMs - Date.now();
      gracePeriodRemaining = remainingMs > 0 ? Math.ceil(remainingMs / MS_PER_DAY) : 0;
    }

    return NextResponse.json({
      required,
      hasPasskey,
      gracePeriodRemaining,
    });
  } catch {
    return errorResponse(API_ERROR.INTERNAL_ERROR);
  }
}

export const GET = withRequestLog(handleGET);
