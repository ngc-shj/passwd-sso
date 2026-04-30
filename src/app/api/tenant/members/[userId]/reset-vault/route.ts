import { randomBytes, createHash, randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { createNotification } from "@/lib/notification";
import { sendEmail } from "@/lib/email";
import { adminVaultResetPendingEmail } from "@/lib/email/templates/admin-vault-reset-pending";
import { resolveUserLocale } from "@/lib/locale";
import {
  requireTenantPermission,
  isTenantRoleAbove,
} from "@/lib/auth/access/tenant-auth";
import { withTenantRls } from "@/lib/tenant-rls";
import { notificationTitle, notificationBody } from "@/lib/notification/notification-messages";
import { TENANT_PERMISSION } from "@/lib/constants/auth/tenant-permission";
import { AUDIT_ACTION } from "@/lib/constants";
import { NOTIFICATION_TYPE } from "@/lib/constants/audit/notification";
import { withRequestLog } from "@/lib/http/with-request-log";
import { forbidden, handleAuthError, notFound, rateLimited, unauthorized } from "@/lib/http/api-response";
import { MAX_PENDING_RESETS, VAULT_RESET_HISTORY_LIMIT } from "@/lib/validations/common.server";
import { MS_PER_DAY } from "@/lib/constants/time";
import { encryptResetToken } from "@/lib/vault/admin-reset-token-crypto";
import { deriveResetStatus } from "@/lib/vault/admin-reset-status";
import {
  APPROVE_ELIGIBILITY,
  computeApproveEligibility,
  type ApproveEligibility,
} from "@/lib/vault/admin-reset-eligibility";

export const runtime = "nodejs";

const RESET_TOKEN_TTL_MS = MS_PER_DAY;

const adminResetLimiter = createRateLimiter({
  windowMs: MS_PER_DAY,
  max: 3,
});

const targetResetLimiter = createRateLimiter({
  windowMs: MS_PER_DAY,
  max: 1,
});

// POST /api/tenant/members/[userId]/reset-vault
// Initiate a vault reset for a tenant member. Tenant OWNER/ADMIN only.
// The reset is created in PENDING_APPROVAL state — a second admin (different
// from the initiator) must approve via the /approve endpoint before the
// target user can execute it. The target user is NOT notified at initiate
// (FR8) — notification + email arrive only after approval lands.
async function handlePOST(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { userId: targetUserId } = await params;

  // Authorization: require MEMBER_VAULT_RESET permission
  let actor;
  try {
    actor = await requireTenantPermission(
      session.user.id,
      TENANT_PERMISSION.MEMBER_VAULT_RESET,
    );
  } catch (err) {
    return handleAuthError(err);
  }

  // Cannot reset own vault
  if (targetUserId === session.user.id) {
    return forbidden();
  }

  // Find the target member in same tenant
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

  if (!targetMember) {
    return notFound();
  }

  // Role hierarchy check: actor must be strictly above target
  if (!isTenantRoleAbove(actor.role, targetMember.role)) {
    return forbidden();
  }

  // Capture target email at initiate (FR12) — bound into the encrypted token's
  // AAD so a later email-change race during the approval window is detected
  // at decrypt time. User.email is required at signup; defensive guard.
  const targetEmailAtInitiate = targetMember.user.email;
  if (!targetEmailAtInitiate) {
    return notFound();
  }

  // Rate limits
  const [adminResult, targetResult] = await Promise.all([
    adminResetLimiter.check(`rl:admin-reset:admin:${session.user.id}`),
    targetResetLimiter.check(`rl:admin-reset:target:${targetUserId}`),
  ]);

  if (!adminResult.allowed || !targetResult.allowed) {
    const retryAfterMs = !adminResult.allowed ? adminResult.retryAfterMs : targetResult.retryAfterMs;
    return rateLimited(retryAfterMs);
  }

  // Check pending resets limit
  const pendingCount = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.adminVaultReset.count({
      where: {
        targetUserId,
        executedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    }),
  );

  if (pendingCount >= MAX_PENDING_RESETS) {
    return rateLimited();
  }

  // Pre-allocate the reset id so it can be bound into the encrypted token's
  // AAD before insert.
  const id = randomUUID();
  const token = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

  const encryptedToken = encryptResetToken(token, {
    tenantId: actor.tenantId,
    resetId: id,
    targetEmailAtInitiate,
  });

  const resetRecord = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.adminVaultReset.create({
      data: {
        id,
        tenantId: actor.tenantId,
        teamId: null,
        targetUserId,
        initiatedById: session.user.id,
        tokenHash,
        encryptedToken,
        targetEmailAtInitiate,
        expiresAt,
      },
    }),
  );

  // Audit log — keep `expiresAt` so the audit row is self-contained for
  // compliance queries (F23). State (`pending_approval`) is implicit in
  // `approvedAt = null` so no redundant flag here.
  await logAuditAsync({
    ...tenantAuditBase(req, session.user.id, actor.tenantId),
    action: AUDIT_ACTION.ADMIN_VAULT_RESET_INITIATE,
    targetType: "User",
    targetId: targetUserId,
    metadata: { resetId: resetRecord.id, expiresAt: expiresAt.toISOString() },
  });

  // Notify OTHER eligible admins (FR8 + S6).
  // Recipient set: same-tenant admins who could approve — i.e., a different
  // user, currently active, with role strictly above the target's role.
  const otherAdmins = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.tenantMember.findMany({
      where: {
        tenantId: actor.tenantId,
        userId: { not: session.user.id },
        role: { in: ["OWNER", "ADMIN"] },
        deactivatedAt: null,
      },
      include: {
        user: { select: { id: true, email: true, name: true, locale: true } },
      },
    }),
  );

  const eligibleApprovers = otherAdmins.filter((m) =>
    isTenantRoleAbove(m.role, targetMember.role),
  );

  const initiatorName = session.user.name ?? session.user.email ?? "";
  for (const approver of eligibleApprovers) {
    const locale = resolveUserLocale(approver.user.locale);
    createNotification({
      userId: approver.userId,
      tenantId: actor.tenantId,
      type: NOTIFICATION_TYPE.ADMIN_VAULT_RESET_PENDING_APPROVAL,
      title: notificationTitle("ADMIN_VAULT_RESET_PENDING_APPROVAL", locale),
      body: notificationBody(
        "ADMIN_VAULT_RESET_PENDING_APPROVAL",
        locale,
        targetEmailAtInitiate,
      ),
    });

    if (approver.user.email) {
      const { subject, html, text } = adminVaultResetPendingEmail(
        locale,
        initiatorName,
        targetEmailAtInitiate,
      );
      void sendEmail({ to: approver.user.email, subject, html, text });
    }
  }

  return NextResponse.json({ ok: true });
}

