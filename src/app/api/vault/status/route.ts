import { type NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { EXTENSION_TOKEN_SCOPE } from "@/lib/constants";
import { withRequestLog } from "@/lib/http/with-request-log";
import { withUserTenantRls } from "@/lib/tenant-context";
import { checkAuth } from "@/lib/auth/check-auth";
import { errorResponse } from "@/lib/http/api-response";

export const runtime = "nodejs";

/**
 * GET /api/vault/status
 * Returns whether the user has set up their vault (passphrase + secret key).
 * Supports both Auth.js session and extension token (Bearer).
 */
async function handleGET(request: NextRequest) {
  const result = await checkAuth(request, { scope: EXTENSION_TOKEN_SCOPE.VAULT_UNLOCK_DATA });
  if (!result.ok) return result.response;
  const { userId } = result.auth;

  const user = await withUserTenantRls(userId, async () =>
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        vaultSetupAt: true,
        accountSalt: true,
        keyVersion: true,
        kdfType: true,
        kdfIterations: true,
        recoveryKeySetAt: true,
        tenant: {
          select: {
            vaultAutoLockMinutes: true,
            tenantMinPasswordLength: true,
            tenantRequireUppercase: true,
            tenantRequireLowercase: true,
            tenantRequireNumbers: true,
            tenantRequireSymbols: true,
            passwordMaxAgeDays: true,
            passwordExpiryWarningDays: true,
          },
        },
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
    tenantMinPasswordLength: user.tenant?.tenantMinPasswordLength ?? 0,
    tenantRequireUppercase: user.tenant?.tenantRequireUppercase ?? false,
    tenantRequireLowercase: user.tenant?.tenantRequireLowercase ?? false,
    tenantRequireNumbers: user.tenant?.tenantRequireNumbers ?? false,
    tenantRequireSymbols: user.tenant?.tenantRequireSymbols ?? false,
    passwordMaxAgeDays: user.tenant?.passwordMaxAgeDays ?? null,
    passwordExpiryWarningDays: user.tenant?.passwordExpiryWarningDays ?? 14,
  });
}

export const GET = withRequestLog(handleGET);
