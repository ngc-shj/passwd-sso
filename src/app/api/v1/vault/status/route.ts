import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { validateV1Auth } from "@/lib/auth/session/v1-auth";
import { withRequestLog } from "@/lib/http/with-request-log";
import { withTenantRls } from "@/lib/tenant-rls";
import { v1ApiKeyLimiter } from "@/lib/security/rate-limiters";
import { API_KEY_SCOPE } from "@/lib/constants/auth/api-key";
import { enforceAccessRestriction } from "@/lib/auth/policy/access-restriction";
import { rateLimited, unauthorized } from "@/lib/http/api-response";


// GET /api/v1/vault/status — Check vault initialization status (API key or SA token)
async function handleGET(req: NextRequest) {
  const authResult = await validateV1Auth(req, API_KEY_SCOPE.VAULT_STATUS);
  if (!authResult.ok) {
    if (authResult.error === "SCOPE_INSUFFICIENT") {
      return NextResponse.json(
        { error: API_ERROR.API_KEY_SCOPE_INSUFFICIENT },
        { status: 403 },
      );
    }
    return unauthorized();
  }

  const { userId, tenantId, rateLimitKey } = authResult.data;

  // SA tokens have no userId — skip user-specific access restriction and vault query
  if (userId) {
    const denied = await enforceAccessRestriction(req, userId, tenantId);
    if (denied) return denied;
  }

  const rl = await v1ApiKeyLimiter.check(`rl:api_key:${rateLimitKey}`);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  if (!userId) {
    return NextResponse.json({ initialized: false, keyVersion: null });
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