// GET /api/tenant/members/[userId]/reset-vault
// Get reset history for a specific member. Tenant OWNER/ADMIN only.
async function handleGET(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  void req;

  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { userId: targetUserId } = await params;

  let actor;
  try {
    actor = await requireTenantPermission(
      session.user.id,
      TENANT_PERMISSION.MEMBER_VAULT_RESET,
    );
  } catch (err) {
    return handleAuthError(err);
  }

  // Fetch the target's role alongside the reset rows so we can pre-compute
  // approveEligibility per row server-side. Single query — target.role is
  // constant across all rows under this targetUserId path param.
  const [resets, targetMember] = await Promise.all([
    withTenantRls(prisma, actor.tenantId, async () =>
      prisma.adminVaultReset.findMany({
        where: {
          targetUserId,
          tenantId: actor.tenantId,
        },
        include: {
          initiatedBy: { select: { id: true, name: true, email: true } },
          approvedBy: { select: { id: true, name: true, email: true } },
        },
        orderBy: { createdAt: "desc" },
        take: VAULT_RESET_HISTORY_LIMIT,
      }),
    ),
    withTenantRls(prisma, actor.tenantId, async () =>
      prisma.tenantMember.findFirst({
        where: {
          tenantId: actor.tenantId,
          userId: targetUserId,
          deactivatedAt: null,
        },
        select: { role: true },
      }),
    ),
  ]);

  const now = new Date();
  const result = resets.map((r) => {
    // Pre-compute eligibility so the dialog renders the Approve button
    // (or its disabled-with-tooltip variant) without re-implementing the
    // role-hierarchy logic on the client. If the target member is no
    // longer in the tenant (deactivated), eligibility is "insufficient_role"
    // — the UI hides the button rather than letting the user attempt an
    // action that the server would reject.
    const approveEligibility: ApproveEligibility = targetMember
      ? computeApproveEligibility({
          actorId: session.user.id,
          actorRole: actor.role,
          targetRole: targetMember.role,
          initiatedById: r.initiatedById,
        })
      : APPROVE_ELIGIBILITY.INSUFFICIENT_ROLE;

    return {
      id: r.id,
      status: deriveResetStatus(r, now),
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      approvedAt: r.approvedAt,
      executedAt: r.executedAt,
      revokedAt: r.revokedAt,
      initiatedBy: {
        id: r.initiatedBy.id,
        name: r.initiatedBy.name,
        email: r.initiatedBy.email,
      },
      approvedBy: r.approvedBy
        ? { id: r.approvedBy.id, name: r.approvedBy.name, email: r.approvedBy.email }
        : null,
      // Backfilled rows (very old data) may have null targetEmailAtInitiate;
      // empty string is the safe display value.
      targetEmailAtInitiate: r.targetEmailAtInitiate ?? "",
      approveEligibility,
    };
  });

  return NextResponse.json(result);
}

export const POST = withRequestLog(handlePOST);
export const GET = withRequestLog(handleGET);
