import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { API_ERROR } from "@/lib/api-error-codes";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
import { logAuditAsync, extractRequestMeta } from "@/lib/audit";
import { verifyPassphraseVerifier } from "@/lib/crypto-server";
import { checkLockout, recordFailure } from "@/lib/account-lockout";
import { withRequestLog } from "@/lib/with-request-log";
import { withUserTenantRls } from "@/lib/tenant-context";
import { z } from "zod";
import { errorResponse, unauthorized, zodValidationError } from "@/lib/api-response";

export const runtime = "nodejs";

const disableSchema = z.object({
  verifierHash: z.string().regex(/^[0-9a-f]{64}$/),
});

/**
 * POST /api/travel-mode/disable
 * Disable Travel Mode. Requires passphrase re-entry (verifierHash).
 * Shares failedUnlockAttempts/accountLockedUntil with vault unlock.
 */
async function handlePOST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  // Lockout check — shared with vault unlock
  const lockoutStatus = await checkLockout(session.user.id);
  if (lockoutStatus.locked) {
    return NextResponse.json(
      { error: API_ERROR.ACCOUNT_LOCKED, lockedUntil: lockoutStatus.lockedUntil },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(API_ERROR.INVALID_JSON, 400);
  }

  const parsed = disableSchema.safeParse(body);
  if (!parsed.success) {
    return zodValidationError(parsed.error);
  }

  const user = await withUserTenantRls(session.user.id, async () =>
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: {
        passphraseVerifierHmac: true,
        travelModeActive: true,
      },
    }),
  );

  if (!user) {
    return errorResponse(API_ERROR.USER_NOT_FOUND, 404);
  }

  if (!user.travelModeActive) {
    return NextResponse.json({ active: false });
  }

  // Verify passphrase
  if (!user.passphraseVerifierHmac) {
    return NextResponse.json(
      { error: API_ERROR.VAULT_NOT_SETUP },
      { status: 400 },
    );
  }

  const valid = verifyPassphraseVerifier(
    parsed.data.verifierHash,
    user.passphraseVerifierHmac,
  );

  if (!valid) {
    await recordFailure(session.user.id, request);

    await logAuditAsync({
      action: AUDIT_ACTION.TRAVEL_MODE_DISABLE_FAILED,
      scope: AUDIT_SCOPE.PERSONAL,
      userId: session.user.id,
      ...extractRequestMeta(request),
    });

    return errorResponse(API_ERROR.INVALID_PASSPHRASE, 401);
  }

  await withUserTenantRls(session.user.id, async () =>
    prisma.user.update({
      where: { id: session.user.id },
      data: {
        travelModeActive: false,
        travelModeActivatedAt: null,
      },
    }),
  );

  await logAuditAsync({
    action: AUDIT_ACTION.TRAVEL_MODE_DISABLE,
    scope: AUDIT_SCOPE.PERSONAL,
    userId: session.user.id,
    ...extractRequestMeta(request),
  });

  return NextResponse.json({ active: false });
}

export const POST = withRequestLog(handlePOST);
