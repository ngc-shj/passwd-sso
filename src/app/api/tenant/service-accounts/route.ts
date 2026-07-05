import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { requireTenantPermission } from "@/lib/auth/access/tenant-auth";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { parseBody } from "@/lib/http/parse-body";
import { TENANT_PERMISSION } from "@/lib/constants/auth/tenant-permission";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { withTenantRls, advisoryXactLock } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse, handleAuthError, unauthorized } from "@/lib/http/api-response";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import { MAX_SERVICE_ACCOUNTS_PER_TENANT } from "@/lib/constants/auth/service-account";
import { serviceAccountCreateSchema } from "@/lib/validations/service-account";
import { MS_PER_HOUR } from "@/lib/constants/time";

const saCreateLimiter = createRateLimiter({
  windowMs: MS_PER_HOUR,
  max: 10,
  failClosedOnRedisError: true,
});

// Sentinel thrown inside the locked transaction when the re-checked active
// service-account count is at the cap. Mapped to SA_LIMIT_EXCEEDED outside
// the tx.
class ServiceAccountLimitError extends Error {}

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

  const accounts = await withTenantRls(prisma, actor.tenantId, async (tx) =>
    tx.serviceAccount.findMany({
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

  const blocked = await checkRateLimitOrFail({
    req,
    limiter: saCreateLimiter,
    key: `rl:sa_create:${actor.tenantId}`,
    scope: "tenant.service_account_create",
    userId: session.user.id,
    tenantId: actor.tenantId,
  });
  if (blocked) return blocked;

  const result = await parseBody(req, serviceAccountCreateSchema);
  if (!result.ok) return result.response;

  // Serialize the cap check with the create under a per-tenant advisory lock so
  // two concurrent POSTs cannot both read count < MAX and both create, blowing
  // past MAX_SERVICE_ACCOUNTS_PER_TENANT (TOCTOU). Lock, count, and create fold
  // into one tenant tx; over-limit throws a sentinel mapped outside. The lock
  // guards the count cap only — the (tenantId, name) unique constraint is
  // orthogonal and still surfaces as P2002 → SA_NAME_CONFLICT below.
  let sa;
  try {
    sa = await withTenantRls(prisma, actor.tenantId, async (tx) => {
      await advisoryXactLock(tx, actor.tenantId);
      const count = await tx.serviceAccount.count({
        where: { tenantId: actor.tenantId, isActive: true },
      });
      if (count >= MAX_SERVICE_ACCOUNTS_PER_TENANT) {
        throw new ServiceAccountLimitError();
      }
      return tx.serviceAccount.create({
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
      });
    });
  } catch (err) {
    if (err instanceof ServiceAccountLimitError) {
      return errorResponse(API_ERROR.SA_LIMIT_EXCEEDED);
    }
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return errorResponse(API_ERROR.SA_NAME_CONFLICT);
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
