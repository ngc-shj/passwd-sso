import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { requireTenantPermission, TenantAuthError } from "@/lib/tenant-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { parseBody } from "@/lib/parse-body";
import { TENANT_PERMISSION } from "@/lib/constants/tenant-permission";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { dispatchTenantWebhook } from "@/lib/webhook-dispatcher";
import { withTenantRls } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/with-request-log";
import { errorResponse, unauthorized, rateLimited } from "@/lib/api-response";
import { createRateLimiter } from "@/lib/rate-limit";
import { z } from "zod";
import { SA_TOKEN_SCOPES } from "@/lib/constants/service-account";

const accessRequestCreateLimiter = createRateLimiter({ windowMs: 60 * 60_000, max: 20 });

export const runtime = "nodejs";

const VALID_ACCESS_REQUEST_STATUSES = ["PENDING", "APPROVED", "DENIED", "EXPIRED"] as const;

const accessRequestCreateSchema = z.object({
  serviceAccountId: z.string().uuid(),
  requestedScope: z.array(z.enum(SA_TOKEN_SCOPES as [string, ...string[]])).min(1),
  justification: z.string().max(1000).optional(),
  expiresInMinutes: z.number().int().min(5).max(1440).default(60),
});

// GET /api/tenant/access-requests — List access requests for the tenant
async function handleGET(req: NextRequest) {
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
    if (err instanceof TenantAuthError) {
      return errorResponse(err.message, err.status);
    }
    throw err;
  }

  const { searchParams } = new URL(req.url);
  const rawStatus = searchParams.get("status");
  const validatedStatus = rawStatus && (VALID_ACCESS_REQUEST_STATUSES as readonly string[]).includes(rawStatus)
    ? (rawStatus as (typeof VALID_ACCESS_REQUEST_STATUSES)[number])
    : undefined;
  const serviceAccountId = searchParams.get("serviceAccountId") ?? undefined;

  const accessRequests = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.accessRequest.findMany({
      where: {
        tenantId: actor.tenantId,
        ...(validatedStatus !== undefined && { status: validatedStatus }),
        ...(serviceAccountId !== undefined && { serviceAccountId }),
      },
      select: {
        id: true,
        serviceAccountId: true,
        requestedScope: true,
        justification: true,
        status: true,
        approvedById: true,
        approvedAt: true,
        grantedTokenId: true,
        grantedTokenTtlSec: true,
        expiresAt: true,
        createdAt: true,
        serviceAccount: { select: { id: true, name: true, description: true, isActive: true } },
        approvedBy: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
  );

  return NextResponse.json(accessRequests);
}

// POST /api/tenant/access-requests — Create a new access request
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
    if (err instanceof TenantAuthError) {
      return errorResponse(err.message, err.status);
    }
    throw err;
  }

  const rl = await accessRequestCreateLimiter.check(`rl:access_request_create:${actor.tenantId}`);
  if (!rl.allowed) return rateLimited(rl.retryAfterMs);

  const result = await parseBody(req, accessRequestCreateSchema);
  if (!result.ok) return result.response;

  // Validate that the service account exists and belongs to this tenant
  const sa = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.serviceAccount.findUnique({
      where: { id: result.data.serviceAccountId },
      select: { id: true, tenantId: true, isActive: true },
    }),
  );

  if (!sa || sa.tenantId !== actor.tenantId) {
    return NextResponse.json(
      { error: API_ERROR.SA_NOT_FOUND },
      { status: 404 },
    );
  }

  const expiresAt = new Date(Date.now() + result.data.expiresInMinutes * 60 * 1000);

  const accessRequest = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.accessRequest.create({
      data: {
        tenantId: actor.tenantId,
        serviceAccountId: result.data.serviceAccountId,
        requestedScope: result.data.requestedScope.join(","),
        justification: result.data.justification ?? null,
        expiresAt,
      },
      select: {
        id: true,
        serviceAccountId: true,
        requestedScope: true,
        justification: true,
        status: true,
        expiresAt: true,
        createdAt: true,
      },
    }),
  );

  logAudit({
    scope: AUDIT_SCOPE.TENANT,
    action: AUDIT_ACTION.ACCESS_REQUEST_CREATE,
    userId: session.user.id,
    tenantId: actor.tenantId,
    targetType: AUDIT_TARGET_TYPE.ACCESS_REQUEST,
    targetId: accessRequest.id,
    metadata: {
      serviceAccountId: result.data.serviceAccountId,
      requestedScope: result.data.requestedScope.join(","),
      expiresInMinutes: result.data.expiresInMinutes,
    },
    ...extractRequestMeta(req),
  });
  void dispatchTenantWebhook({
    type: AUDIT_ACTION.ACCESS_REQUEST_CREATE,
    tenantId: actor.tenantId,
    timestamp: new Date().toISOString(),
    data: { accessRequestId: accessRequest.id, serviceAccountId: result.data.serviceAccountId },
  });

  return NextResponse.json(accessRequest, { status: 201 });
}

export const GET = withRequestLog(handleGET);
export const POST = withRequestLog(handlePOST);
