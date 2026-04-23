import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit";
import { requireTenantPermission } from "@/lib/auth/tenant-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { parseBody } from "@/lib/parse-body";
import { TENANT_PERMISSION } from "@/lib/constants/tenant-permission";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { withTenantRls } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/with-request-log";
import { handleAuthError, rateLimited, unauthorized } from "@/lib/api-response";
import { createRateLimiter } from "@/lib/rate-limit";
import { MAX_SERVICE_ACCOUNTS_PER_TENANT } from "@/lib/constants/service-account";
import { serviceAccountCreateSchema } from "@/lib/validations/service-account";
import { MS_PER_HOUR } from "@/lib/constants/time";

const saCreateLimiter = createRateLimiter({ windowMs: MS_PER_HOUR, max: 10 });

export const runtime = "nodejs";

// GET /api/tenant/service-accounts — List service accounts for the tenant
async function handleGET(req: NextRequest) {
  void req;

  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  let actor;
  try {
    actor = await requireTenantPermission(
      session.user.id,
      TENANT_PERMISSION.SERVICE_ACCOUNT_MANAGE,
    );
  } catch (err) {
    return handleAuthError(err);
  }

  const accounts = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.serviceAccount.findMany({
      where: { tenantId: actor.tenantId },
      select: {
        id: true,
        name: true,
        description: true,
        identityType: true,
        isActive: true,
        teamId: true,
        createdAt: true,
        updatedAt: true,
        createdBy: { select: { id: true, name: true, email: true } },
        _count: {
          select: {
            tokens: { where: { revokedAt: null } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
  );

  return NextResponse.json(accounts);
}

// POST /api/tenant/service-accounts — Create a new service account
async function handlePOST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  let actor;
  try {
    actor = await requireTenantPermission(
      session.user.id,
      TENANT_PERMISSION.SERVICE_ACCOUNT_MANAGE,
    );
  } catch (err) {
    return handleAuthError(err);
  }

  const rl = await saCreateLimiter.check(`rl:sa_create:${actor.tenantId}`);
  if (!rl.allowed) return rateLimited(rl.retryAfterMs);

  const result = await parseBody(req, serviceAccountCreateSchema);
  if (!result.ok) return result.response;

  const count = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.serviceAccount.count({
      where: { tenantId: actor.tenantId, isActive: true },
    }),
  );
  if (count >= MAX_SERVICE_ACCOUNTS_PER_TENANT) {
    return NextResponse.json(
      { error: API_ERROR.SA_LIMIT_EXCEEDED },
      { status: 409 },
    );
  }

  let sa;
  try {
    sa = await withTenantRls(prisma, actor.tenantId, async () =>
      prisma.serviceAccount.create({
        data: {
          tenantId: actor.tenantId,
          name: result.data.name,
          description: result.data.description ?? null,
          teamId: result.data.teamId ?? null,
          createdById: session.user.id,
        },
        select: {
          id: true,
          name: true,
          description: true,
          identityType: true,
          isActive: true,
          teamId: true,
          createdAt: true,
          updatedAt: true,
          createdBy: { select: { id: true, name: true, email: true } },
        },
      }),
    );
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return NextResponse.json(
        { error: API_ERROR.SA_NAME_CONFLICT },
        { status: 409 },
      );
    }
    throw err;
  }

  await logAuditAsync({
    ...tenantAuditBase(req, session.user.id, actor.tenantId),
    action: AUDIT_ACTION.SERVICE_ACCOUNT_CREATE,
    targetType: AUDIT_TARGET_TYPE.SERVICE_ACCOUNT,
    targetId: sa.id,
    metadata: { name: result.data.name },
  });

  return NextResponse.json(sa, { status: 201 });
}

export const GET = withRequestLog(handleGET);
export const POST = withRequestLog(handlePOST);
