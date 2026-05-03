import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod/v4";
import { hexHash } from "@/lib/validations/common";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { getAppOrigin } from "@/lib/url-helpers";
import { logAuditAsync, teamAuditBase, tenantAuditBase } from "@/lib/audit/audit";
import { executeVaultReset } from "@/lib/vault/vault-reset";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { AUDIT_ACTION } from "@/lib/constants";
import { withRequestLog } from "@/lib/http/with-request-log";
import { forbidden, notFound, unauthorized, rateLimited } from "@/lib/http/api-response";
import { parseBody } from "@/lib/http/parse-body";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { MS_PER_MINUTE } from "@/lib/constants/time";
import { invalidateUserSessions } from "@/lib/auth/session/user-session-invalidation";
import { VAULT_CONFIRMATION_PHRASE } from "@/lib/constants/vault";

export const runtime = "nodejs";

const vaultAdminResetLimiter = createRateLimiter({ windowMs: 15 * MS_PER_MINUTE, max: 3 });

const CONFIRMATION_TOKEN = VAULT_CONFIRMATION_PHRASE.DELETE_VAULT;

const adminResetSchema = z.object({
  token: hexHash,
  confirmation: z.string(),
});

// POST /api/vault/admin-reset
// Execute a vault reset initiated by a team admin.
// The target user must be authenticated and submit the token + confirmation.
async function handlePOST(req: NextRequest) {
  // Intentionally stricter than proxy CSRF gate (which skips when unset for dev
  // convenience): admin vault reset must never run without a configured origin.
  const appUrl = getAppOrigin();
  if (!appUrl) {
    return NextResponse.json(
      { error: API_ERROR.INVALID_ORIGIN },
      { status: 500 },
    );
  }

  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const userId = session.user.id;
  const rl = await vaultAdminResetLimiter.check(`rl:vault_admin_reset:${userId}`);
  if (!rl.allowed) return rateLimited(rl.retryAfterMs);

  const result = await parseBody(req, adminResetSchema);
  if (!result.ok) return result.response;
  const { token, confirmation } = result.data;

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
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);

  if (!resetRecord) {
    return notFound();
  }

  // Token must belong to the authenticated user
  if (resetRecord.targetUserId !== session.user.id) {
    return forbidden();
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

  // Dual-approval gate: a row that has not been approved by a second admin
  // is not consumable by the target user (FR1, FR2). Defense-in-depth — the
  // CAS WHERE below also requires `approvedAt: { not: null }`.
  if (resetRecord.approvedAt === null) {
    return NextResponse.json(
      { error: API_ERROR.VAULT_RESET_NOT_APPROVED },
      { status: 409 },
    );
  }

  // TOCTOU prevention: atomically mark the token as executed BEFORE deleting
  // vault data. This ensures a concurrent revoke cannot succeed after data
  // deletion has already started. NULL `encryptedToken` so the at-rest
  // ciphertext cannot be replayed even with elevated DB access.
  const atomicResult = await withBypassRls(prisma, async () =>
    prisma.adminVaultReset.updateMany({
      where: {
        id: resetRecord.id,
        approvedAt: { not: null },
        executedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { executedAt: new Date(), encryptedToken: null },
    }),
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);

  if (atomicResult.count === 0) {
    return NextResponse.json(
      { error: API_ERROR.VAULT_RESET_TOKEN_USED },
      { status: 410 },
    );
  }

  // Token secured — now execute the irreversible vault reset
  const { deletedEntries, deletedAttachments } =
    await executeVaultReset(session.user.id);

  // Invalidate every authentication artifact for the target across ALL
  // tenants (FR7 + F3+S2). The target may hold Session rows in tenants
  // other than the initiating one; those are stale-by-policy after a
  // vault reset and must not survive. session.user.id is the target by
  // construction (the route-level forbidden() guard above ensures
  // resetRecord.targetUserId === session.user.id).
  const invalidationResult = await invalidateUserSessions(session.user.id, {
    allTenants: true,
    reason: "admin_vault_reset",
  });

  // Audit log — use TENANT scope for tenant-level resets (teamId is null).
  // tenantId is preserved on TEAM emit so the JSON log line + downstream
  // consumers see it (helper does not set it for team scope).
  await logAuditAsync({
    ...(resetRecord.teamId
      ? teamAuditBase(req, session.user.id, resetRecord.teamId)
      : tenantAuditBase(req, session.user.id, resetRecord.tenantId)),
    tenantId: resetRecord.tenantId,
    action: AUDIT_ACTION.ADMIN_VAULT_RESET_EXECUTE,
    targetType: "User",
    targetId: session.user.id,
    metadata: {
      deletedEntries,
      deletedAttachments,
      initiatedById: resetRecord.initiatedById,
      approvedById: resetRecord.approvedById,
      invalidatedSessions: invalidationResult.sessions,
      invalidatedExtensionTokens: invalidationResult.extensionTokens,
      invalidatedApiKeys: invalidationResult.apiKeys,
      invalidatedMcpAccessTokens: invalidationResult.mcpAccessTokens,
      invalidatedMcpRefreshTokens: invalidationResult.mcpRefreshTokens,
      invalidatedDelegationSessions: invalidationResult.delegationSessions,
      cacheTombstoneFailures: invalidationResult.cacheTombstoneFailures,
    },
  });

  return NextResponse.json({ success: true });
}

export const POST = withRequestLog(handlePOST);
