import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, tenantAuditBase, resolveActorType } from "@/lib/audit/audit";
import { requireTenantPermission } from "@/lib/auth/access/tenant-auth";
import { authOrToken } from "@/lib/auth/session/auth-or-token";
import { enforceAccessRestriction } from "@/lib/auth/policy/access-restriction";
import { SYSTEM_ACTOR_ID } from "@/lib/constants/app";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { parseBody } from "@/lib/http/parse-body";
import { TENANT_PERMISSION } from "@/lib/constants/auth/tenant-permission";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE, AR_STATUS } from "@/lib/constants";
import { ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { withTenantRls, withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse, handleAuthError, unauthorized } from "@/lib/http/api-response";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { z } from "zod";
import { SA_TOKEN_PREFIX, SA_TOKEN_SCOPE, SA_TOKEN_SCOPES } from "@/lib/constants/auth/service-account";
import { MS_PER_HOUR, MS_PER_MINUTE } from "@/lib/constants/time";

const accessRequestCreateLimiter = createRateLimiter({
  windowMs: MS_PER_HOUR,
  max: 20,
  failClosedOnRedisError: true,
});

export const runtime = "nodejs";

const VALID_ACCESS_REQUEST_STATUSES = [
  AR_STATUS.PENDING,
  AR_STATUS.APPROVED,
  AR_STATUS.DENIED,
  AR_STATUS.EXPIRED,
] as const;

// Admin creates request on behalf of SA
const adminCreateSchema = z.object({
  serviceAccountId: z.string().uuid(),
  requestedScope: z.array(z.enum(SA_TOKEN_SCOPES as [string, ...string[]])).min(1),
  justification: z.string().max(1000).optional(),
  expiresInMinutes: z.number().int().min(5).max(1440).default(60),
});

// SA self-service request (serviceAccountId inferred from token)
const saCreateSchema = z.object({
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
    return handleAuthError(err);
  }

  const { searchParams } = new URL(req.url);
  const rawStatus = searchParams.get("status");
  const validatedStatus = rawStatus && (VALID_ACCESS_REQUEST_STATUSES as readonly string[]).includes(rawStatus)
    ? (rawStatus as (typeof VALID_ACCESS_REQUEST_STATUSES)[number])
    : undefined;
  const serviceAccountId = searchParams.get("serviceAccountId") ?? undefined;

  const accessRequests = await withTenantRls(prisma, actor.tenantId, async (tx) =>
    tx.accessRequest.findMany({
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
// Supports two auth modes:
// 1. SA token (Bearer sa_...) — SA self-service, serviceAccountId inferred from token
// 2. Session (admin) — admin creates on behalf of SA, serviceAccountId in body
// Any other token type (api_key, extension_token, mcp_token) is rejected with 401.
async function handlePOST(req: NextRequest) {
  // Detect SA self-service by Bearer prefix before calling auth()
  const bearerHeader = req.headers.get("authorization");
  const isSaBearer = bearerHeader?.startsWith(`Bearer ${SA_TOKEN_PREFIX}`) ?? false;

  let authResult: Awaited<ReturnType<typeof authOrToken>>;

  if (isSaBearer) {
    authResult = await authOrToken(req, SA_TOKEN_SCOPE.ACCESS_REQUEST_CREATE);
    if (!authResult || authResult.type === "scope_insufficient") {
      return errorResponse(API_ERROR.EXTENSION_TOKEN_SCOPE_INSUFFICIENT);
    }
    if (authResult.type !== "service_account") return unauthorized();
  } else {
    // Admin path: session only — all Bearer token types are rejected
    const session = await auth();
    if (!session?.user?.id) return unauthorized();
    authResult = { type: "session", userId: session.user.id };
  }

  let tenantId: string;
  let serviceAccountId: string;
  let userId: string;
  let requestedScope: string[];
  let justification: string | undefined;
  let expiresInMinutes: number;

  if (authResult.type === "service_account") {
    // SA self-service: scope was already validated by authOrToken(req, ACCESS_REQUEST_CREATE)
    // at the SA-bearer branch above. No second-check needed.
    tenantId = authResult.tenantId;
    serviceAccountId = authResult.serviceAccountId;

    // Enforce tenant network-boundary policy BEFORE rate limit so an
    // off-network holder of a stolen SA bearer cannot burn the per-SA
    // request budget against the legitimate SA. userId is the SA sentinel
    // (SYSTEM_ACTOR_ID) here because sa.createdById is not resolved until
    // the active-SA lookup below; the denial audit records tenantId and
    // serviceAccountId via actorType/metadata regardless.
    const denied = await enforceAccessRestriction(
      req,
      SYSTEM_ACTOR_ID,
      tenantId,
      ACTOR_TYPE.SERVICE_ACCOUNT,
    );
    if (denied) return denied;

    const saBlocked = await checkRateLimitOrFail({
      req,
      limiter: accessRequestCreateLimiter,
      key: `rl:access_request_create:sa:${serviceAccountId}`,
      scope: "access_request.create",
      userId: null,
      tenantId,
    });
    if (saBlocked) return saBlocked;

    const result = await parseBody(req, saCreateSchema);
    if (!result.ok) return result.response;

    requestedScope = result.data.requestedScope;
    justification = result.data.justification;
    expiresInMinutes = result.data.expiresInMinutes;

    // Verify SA is active
    const sa = await withBypassRls(prisma, async (tx) =>
      tx.serviceAccount.findUnique({
        where: { id: serviceAccountId },
        select: { isActive: true, createdById: true },
      }),
    BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);
    if (!sa) {
      return errorResponse(API_ERROR.SA_NOT_FOUND);
    }
    if (!sa.isActive) {
      return errorResponse(API_ERROR.SA_INACTIVE);
    }
    userId = sa.createdById;
  } else {
    // Admin path: session-only (enforced above; authResult.type === "session" here)
    userId = authResult.userId;

    let actor;
    try {
      actor = await requireTenantPermission(userId, TENANT_PERMISSION.SERVICE_ACCOUNT_MANAGE);
    } catch (err) {
      return handleAuthError(err);
    }
    tenantId = actor.tenantId;

    // Session reaches this handler via middleware which already enforces
    // tenant IP restriction. No other token type can reach this branch.

    const adminBlocked = await checkRateLimitOrFail({
      req,
      limiter: accessRequestCreateLimiter,
      key: `rl:access_request_create:${tenantId}`,
      scope: "access_request.create",
      userId,
      tenantId,
    });
    if (adminBlocked) return adminBlocked;

    const result = await parseBody(req, adminCreateSchema);
    if (!result.ok) return result.response;

    serviceAccountId = result.data.serviceAccountId;
    requestedScope = result.data.requestedScope;
    justification = result.data.justification;
    expiresInMinutes = result.data.expiresInMinutes;

    // Validate SA exists and belongs to this tenant
    const sa = await withTenantRls(prisma, tenantId, async (tx) =>
      tx.serviceAccount.findUnique({
        where: { id: serviceAccountId },
        select: { id: true, tenantId: true, isActive: true },
      }),
    );
    // Cross-tenant SAs are collapsed into SA_NOT_FOUND so callers cannot probe
    // for SA existence in other tenants. Inactive SAs in the caller's own
    // tenant return SA_INACTIVE since the SA is observably present.
    if (!sa || sa.tenantId !== tenantId) {
      return errorResponse(API_ERROR.SA_NOT_FOUND);
    }
    if (!sa.isActive) {
      return errorResponse(API_ERROR.SA_INACTIVE);
    }
  }

  const expiresAt = new Date(Date.now() + expiresInMinutes * MS_PER_MINUTE);

  // C8 (OWASP A01-1): record who created this request, partitioned by
  // actor type. The approve handler later rejects same-actor approval.
  const requesterUserId =
    authResult.type === "session" ? authResult.userId : null;
  const requesterServiceAccountId =
    authResult.type === "service_account" ? authResult.serviceAccountId : null;

  const accessRequest = await withBypassRls(prisma, async (tx) =>
    tx.accessRequest.create({
      data: {
        tenantId,
        serviceAccountId,
        requestedScope: requestedScope.join(","),
        justification: justification ?? null,
        expiresAt,
        requesterUserId,
        requesterServiceAccountId,
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
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);

  await logAuditAsync({
    ...tenantAuditBase(req, userId, tenantId),
    actorType: resolveActorType(authResult),
    serviceAccountId: authResult.type === "service_account" ? serviceAccountId : undefined,
    action: AUDIT_ACTION.ACCESS_REQUEST_CREATE,
    targetType: AUDIT_TARGET_TYPE.ACCESS_REQUEST,
    targetId: accessRequest.id,
    metadata: {
      serviceAccountId,
      requestedScope: requestedScope.join(","),
      expiresInMinutes,
    },
  });

  return NextResponse.json(accessRequest, { status: 201 });
}

export const GET = withRequestLog(handleGET);
export const POST = withRequestLog(handlePOST);
