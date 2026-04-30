import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { withTenantRls } from "@/lib/tenant-rls";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { createNotification } from "@/lib/notification";
import { sendEmail } from "@/lib/email";
import { adminVaultResetEmail } from "@/lib/email/templates/admin-vault-reset";
import { serverAppUrl } from "@/lib/url-helpers";
import { resolveUserLocale } from "@/lib/locale";
import {
  requireTenantPermission,
  isTenantRoleAbove,
} from "@/lib/auth/access/tenant-auth";
import { TENANT_PERMISSION } from "@/lib/constants/auth/tenant-permission";
import { AUDIT_ACTION } from "@/lib/constants";
import { NOTIFICATION_TYPE } from "@/lib/constants/audit/notification";
import {
  notificationTitle,
  notificationBody,
} from "@/lib/notification/notification-messages";
import { withRequestLog } from "@/lib/http/with-request-log";
import {
  forbidden,
  handleAuthError,
  notFound,
  rateLimited,
  unauthorized,
} from "@/lib/http/api-response";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { decryptResetToken } from "@/lib/vault/admin-reset-token-crypto";
import {
  EXECUTE_TTL_MS,
  MS_PER_DAY,
  MS_PER_MINUTE,
  RESET_TOTAL_TTL_MS,
} from "@/lib/constants/time";
import { getLogger } from "@/lib/logger";

export const runtime = "nodejs";

// Per-actor approve rate limiter (15-minute window).
const approveLimiter = createRateLimiter({
  windowMs: 15 * MS_PER_MINUTE,
  max: 10,
});

// Per-target approve rate limiter (24h window) — caps repeated approval
// attempts on the same target user, mirroring the initiate per-target limiter.
const approveTargetLimiter = createRateLimiter({
  windowMs: MS_PER_DAY,
  max: 5,
});

