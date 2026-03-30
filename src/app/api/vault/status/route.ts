import { type NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { API_ERROR } from "@/lib/api-error-codes";
import { EXTENSION_TOKEN_SCOPE } from "@/lib/constants";
import { withRequestLog } from "@/lib/with-request-log";
import { withUserTenantRls } from "@/lib/tenant-context";
import { checkAuth } from "@/lib/check-auth";
import { errorResponse } from "@/lib/api-response";

export const runtime = "nodejs";

/**
 * GET /api/vault/status
 * Returns whether the user has set up their vault (passphrase + secret key).
 * Supports both Auth.js session and extension token (Bearer).
 */
async function handleGET(request: NextRequest) {
  const result = await checkAuth(request, { scope: EXTENSION_TOKEN_SCOPE.VAULT_UNLOCK_DATA });
  if (!result.ok) return result.response;
  const authData = result.auth;
  if (authData.type === "service_account") {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  const user = await withUserTenantRls(authData.userId, async () =>
    prisma.user.findUnique({
      where: { id: authData.userId },
      select: {
        vaultSetupAt: true,
        accountSalt: true,
        keyVersion: true,
        kdfType: true,
        kdfIterations: true,
        recoveryKeySetAt: true,
        tenant: { select: { vaultAutoLockMinutes: true } },
      },
    }),
  );

  if (!user) {
    return errorResponse(API_ERROR.USER_NOT_FOUND, 404);
  }

  return NextResponse.json({
    setupRequired: !user.vaultSetupAt,
    accountSalt: user.accountSalt,
    keyVersion: user.keyVersion,
    kdfType: user.kdfType,
    kdfIterations: user.kdfIterations,
    hasRecoveryKey: !!user.recoveryKeySetAt,
    vaultAutoLockMinutes: user.tenant?.vaultAutoLockMinutes ?? null,
  });
}

export const GET = withRequestLog(handleGET);
