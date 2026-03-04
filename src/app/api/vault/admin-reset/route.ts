import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod/v4";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { API_ERROR } from "@/lib/api-error-codes";
import { assertOrigin } from "@/lib/csrf";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { executeVaultReset } from "@/lib/vault-reset";
import { withBypassRls } from "@/lib/tenant-rls";
import { AUDIT_SCOPE, AUDIT_ACTION } from "@/lib/constants";

export const runtime = "nodejs";

const CONFIRMATION_TOKEN = "DELETE MY VAULT";

const adminResetSchema = z.object({
  token: z.string().min(1),
  confirmation: z.string(),
});

// POST /api/vault/admin-reset
// Execute a vault reset initiated by a team admin.
// The target user must be authenticated and submit the token + confirmation.
export async function POST(req: NextRequest) {
  const originError = assertOrigin(req);
  if (originError) return originError;

  const appUrl = process.env.APP_URL || process.env.AUTH_URL;
  if (!appUrl) {
    return NextResponse.json(
      { error: API_ERROR.INVALID_ORIGIN },
      { status: 500 },
    );
  }

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: API_ERROR.INVALID_BODY }, { status: 400 });
  }

  const parsed = adminResetSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: API_ERROR.INVALID_BODY }, { status: 400 });
  }

  const { token, confirmation } = parsed.data;

  // Confirmation must be exact English string
  if (confirmation !== CONFIRMATION_TOKEN) {
    return NextResponse.json(
      { error: API_ERROR.VAULT_RESET_CONFIRMATION_MISMATCH },
      { status: 400 },
    );
  }

  // Verify token
  const tokenHash = createHash("sha256").update(token).digest("hex");

  const resetRecord = await withBypassRls(prisma, async () =>
    prisma.adminVaultReset.findUnique({
      where: { tokenHash },
    }),
  );

  if (!resetRecord) {
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }

  // Token must belong to the authenticated user
  if (resetRecord.targetUserId !== session.user.id) {
    return NextResponse.json({ error: API_ERROR.FORBIDDEN }, { status: 403 });
  }

  // Token must not be expired
  if (resetRecord.expiresAt < new Date()) {
    return NextResponse.json(
      { error: API_ERROR.VAULT_RESET_TOKEN_EXPIRED },
      { status: 410 },
    );
  }

  // Token must not be already executed or revoked
  if (resetRecord.executedAt || resetRecord.revokedAt) {
    return NextResponse.json(
      { error: API_ERROR.VAULT_RESET_TOKEN_USED },
      { status: 410 },
    );
  }

  // Execute vault reset
  const { deletedEntries, deletedAttachments } =
    await executeVaultReset(session.user.id);

  // Mark token as executed
  await withBypassRls(prisma, async () =>
    prisma.adminVaultReset.update({
      where: { id: resetRecord.id },
      data: { executedAt: new Date() },
    }),
  );

  // Audit log
  logAudit({
    scope: AUDIT_SCOPE.TEAM,
    action: AUDIT_ACTION.ADMIN_VAULT_RESET_EXECUTE,
    userId: session.user.id,
    teamId: resetRecord.teamId,
    targetType: "User",
    targetId: session.user.id,
    metadata: {
      deletedEntries,
      deletedAttachments,
      initiatedById: resetRecord.initiatedById,
    },
    ...extractRequestMeta(req),
  });

  return NextResponse.json({ success: true });
}
