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
import { AUDIT_SCOPE, AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";

export const runtime = "nodejs";

const CONFIRMATION_TOKEN = "DELETE MY VAULT";

const adminResetSchema = z.object({
  token: z.string().length(64).regex(/^[0-9a-f]{64}$/),
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

  // TOCTOU prevention: atomically mark the token as executed BEFORE deleting
  // vault data. This ensures a concurrent revoke cannot succeed after data
  // deletion has already started.
  const atomicResult = await withBypassRls(prisma, async () =>
    prisma.adminVaultReset.updateMany({
      where: {
        id: resetRecord.id,
        executedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { executedAt: new Date() },
    }),
  );

  if (atomicResult.count === 0) {
    return NextResponse.json(
      { error: API_ERROR.VAULT_RESET_TOKEN_USED },
      { status: 410 },
    );
  }

  // Token secured — now execute the irreversible vault reset
  const { deletedEntries, deletedAttachments } =
    await executeVaultReset(session.user.id);

  // Audit log — use TENANT scope for tenant-level resets (teamId is null)
  const auditScope = resetRecord.teamId ? AUDIT_SCOPE.TEAM : AUDIT_SCOPE.TENANT;
  logAudit({
    scope: auditScope,
    action: AUDIT_ACTION.ADMIN_VAULT_RESET_EXECUTE,
    userId: session.user.id,
    tenantId: resetRecord.tenantId,
    teamId: resetRecord.teamId ?? undefined,
    targetType: AUDIT_TARGET_TYPE.USER,
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