// POST /api/tenant/members/[userId]/reset-vault/[resetId]/approve
// Second-admin approval for a pending vault reset.
// Auth: same hierarchy rules as initiate (MEMBER_VAULT_RESET +
// isTenantRoleAbove). Self-approval blocked at app-level (advisory) AND at
// the DB CAS level (load-bearing — `initiatedById: { not: actor.id }`).
async function handlePOST(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string; resetId: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) return unauthorized();

  const { userId: targetUserId, resetId } = await params;

  let actor;
  try {
    actor = await requireTenantPermission(
      session.user.id,
      TENANT_PERMISSION.MEMBER_VAULT_RESET,
    );
  } catch (err) {
    return handleAuthError(err);
  }

  // Find the reset record; verify scope. Done before role check so the
  // 404/403 boundary is consistent with the revoke endpoint pattern.
  const resetRecord = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.adminVaultReset.findFirst({
      where: { id: resetId, tenantId: actor.tenantId, targetUserId },
    }),
  );
  if (!resetRecord) return notFound();

  // App-level self-approval pre-check (advisory UX). The CAS WHERE clause
  // below is the load-bearing guard against TOCTOU on auth().user.id.
  if (resetRecord.initiatedById === session.user.id) {
    return forbidden();
  }

  // Resolve target member for role hierarchy check + email-snapshot guard +
  // post-approval notification.
  const targetMember = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.tenantMember.findFirst({
      where: {
        tenantId: actor.tenantId,
        userId: targetUserId,
        deactivatedAt: null,
      },
      include: {
        user: { select: { id: true, email: true, name: true, locale: true } },
      },
    }),
  );
  if (!targetMember) return notFound();

  // Role hierarchy: actor must be strictly above target (mirrors initiate).
  if (!isTenantRoleAbove(actor.role, targetMember.role)) return forbidden();

  // Email-snapshot guard (FR12 / S9). If the target's email changed since
  // initiate, refuse approval before AAD-bound decrypt — the AAD would also
  // fail, but a distinct user-facing error here helps admin UX.
  if (
    resetRecord.targetEmailAtInitiate &&
    resetRecord.targetEmailAtInitiate !== targetMember.user.email
  ) {
    await logAuditAsync({
      ...tenantAuditBase(req, session.user.id, actor.tenantId),
      action: AUDIT_ACTION.ADMIN_VAULT_RESET_APPROVE,
      targetType: "User",
      targetId: targetUserId,
      metadata: {
        resetId,
        cause: "RESET_TARGET_EMAIL_CHANGED",
      },
    });
    return NextResponse.json(
      { error: API_ERROR.RESET_TARGET_EMAIL_CHANGED },
      { status: 409 },
    );
  }

  // Rate limits
  const [actorResult, targetResult] = await Promise.all([
    approveLimiter.check(`rl:admin-reset:approve:${session.user.id}`),
    approveTargetLimiter.check(`rl:admin-reset:approve:target:${targetUserId}`),
  ]);
  if (!actorResult.allowed || !targetResult.allowed) {
    const retryAfterMs = !actorResult.allowed
      ? actorResult.retryAfterMs
      : targetResult.retryAfterMs;
    return rateLimited(retryAfterMs);
  }

  // Decrypt FIRST (F7) — a key-rotation gap during the approval window must
  // not leave a phantom approval. On failure, leave the row UNCHANGED and
  // return a generic 409 to the user (S14). The distinct cause is logged
  // operationally only, NOT in audit metadata (S16).
  let plaintextToken: string;
  try {
    if (!resetRecord.encryptedToken) {
      throw new Error("encryptedToken is null on legacy row");
    }
    if (!resetRecord.targetEmailAtInitiate) {
      throw new Error("targetEmailAtInitiate is null on legacy row");
    }
    const decrypted = decryptResetToken(resetRecord.encryptedToken, {
      tenantId: resetRecord.tenantId,
      resetId: resetRecord.id,
      targetEmailAtInitiate: resetRecord.targetEmailAtInitiate,
    });
    if (decrypted == null) {
      throw new Error("decryptResetToken returned null");
    }
    plaintextToken = decrypted;
  } catch (err) {
    getLogger().warn(
      { resetId, err: err instanceof Error ? err.message : String(err) },
      "admin-vault-reset approve: token decrypt failed",
    );
    await logAuditAsync({
      ...tenantAuditBase(req, session.user.id, actor.tenantId),
      action: AUDIT_ACTION.ADMIN_VAULT_RESET_APPROVE,
      targetType: "User",
      targetId: targetUserId,
      metadata: { resetId, cause: "RESET_NOT_APPROVABLE" },
    });
    return NextResponse.json(
      { error: API_ERROR.RESET_NOT_APPROVABLE },
      { status: 409 },
    );
  }

  // CAS update — `initiatedById: { not: actor.id }` is the load-bearing
  // self-approval guard. New `expiresAt` is capped at min(createdAt + 24h,
  // now + EXECUTE_TTL_MS) so the original 24h envelope is preserved (S12)
  // while giving the target a predictable post-approval window.
  const now = new Date();
  const ttlCap = new Date(resetRecord.createdAt.getTime() + RESET_TOTAL_TTL_MS);
  const newExpiresAt = new Date(
    Math.min(ttlCap.getTime(), now.getTime() + EXECUTE_TTL_MS),
  );

  const result = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.adminVaultReset.updateMany({
      where: {
        id: resetId,
        tenantId: actor.tenantId,
        targetUserId,
        approvedAt: null,
        executedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
        initiatedById: { not: session.user.id },
      },
      data: {
        approvedAt: now,
        approvedById: session.user.id,
        expiresAt: newExpiresAt,
      },
    }),
  );

  if (result.count === 0) {
    // Generic 409 — covers race-lost / already-approved / revoked / expired
    // / self-approval. Distinct causes are NOT leaked.
    return NextResponse.json(
      { error: API_ERROR.RESET_NOT_APPROVABLE },
      { status: 409 },
    );
  }

  // Best-effort target notification + email. Errors are logged, not
  // propagated — audit emission must not be blocked by mail-system failures.
  const locale = resolveUserLocale(targetMember.user.locale);
  try {
    createNotification({
      userId: targetUserId,
      tenantId: actor.tenantId,
      type: NOTIFICATION_TYPE.ADMIN_VAULT_RESET,
      title: notificationTitle("ADMIN_VAULT_RESET", locale),
      body: notificationBody("ADMIN_VAULT_RESET", locale),
    });

    if (targetMember.user.email) {
      const resetUrl = `${serverAppUrl(`/${locale}/vault-reset/admin`)}#token=${plaintextToken}`;
      const adminName = session.user.name ?? session.user.email ?? "";
      const { subject, html, text } = adminVaultResetEmail(
        locale,
        adminName,
        resetUrl,
      );
      void sendEmail({ to: targetMember.user.email, subject, html, text });
    }
  } catch (err) {
    getLogger().warn(
      { resetId, err: err instanceof Error ? err.message : String(err) },
      "admin-vault-reset approve: notification dispatch failed",
    );
  }

  await logAuditAsync({
    ...tenantAuditBase(req, session.user.id, actor.tenantId),
    action: AUDIT_ACTION.ADMIN_VAULT_RESET_APPROVE,
    targetType: "User",
    targetId: targetUserId,
    metadata: {
      resetId,
      initiatedById: resetRecord.initiatedById,
      targetUserId,
      newExpiresAt: newExpiresAt.toISOString(),
    },
  });

  return NextResponse.json({ ok: true });
}

export const POST = withRequestLog(handlePOST);
