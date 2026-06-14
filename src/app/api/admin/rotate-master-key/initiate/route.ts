/**
 * POST /api/admin/rotate-master-key/initiate
 *
 * A04-4: master-key rotation dual-approval — phase 1 (initiate).
 *
 * Creates a pending MasterKeyRotation row scoped to the operator's tenant.
 * No share revocation here — the legacy single-actor path is replaced by a
 * 4-phase state machine (initiate → approve → execute, with revoke at any
 * pre-execute step).
 *
 * Body: { targetVersion: number, revokeShares?: boolean, reason?: string }
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyAdminToken } from "@/lib/auth/tokens/admin-token";
import { prisma } from "@/lib/prisma";
import { parseBody } from "@/lib/http/parse-body";
import {
  getCurrentMasterKeyVersion,
  getMasterKeyByVersion,
} from "@/lib/crypto/crypto-server";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION, ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { withTenantRls } from "@/lib/tenant-rls";
import { requireMaintenanceOperator } from "@/lib/auth/access/maintenance-auth";
import { withRequestLog } from "@/lib/http/with-request-log";
import {
  errorResponseWithMessage,
  unauthorized,
} from "@/lib/http/api-response";
import { API_ERROR } from "@/lib/http/api-error-codes";
import {
  MASTER_KEY_VERSION_MIN,
  MASTER_KEY_VERSION_MAX,
  RATE_WINDOW_MS,
} from "@/lib/validations/common.server";
import { ROTATION_TOTAL_TTL_MS } from "@/lib/constants/time";
import { createNotification } from "@/lib/notification";
import {
  notificationTitle,
  notificationBody,
} from "@/lib/notification/notification-messages";
import { resolveUserLocale } from "@/lib/locale";
import { getLogger } from "@/lib/logger";

const rateLimiter = createRateLimiter({
  windowMs: RATE_WINDOW_MS,
  max: 1,
  failClosedOnRedisError: true,
});

const bodySchema = z
  .object({
    targetVersion: z
      .number()
      .int()
      .min(MASTER_KEY_VERSION_MIN)
      .max(MASTER_KEY_VERSION_MAX),
    revokeShares: z.boolean().default(true),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

// FR10: notify every OTHER active OWNER/ADMIN of the initiator's tenant.
// Empty recipient list (single-operator tenant) is acceptable — the rotation
// row will sit until expiresAt and be inert (no one can approve).
async function notifyOtherAdmins(
  tenantId: string,
  initiatorUserId: string,
): Promise<void> {
  let recipients: { userId: string; locale: string | null }[] = [];
  try {
    recipients = await withTenantRls(prisma, tenantId, async (tx) => {
      const rows = await tx.tenantMember.findMany({
        where: {
          tenantId,
          role: { in: ["OWNER", "ADMIN"] },
          deactivatedAt: null,
          userId: { not: initiatorUserId },
        },
        select: { userId: true, user: { select: { locale: true } } },
      });
      return rows.map((r) => ({ userId: r.userId, locale: r.user.locale }));
    });
  } catch (err) {
    getLogger().warn(
      { tenantId, err: err instanceof Error ? err.message : String(err) },
      "master-key-rotation initiate: recipient enumeration failed",
    );
    return;
  }

  if (recipients.length === 0) {
    getLogger().warn(
      { tenantId, initiatorUserId },
      "master-key-rotation initiate: no recipients (single-operator tenant); rotation cannot be approved",
    );
    return;
  }

  for (const recipient of recipients) {
    const locale = resolveUserLocale(recipient.locale);
    createNotification({
      userId: recipient.userId,
      tenantId,
      type: "MASTER_KEY_ROTATION_PENDING_APPROVAL",
      title: notificationTitle("MASTER_KEY_ROTATION_PENDING_APPROVAL", locale),
      body: notificationBody("MASTER_KEY_ROTATION_PENDING_APPROVAL", locale),
    });
  }
}

async function handlePOST(req: NextRequest) {
  const authResult = await verifyAdminToken(req);
  if (!authResult.ok) {
    return unauthorized();
  }
  const { auth } = authResult;

  const rlBlocked = await checkRateLimitOrFail({
    req,
    limiter: rateLimiter,
    key: `rl:admin:rotate:initiate:${auth.subjectUserId}`,
    scope: "admin.rotate.initiate",
    userId: auth.subjectUserId,
    tenantId: auth.tenantId,
  });
  if (rlBlocked) return rlBlocked;

  const result = await parseBody(req, bodySchema);
  if (!result.ok) return result.response;
  const { targetVersion, revokeShares, reason } = result.data;

  // Initiate-time validation (FR1 + C4.AC5): targetVersion must match the
  // currently-configured version. Execute re-validates (FR4 + C4.AC6).
  const currentVersion = getCurrentMasterKeyVersion();
  if (targetVersion !== currentVersion) {
    return errorResponseWithMessage(
      API_ERROR.ROTATION_TARGET_VERSION_MISMATCH,
      `targetVersion (${targetVersion}) does not match SHARE_MASTER_KEY_CURRENT_VERSION (${currentVersion})`,
    );
  }
  try {
    getMasterKeyByVersion(targetVersion);
  } catch {
    return errorResponseWithMessage(
      API_ERROR.ROTATION_TARGET_VERSION_MISMATCH,
      `SHARE_MASTER_KEY_V${targetVersion} is not configured`,
    );
  }

  // Re-confirm operator is OWNER/ADMIN of the bound tenant.
  const op = await requireMaintenanceOperator(auth.subjectUserId, {
    tenantId: auth.tenantId,
  });
  if (!op.ok) return op.response;

  const now = new Date();
  const expiresAt = new Date(now.getTime() + ROTATION_TOTAL_TTL_MS);

  const created = await withTenantRls(prisma, auth.tenantId, async (tx) =>
    tx.masterKeyRotation.create({
      data: {
        tenantId: auth.tenantId,
        initiatedById: auth.subjectUserId,
        targetVersion,
        revokeShares,
        expiresAt,
        reason: reason ?? null,
      },
      select: { id: true, expiresAt: true, targetVersion: true },
    }),
  );

  // FR10: notify other OWNER/ADMINs out-of-band; best-effort.
  await notifyOtherAdmins(auth.tenantId, auth.subjectUserId);

  await logAuditAsync({
    ...tenantAuditBase(req, auth.subjectUserId, auth.tenantId),
    actorType: ACTOR_TYPE.HUMAN,
    action: AUDIT_ACTION.MASTER_KEY_ROTATION_INITIATE,
    metadata: {
      rotationId: created.id,
      targetVersion: created.targetVersion,
      revokeShares,
      // Flag explicit opt-outs so post-incident review can detect a rotation
      // that left old-version shares decryptable by the (potentially leaked)
      // previous key.
      shareRevocationSkipped: !revokeShares,
    },
  });

  return NextResponse.json(
    {
      rotationId: created.id,
      targetVersion: created.targetVersion,
      expiresAt: created.expiresAt.toISOString(),
      status: "pending" as const,
    },
    { status: 201 },
  );
}

export const POST = withRequestLog(handlePOST);
