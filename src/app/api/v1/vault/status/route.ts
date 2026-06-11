import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { validateV1Auth } from "@/lib/auth/session/v1-auth";
import { withRequestLog } from "@/lib/http/with-request-log";
import { withTenantRls } from "@/lib/tenant-rls";
import { v1ApiKeyLimiter } from "@/lib/security/rate-limiters";
import { API_KEY_SCOPE } from "@/lib/constants/auth/api-key";
import { enforceAccessRestriction } from "@/lib/auth/policy/access-restriction";
import { errorResponse, rateLimited, unauthorized } from "@/lib/http/api-response";
import { SYSTEM_ACTOR_ID } from "@/lib/constants/app";
import { ACTOR_TYPE } from "@/lib/constants/audit/audit";


// GET /api/v1/vault/status — Check vault initialization status (API key or SA token)
async function handleGET(req: NextRequest) {
  const authResult = await validateV1Auth(req, API_KEY_SCOPE.VAULT_STATUS);
  if (!authResult.ok) {
    if (authResult.error === "SCOPE_INSUFFICIENT") {
      return errorResponse(API_ERROR.API_KEY_SCOPE_INSUFFICIENT);
    }
    return unauthorized();
  }

  const { userId, tenantId, rateLimitKey } = authResult.data;

  // Enforce tenant network-boundary policy for all token types.
  // SA tokens carry no userId; pass SYSTEM_ACTOR_ID with SERVICE_ACCOUNT actor
  // type so the denial audit records the correct actor class (mirrors the
  // pattern in src/app/api/tenant/access-requests/route.ts:150-156).
  if (userId) {
    const denied = await enforceAccessRestriction(req, userId, tenantId);
    if (denied) return denied;
  } else {
    const denied = await enforceAccessRestriction(req, SYSTEM_ACTOR_ID, tenantId, ACTOR_TYPE.SERVICE_ACCOUNT);
    if (denied) return denied;
  }

  const rl = await v1ApiKeyLimiter.check(`rl:api_key:${rateLimitKey}`);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
  }

  if (!userId) {
    return NextResponse.json({ initialized: false, keyVersion: null });
  }

  const user = await withTenantRls(prisma, tenantId, async (tx) =>
    tx.user.findUnique({
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
