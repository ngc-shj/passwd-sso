/**
 * POST /api/admin/rotate-master-key/[rotationId]/execute
 *
 * A04-4: master-key rotation dual-approval — phase 3 (execute).
 *
 * Re-validates targetVersion (env may have changed since initiate), then
 * performs the destructive PasswordShare revocation across ALL tenants via
 * withBypassRls(SYSTEM_MAINTENANCE). The rotation row's CAS update happens
 * in withTenantRls (tenant-bound governance); the shares revocation is
 * system-wide because the master key is system-wide (NF4).
 */
import { NextRequest, NextResponse } from "next/server";
import { verifyAdminToken } from "@/lib/auth/tokens/admin-token";
import { prisma } from "@/lib/prisma";
import {
  getCurrentMasterKeyVersion,
  getMasterKeyByVersion,
} from "@/lib/crypto/crypto-server";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION, ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { withBypassRls, withTenantRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { requireMaintenanceOperator } from "@/lib/auth/access/maintenance-auth";
import { withRequestLog } from "@/lib/http/with-request-log";
import {
  errorResponse,
  errorResponseWithMessage,
  notFound,
  unauthorized,
} from "@/lib/http/api-response";
import { API_ERROR } from "@/lib/http/api-error-codes";
import {
  EXECUTE_ELIGIBILITY,
  computeExecuteEligibility,
} from "@/lib/admin-rotation/rotation-eligibility";
import { getLogger } from "@/lib/logger";
import { RATE_WINDOW_MS } from "@/lib/validations/common.server";

const rateLimiter = createRateLimiter({
  windowMs: RATE_WINDOW_MS,
  max: 1,
  failClosedOnRedisError: true,
});

async function handlePOST(
  req: NextRequest,
  { params }: { params: Promise<{ rotationId: string }> },
) {
  const authResult = await verifyAdminToken(req);
  if (!authResult.ok) return unauthorized();
  const { auth } = authResult;

  const { rotationId } = await params;

  const rlBlocked = await checkRateLimitOrFail({
    req,
    limiter: rateLimiter,
    key: `rl:admin:rotate:execute:${auth.subjectUserId}`,
    scope: "admin.rotate.execute",
    userId: auth.subjectUserId,
    tenantId: auth.tenantId,
  });
  if (rlBlocked) return rlBlocked;

  const op = await requireMaintenanceOperator(auth.subjectUserId, {
    tenantId: auth.tenantId,
  });
  if (!op.ok) return op.response;

  const row = await withTenantRls(prisma, auth.tenantId, async (tx) =>
    tx.masterKeyRotation.findFirst({ where: { id: rotationId } }),
  );
  if (!row) return notFound();

  const now = new Date();
  const eligibility = computeExecuteEligibility({
    actorTenantId: auth.tenantId,
    rotationTenantId: row.tenantId,
    approvedAt: row.approvedAt,
    executedAt: row.executedAt,
    revokedAt: row.revokedAt,
    expiresAt: row.expiresAt,
    now,
  });

  if (eligibility === EXECUTE_ELIGIBILITY.CROSS_TENANT) {
    await logAuditAsync({
      ...tenantAuditBase(req, auth.subjectUserId, auth.tenantId),
      actorType: ACTOR_TYPE.HUMAN,
      action: AUDIT_ACTION.MASTER_KEY_ROTATION_EXECUTE,
      metadata: {
        rotationId,
        targetVersion: row.targetVersion,
        cause: API_ERROR.FORBIDDEN_CROSS_TENANT,
      },
    });
    return errorResponse(API_ERROR.FORBIDDEN_CROSS_TENANT);
  }

  if (
    eligibility === EXECUTE_ELIGIBILITY.NOT_APPROVED ||
    eligibility === EXECUTE_ELIGIBILITY.ALREADY_TERMINAL
  ) {
    return errorResponse(API_ERROR.ROTATION_NOT_EXECUTABLE);
  }

  // Re-validate targetVersion at execute time (C4.AC6). Env config may have
  // changed since initiate; refuse to revoke shares against a stale or
  // unknown version.
  const currentVersion = getCurrentMasterKeyVersion();
  if (row.targetVersion !== currentVersion) {
    return errorResponseWithMessage(
      API_ERROR.ROTATION_TARGET_VERSION_MISMATCH,
      `targetVersion (${row.targetVersion}) does not match SHARE_MASTER_KEY_CURRENT_VERSION (${currentVersion})`,
    );
  }
  try {
    getMasterKeyByVersion(row.targetVersion);
  } catch {
    return errorResponseWithMessage(
      API_ERROR.ROTATION_TARGET_VERSION_MISMATCH,
      `SHARE_MASTER_KEY_V${row.targetVersion} is not configured`,
    );
  }

  // CAS update — load-bearing state-machine + cross-tenant guards. Race
  // losses are silent per AdminVaultReset precedent (race vs terminal vs
  // expired all collapse into a generic 409).
  const casResult = await withTenantRls(prisma, auth.tenantId, async (tx) =>
    tx.masterKeyRotation.updateMany({
      where: {
        id: rotationId,
        tenantId: auth.tenantId,
        approvedAt: { not: null },
        executedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: { executedAt: now, executedById: auth.subjectUserId },
    }),
  );

  if (casResult.count === 0) {
    getLogger().warn(
      {
        rotationId,
        actorSubjectId: auth.subjectUserId,
        actorTenantId: auth.tenantId,
        subCause: "race_or_terminal",
      },
      "master-key-rotation execute: CAS lost",
    );
    return errorResponse(API_ERROR.ROTATION_NOT_EXECUTABLE);
  }

  // Destructive write — system-wide PasswordShare revocation. Master key is
  // global, so old-version shares across ALL tenants are revoked regardless
  // of which tenant approved the rotation (NF4).
  //
  // S2: the CAS above has already committed `executedAt = now`. If the
  // share-revocation throws, we MUST still emit MASTER_KEY_ROTATION_EXECUTE —
  // otherwise the row is `executed` with no audit-chain record of the actor
  // or outcome (forensic gap on the most destructive action's error path).
  let revokedShares = 0;
  let shareRevocationError: string | null = null;
  if (row.revokeShares) {
    try {
      const shareResult = await withBypassRls(
        prisma,
        async (tx) =>
          tx.passwordShare.updateMany({
            where: {
              masterKeyVersion: { lt: row.targetVersion },
              revokedAt: null,
              expiresAt: { gt: new Date() },
            },
            data: { revokedAt: new Date() },
          }),
        BYPASS_PURPOSE.SYSTEM_MAINTENANCE,
      );
      revokedShares = shareResult.count;
    } catch (err) {
      shareRevocationError = err instanceof Error ? err.message : String(err);
      getLogger().error(
        {
          rotationId,
          err: shareRevocationError,
        },
        "master-key-rotation execute: passwordShare.updateMany failed; rotation row remains executed but share-state is partial",
      );
    }
  }

  // Record revokedShares on the rotation row. If this fails, the audit event
  // still captures the count — the row's revokedShares column is informational.
  try {
    await withTenantRls(prisma, auth.tenantId, async (tx) =>
      tx.masterKeyRotation.update({
        where: { id: rotationId },
        data: { revokedShares },
      }),
    );
  } catch (err) {
    getLogger().error(
      {
        rotationId,
        revokedShares,
        err: err instanceof Error ? err.message : String(err),
      },
      "master-key-rotation execute: failed to record revokedShares on row (count preserved in audit)",
    );
  }

  await logAuditAsync({
    ...tenantAuditBase(req, auth.subjectUserId, auth.tenantId),
    actorType: ACTOR_TYPE.HUMAN,
    action: AUDIT_ACTION.MASTER_KEY_ROTATION_EXECUTE,
    metadata: {
      rotationId,
      targetVersion: row.targetVersion,
      revokedShares,
      shareRevocationSkipped: !row.revokeShares,
      // Operational tag for post-incident review — non-null means the row was
      // marked executed but PasswordShare write partially failed.
      shareRevocationError,
    },
  });

  // S2: if the destructive write threw, surface INTERNAL_ERROR so the client
  // knows the operation was partial — even though the audit + row state both
  // record the attempt. Operators consult `shareRevocationError` in the audit
  // metadata + ops logs to triage. Uses the standard errorResponseWithMessage
  // helper per the api-error-body-drift check.
  if (shareRevocationError) {
    return errorResponseWithMessage(
      API_ERROR.INTERNAL_ERROR,
      "PasswordShare revocation partially failed; rotation row remains executed. See audit row + ops logs.",
    );
  }

  return NextResponse.json({
    ok: true,
    status: "executed" as const,
    revokedShares,
  });
}

export const POST = withRequestLog(handlePOST);
