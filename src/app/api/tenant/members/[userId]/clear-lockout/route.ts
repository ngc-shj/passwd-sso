import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import {
  requireTenantPermission,
  isTenantRoleAbove,
} from "@/lib/auth/access/tenant-auth";
import { requireRecentCurrentAuthMethod } from "@/lib/auth/session/recent-current-auth-method";
import { withTenantRls } from "@/lib/tenant-rls";
import { TENANT_PERMISSION } from "@/lib/constants/auth/tenant-permission";
import { AUDIT_ACTION } from "@/lib/constants";
import { withRequestLog } from "@/lib/http/with-request-log";
import { forbidden, handleAuthError, notFound, rateLimited, serviceUnavailable, unauthorized } from "@/lib/http/api-response";
import { emitRateLimitFailClosed } from "@/lib/security/rate-limit-audit";
import { MS_PER_DAY } from "@/lib/constants/time";

export const runtime = "nodejs";

const adminLockoutClearLimiter = createRateLimiter({
  windowMs: MS_PER_DAY,
  max: 5,
  failClosedOnRedisError: true,
});

const targetLockoutClearLimiter = createRateLimiter({
  windowMs: MS_PER_DAY,
  max: 2,
  failClosedOnRedisError: true,
});

// POST /api/tenant/members/[userId]/clear-lockout
// Clear a tenant member's vault-unlock lockout (failedUnlockAttempts,
// accountLockedUntil, lastFailedUnlockAt). Tenant member-management action
// (NOT vault destruction) — MEMBER_MANAGE permission, not MEMBER_VAULT_RESET.
async function handlePOST(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { userId: targetUserId } = await params;

  let actor;
  try {
    actor = await requireTenantPermission(
      session.user.id,
      TENANT_PERMISSION.MEMBER_MANAGE,
    );
  } catch (err) {
    return handleAuthError(err);
  }

  // Find the target member in same tenant.
  const targetMember = await withTenantRls(prisma, actor.tenantId, async (tx) =>
    tx.tenantMember.findFirst({
      where: {
        tenantId: actor.tenantId,
        userId: targetUserId,
        deactivatedAt: null,
      },
      select: { role: true },
    }),
  );

  if (!targetMember) {
    return notFound();
  }

  // Self-target is allowed and skips the hierarchy check (clearing one's own
  // lockout is legitimate recovery with no key-custody conflict, unlike vault
  // reset). isTenantRoleAbove is strictly-above (false for equal roles), so
  // the self case must bypass it rather than fail the hierarchy gate.
  if (targetUserId !== session.user.id) {
    if (!isTenantRoleAbove(actor.role, targetMember.role)) {
      return forbidden();
    }
  }

  // @stepup id:clear-lockout-post method:POST
  const stepUpError = await requireRecentCurrentAuthMethod(req);
  if (stepUpError) return stepUpError;

  const [adminResult, targetResult] = await Promise.all([
    adminLockoutClearLimiter.check(`rl:lockout_clear_admin:${session.user.id}`),
    targetLockoutClearLimiter.check(`rl:lockout_clear_target:${targetUserId}`),
  ]);

  if (adminResult.redisErrored || targetResult.redisErrored) {
    void emitRateLimitFailClosed({
      req,
      scope: "tenant.member_lockout_clear",
      userId: session.user.id,
      tenantId: actor.tenantId,
    });
    return serviceUnavailable();
  }

  if (!adminResult.allowed || !targetResult.allowed) {
    const retryAfterMs = !adminResult.allowed ? adminResult.retryAfterMs : targetResult.retryAfterMs;
    return rateLimited(retryAfterMs);
  }

  // Lockout fields live on the global User model; the TenantMember lookup
  // above IS the tenant-scoping (a global User has no tenantId-scoped table
  // of its own to filter this update by).
  await prisma.user.update({
    where: { id: targetUserId },
    data: {
      failedUnlockAttempts: 0,
      accountLockedUntil: null,
      lastFailedUnlockAt: null,
    },
  });

  await logAuditAsync({
    ...tenantAuditBase(req, session.user.id, actor.tenantId),
    action: AUDIT_ACTION.TENANT_MEMBER_LOCKOUT_CLEAR,
    targetType: "User",
    targetId: targetUserId,
  });

  return NextResponse.json({ ok: true });
}

export const POST = withRequestLog(handlePOST);
