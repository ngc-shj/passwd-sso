import { randomBytes, createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { API_ERROR } from "@/lib/api-error-codes";
import { assertOrigin } from "@/lib/csrf";
import { createRateLimiter } from "@/lib/rate-limit";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { createNotification } from "@/lib/notification";
import { sendEmail } from "@/lib/email";
import { adminVaultResetEmail } from "@/lib/email/templates/admin-vault-reset";
import { serverAppUrl } from "@/lib/url-helpers";
import { resolveUserLocale } from "@/lib/locale";
import {
  requireTenantPermission,
  isTenantRoleAbove,
  TenantAuthError,
} from "@/lib/tenant-auth";
import { withTenantRls } from "@/lib/tenant-rls";
import { notificationTitle, notificationBody } from "@/lib/notification-messages";
import { TENANT_PERMISSION } from "@/lib/constants/tenant-permission";
import { AUDIT_SCOPE, AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { NOTIFICATION_TYPE } from "@/lib/constants/notification";

export const runtime = "nodejs";

const RESET_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_PENDING_RESETS = 3;

const adminResetLimiter = createRateLimiter({
  windowMs: 24 * 60 * 60 * 1000,
  max: 3,
});

const targetResetLimiter = createRateLimiter({
  windowMs: 24 * 60 * 60 * 1000,
  max: 1,
});

// POST /api/tenant/members/[userId]/reset-vault
// Initiate a vault reset for a tenant member. Tenant OWNER/ADMIN only.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const originError = assertOrigin(req);
  if (originError) return originError;

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
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
    if (err instanceof TenantAuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  // Cannot reset own vault
  if (targetUserId === session.user.id) {
    return NextResponse.json({ error: API_ERROR.FORBIDDEN }, { status: 403 });
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
    return NextResponse.json({ error: API_ERROR.NOT_FOUND }, { status: 404 });
  }

  // Role hierarchy check: actor must be strictly above target
  if (!isTenantRoleAbove(actor.role, targetMember.role)) {
    return NextResponse.json({ error: API_ERROR.FORBIDDEN }, { status: 403 });
  }

  // Rate limits
  const [adminResult, targetResult] = await Promise.all([
    adminResetLimiter.check(`rl:admin-reset:admin:${session.user.id}`),
    targetResetLimiter.check(`rl:admin-reset:target:${targetUserId}`),
  ]);

  if (!adminResult.allowed || !targetResult.allowed) {
    return NextResponse.json(
      { error: API_ERROR.RATE_LIMIT_EXCEEDED },
      { status: 429 },
    );
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
    return NextResponse.json(
      { error: API_ERROR.RATE_LIMIT_EXCEEDED },
      { status: 429 },
    );
  }

  // Generate token
  const token = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

  // Create the reset record (teamId: null for tenant-level resets)
  await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.adminVaultReset.create({
      data: {
        tenantId: actor.tenantId,
        teamId: null,
        targetUserId,
        initiatedById: session.user.id,
        tokenHash,
        expiresAt,
      },
    }),
  );

  // Audit log
  logAudit({
    scope: AUDIT_SCOPE.TENANT,
    action: AUDIT_ACTION.ADMIN_VAULT_RESET_INITIATE,
    userId: session.user.id,
    tenantId: actor.tenantId,
    targetType: AUDIT_TARGET_TYPE.USER,
    targetId: targetUserId,
    ...extractRequestMeta(req),
  });

  // In-app notification to target user
  const locale = resolveUserLocale(targetMember.user.locale);
  createNotification({
    userId: targetUserId,
    tenantId: actor.tenantId,
    type: NOTIFICATION_TYPE.ADMIN_VAULT_RESET,
    title: notificationTitle("ADMIN_VAULT_RESET", locale),
    body: notificationBody("ADMIN_VAULT_RESET", locale),
  });

  // Email notification to target user
  if (targetMember.user.email) {
    const resetUrl = `${serverAppUrl(`/${locale}/vault-reset/admin`)}#token=${token}`;
    const adminName = session.user.name ?? session.user.email ?? "";
    const { subject, html, text } = adminVaultResetEmail(
      locale,
      adminName,
      resetUrl,
    );
    void sendEmail({ to: targetMember.user.email, subject, html, text });
  }

  return NextResponse.json({ ok: true });
}

// GET /api/tenant/members/[userId]/reset-vault
// Get reset history for a specific member. Tenant OWNER/ADMIN only.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  void req;

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  const { userId: targetUserId } = await params;

  let actor;
  try {
    actor = await requireTenantPermission(
      session.user.id,
      TENANT_PERMISSION.MEMBER_VAULT_RESET,
    );
  } catch (err) {
    if (err instanceof TenantAuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  const resets = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.adminVaultReset.findMany({
      where: {
        targetUserId,
        tenantId: actor.tenantId,
      },
      include: {
        initiatedBy: { select: { name: true, email: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  );

  const now = new Date();
  const result = resets.map((r) => {
    let status: "pending" | "executed" | "revoked" | "expired";
    if (r.executedAt) status = "executed";
    else if (r.revokedAt) status = "revoked";
    else if (r.expiresAt < now) status = "expired";
    else status = "pending";

    return {
      id: r.id,
      status,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      executedAt: r.executedAt,
      revokedAt: r.revokedAt,
      initiatedBy: {
        name: r.initiatedBy.name,
        email: r.initiatedBy.email,
      },
    };
  });

  return NextResponse.json(result);
}
