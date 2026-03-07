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
      select: { tenant: { select: { maxConcurrentSessions: true } } },
    }),
  );

  return NextResponse.json({
    maxConcurrentSessions: user?.tenant?.maxConcurrentSessions ?? null,
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

  const body = await req.json();
  const { maxConcurrentSessions } = body;

  // Validate: null (unlimited) or positive integer
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

  await withBypassRls(prisma, async () =>
    prisma.tenant.update({
      where: { id: membership.tenantId },
      data: { maxConcurrentSessions: maxConcurrentSessions ?? null },
    }),
  );

  const meta = extractRequestMeta(req);
  logAudit({
    scope: AUDIT_SCOPE.TENANT,
    action: AUDIT_ACTION.POLICY_UPDATE,
    userId: session.user.id,
    metadata: { maxConcurrentSessions: maxConcurrentSessions ?? null },
    ip: meta.ip,
    userAgent: meta.userAgent,
  });

  return NextResponse.json({
    maxConcurrentSessions: maxConcurrentSessions ?? null,
  });
}

export const GET = withRequestLog(handleGET);
export const PATCH = withRequestLog(handlePATCH);
