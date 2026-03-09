import { type NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { API_ERROR } from "@/lib/api-error-codes";
import { EXTENSION_TOKEN_SCOPE } from "@/lib/constants";
import { withRequestLog } from "@/lib/with-request-log";
import { withUserTenantRls } from "@/lib/tenant-context";
import { authOrToken } from "@/lib/auth-or-token";
import { enforceAccessRestriction } from "@/lib/access-restriction";

export const runtime = "nodejs";

/**
 * GET /api/vault/status
 * Returns whether the user has set up their vault (passphrase + secret key).
 * Supports both Auth.js session and extension token (Bearer).
 */
async function handleGET(request: NextRequest) {
  const result = await authOrToken(request, EXTENSION_TOKEN_SCOPE.VAULT_UNLOCK_DATA);
  if (!result) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }
  if (result.type === "scope_insufficient") {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 403 });
  }

  if (result.type !== "session") {
    const denied = await enforceAccessRestriction(request, result.userId, result.type === "api_key" ? result.tenantId : undefined);
    if (denied) return denied;
  }

  const user = await withUserTenantRls(result.userId, async () =>
    prisma.user.findUnique({
      where: { id: result.userId },
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
    return NextResponse.json({ error: API_ERROR.USER_NOT_FOUND }, { status: 404 });
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
