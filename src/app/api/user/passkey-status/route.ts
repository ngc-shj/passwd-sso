import { type NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/with-request-log";
import { checkAuth } from "@/lib/check-auth";
import { errorResponse, rateLimited } from "@/lib/api-response";
import { API_ERROR } from "@/lib/api-error-codes";
import { createRateLimiter } from "@/lib/rate-limit";

export const runtime = "nodejs";

const rateLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });

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
    const data = await withBypassRls(prisma, async () => {
      const [credCount, user] = await Promise.all([
        prisma.webAuthnCredential.count({ where: { userId } }),
        prisma.user.findUnique({
          where: { id: userId },
          select: {
            tenant: {
              select: {
                requirePasskey: true,
                requirePasskeyEnabledAt: true,
                passkeyGracePeriodDays: true,
              },
            },
          },
        }),
      ]);
      return { credCount, tenant: user?.tenant ?? null };
    }, BYPASS_PURPOSE.AUTH_FLOW);

    const hasPasskey = data.credCount > 0;
    const required = data.tenant?.requirePasskey ?? false;
    const enabledAt = data.tenant?.requirePasskeyEnabledAt ?? null;
    const gracePeriodDays = data.tenant?.passkeyGracePeriodDays ?? null;

    let gracePeriodRemaining: number | null = null;
    if (required && !hasPasskey && enabledAt && gracePeriodDays != null && gracePeriodDays > 0) {
      const enabledAtMs = new Date(enabledAt).getTime();
      const gracePeriodMs = gracePeriodDays * 24 * 60 * 60 * 1000;
      const remainingMs = enabledAtMs + gracePeriodMs - Date.now();
      gracePeriodRemaining = remainingMs > 0 ? Math.ceil(remainingMs / (24 * 60 * 60 * 1000)) : 0;
    }

    return NextResponse.json({
      required,
      hasPasskey,
      gracePeriodRemaining,
    });
  } catch {
    return errorResponse(API_ERROR.INTERNAL_ERROR, 500);
  }
}

export const GET = withRequestLog(handleGET);
