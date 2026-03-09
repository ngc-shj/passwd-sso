import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { API_ERROR } from "@/lib/api-error-codes";
import { validateApiKeyOnly } from "@/lib/api-key";
import { withRequestLog } from "@/lib/with-request-log";
import { withTenantRls } from "@/lib/tenant-rls";
import { createRateLimiter } from "@/lib/rate-limit";
import { API_KEY_SCOPE } from "@/lib/constants/api-key";
import { enforceAccessRestriction } from "@/lib/access-restriction";

const apiKeyLimiter = createRateLimiter({ windowMs: 60_000, max: 100 });

// GET /api/v1/vault/status — Check vault initialization status (API key only)
async function handleGET(req: NextRequest) {
  const authResult = await validateApiKeyOnly(req, API_KEY_SCOPE.VAULT_STATUS);
  if (!authResult.ok) {
    if (authResult.error === "SCOPE_INSUFFICIENT") {
      return NextResponse.json(
        { error: API_ERROR.API_KEY_SCOPE_INSUFFICIENT },
        { status: 403 },
      );
    }
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { userId, tenantId, apiKeyId } = authResult.data;

  const denied = await enforceAccessRestriction(req, userId, tenantId);
  if (denied) return denied;

  const rl = await apiKeyLimiter.check(`rl:api_key:${apiKeyId}`);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: API_ERROR.RATE_LIMIT_EXCEEDED },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs! / 1000)) } },
    );
  }

  const user = await withTenantRls(prisma, tenantId, async () =>
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        encryptedSecretKey: true,
        keyVersion: true,
      },
    }),
  );

  return NextResponse.json({
    initialized: !!user?.encryptedSecretKey,
    keyVersion: user?.keyVersion ?? null,
  });
}

export const GET = withRequestLog(handleGET);
