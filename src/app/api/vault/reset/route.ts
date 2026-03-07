import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { auth } from "@/auth";
import { createRateLimiter } from "@/lib/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import { assertOrigin } from "@/lib/csrf";
import { withRequestLog } from "@/lib/with-request-log";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { AUDIT_SCOPE, AUDIT_ACTION } from "@/lib/constants";
import { executeVaultReset } from "@/lib/vault-reset";
import { z } from "zod/v4";

export const runtime = "nodejs";

const CONFIRMATION_TOKEN = "DELETE MY VAULT";

const resetSchema = z.object({
  confirmation: z.string(),
});

const resetLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 3,
});

/**
 * POST /api/vault/reset
 * Last resort: delete all vault data when passphrase and recovery key are both lost.
 */
async function handlePOST(request: NextRequest) {
  const originError = assertOrigin(request);
  if (originError) return originError;

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: API_ERROR.UNAUTHORIZED },
      { status: 401 },
    );
  }

  const rateKey = `rl:vault_reset:${session.user.id}`;
  if (!(await resetLimiter.check(rateKey)).allowed) {
    return NextResponse.json(
      { error: API_ERROR.RATE_LIMIT_EXCEEDED },
      { status: 429 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: API_ERROR.INVALID_JSON },
      { status: 400 },
    );
  }

  const parsed = resetSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: API_ERROR.VALIDATION_ERROR },
      { status: 400 },
    );
  }

  if (parsed.data.confirmation !== CONFIRMATION_TOKEN) {
    return NextResponse.json(
      { error: API_ERROR.VAULT_RESET_CONFIRMATION_MISMATCH },
      { status: 400 },
    );
  }

  const userId = session.user.id;

  const { deletedEntries, deletedAttachments } =
    await executeVaultReset(userId);

  logAudit({
    scope: AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.VAULT_RESET_EXECUTED,
    userId,
    metadata: {
      deletedEntries,
      deletedAttachments,
    },
    ...extractRequestMeta(request),
  });

  return NextResponse.json({ success: true });
}

export const POST = withRequestLog(handlePOST);
