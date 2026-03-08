import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireTenantPermission, TenantAuthError } from "@/lib/tenant-auth";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { API_ERROR } from "@/lib/api-error-codes";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
import { TENANT_PERMISSION } from "@/lib/constants/tenant-permission";
import { createRateLimiter } from "@/lib/rate-limit";
import { withRequestLog } from "@/lib/with-request-log";
import { withBypassRls } from "@/lib/tenant-rls";

const policyLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });

// GET /api/tenant/policy — read tenant session policy
async function handleGET(_req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  try {
    await requireTenantPermission(session.user.id, TENANT_PERMISSION.MEMBER_MANAGE);
  } catch (e) {
    if (e instanceof TenantAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const user = await withBypassRls(prisma, async () =>
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: { tenant: { select: { maxConcurrentSessions: true, sessionIdleTimeoutMinutes: true, vaultAutoLockMinutes: true } } },
    }),
  );

  return NextResponse.json({
    maxConcurrentSessions: user?.tenant?.maxConcurrentSessions ?? null,
    sessionIdleTimeoutMinutes: user?.tenant?.sessionIdleTimeoutMinutes ?? null,
    vaultAutoLockMinutes: user?.tenant?.vaultAutoLockMinutes ?? null,
  });
}

// PATCH /api/tenant/policy — update tenant session policy
async function handlePATCH(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: API_ERROR.UNAUTHORIZED }, { status: 401 });
  }

  if (!(await policyLimiter.check(`rl:tenant_policy:${session.user.id}`)).allowed) {
    return NextResponse.json({ error: API_ERROR.RATE_LIMIT_EXCEEDED }, { status: 429 });
  }

  let membership;
  try {
    membership = await requireTenantPermission(session.user.id, TENANT_PERMISSION.MEMBER_MANAGE);
  } catch (e) {
    if (e instanceof TenantAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: API_ERROR.VALIDATION_ERROR }, { status: 400 });
  }
  const { maxConcurrentSessions, sessionIdleTimeoutMinutes, vaultAutoLockMinutes } = body;

  // Validate maxConcurrentSessions: null (unlimited) or positive integer 1-100
  if (maxConcurrentSessions !== null && maxConcurrentSessions !== undefined) {
    if (
      typeof maxConcurrentSessions !== "number" ||
      !Number.isInteger(maxConcurrentSessions) ||
      maxConcurrentSessions < 1 ||
      maxConcurrentSessions > 100
    ) {
      return NextResponse.json({ error: API_ERROR.VALIDATION_ERROR }, { status: 400 });
    }
  }

  // Validate vaultAutoLockMinutes: null (default 15min) or positive integer 1-1440 (24h)
  if (vaultAutoLockMinutes !== null && vaultAutoLockMinutes !== undefined) {
    if (
      typeof vaultAutoLockMinutes !== "number" ||
      !Number.isInteger(vaultAutoLockMinutes) ||
      vaultAutoLockMinutes < 1 ||
      vaultAutoLockMinutes > 1440
    ) {
      return NextResponse.json({ error: API_ERROR.VALIDATION_ERROR }, { status: 400 });
    }
  }

  // Validate sessionIdleTimeoutMinutes: null (disabled) or positive integer 1-1440 (24h)
  if (sessionIdleTimeoutMinutes !== null && sessionIdleTimeoutMinutes !== undefined) {
    if (
      typeof sessionIdleTimeoutMinutes !== "number" ||
      !Number.isInteger(sessionIdleTimeoutMinutes) ||
      sessionIdleTimeoutMinutes < 1 ||
      sessionIdleTimeoutMinutes > 1440
    ) {
      return NextResponse.json({ error: API_ERROR.VALIDATION_ERROR }, { status: 400 });
    }
  }

  const updateData: Record<string, unknown> = {};
  if (maxConcurrentSessions !== undefined) {
    updateData.maxConcurrentSessions = maxConcurrentSessions ?? null;
  }
  if (sessionIdleTimeoutMinutes !== undefined) {
    updateData.sessionIdleTimeoutMinutes = sessionIdleTimeoutMinutes ?? null;
  }
  if (vaultAutoLockMinutes !== undefined) {
    updateData.vaultAutoLockMinutes = vaultAutoLockMinutes ?? null;
  }

  const updated = await withBypassRls(prisma, async () =>
    prisma.tenant.update({
      where: { id: membership.tenantId },
      data: updateData,
      select: {
        maxConcurrentSessions: true,
        sessionIdleTimeoutMinutes: true,
        vaultAutoLockMinutes: true,
      },
    }),
  );

  const meta = extractRequestMeta(req);
  logAudit({
    scope: AUDIT_SCOPE.TENANT,
    action: AUDIT_ACTION.POLICY_UPDATE,
    userId: session.user.id,
    tenantId: membership.tenantId,
    metadata: {
      maxConcurrentSessions: updated.maxConcurrentSessions,
      sessionIdleTimeoutMinutes: updated.sessionIdleTimeoutMinutes,
      vaultAutoLockMinutes: updated.vaultAutoLockMinutes,
    },
    ip: meta.ip,
    userAgent: meta.userAgent,
  });

  return NextResponse.json({
    maxConcurrentSessions: updated.maxConcurrentSessions,
    sessionIdleTimeoutMinutes: updated.sessionIdleTimeoutMinutes,
    vaultAutoLockMinutes: updated.vaultAutoLockMinutes,
  });
}

export const GET = withRequestLog(handleGET);
export const PATCH = withRequestLog(handlePATCH);
