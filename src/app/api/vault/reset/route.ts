import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { auth } from "@/auth";
import { createRateLimiter } from "@/lib/rate-limit";
import { API_ERROR } from "@/lib/api-error-codes";
import { assertOrigin } from "@/lib/csrf";
import { withRequestLog } from "@/lib/with-request-log";
import { rateLimited } from "@/lib/api-response";
import { logAuditAsync, extractRequestMeta } from "@/lib/audit";
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
  const rl = await resetLimiter.check(rateKey);
  if (!rl.allowed) {
    return rateLimited(rl.retryAfterMs);
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

  const { ip, userAgent } = extractRequestMeta(request);
  await logAuditAsync({
    scope: "PERSONAL",
    action: "VAULT_RESET_EXECUTED",
    userId,
    metadata: {
      deletedEntries,
      deletedAttachments,
    },
    ip,
    userAgent,
  });

  return NextResponse.json({ success: true });
}

export const POST = withRequestLog(handlePOST);
