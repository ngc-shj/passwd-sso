import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, tenantAuditBase, resolveActorType } from "@/lib/audit";
import { requireTenantPermission } from "@/lib/tenant-auth";
import { authOrToken } from "@/lib/auth-or-token";
import { enforceAccessRestriction } from "@/lib/access-restriction";
import { SYSTEM_ACTOR_ID } from "@/lib/constants/app";
import { API_ERROR } from "@/lib/api-error-codes";
import { parseBody } from "@/lib/parse-body";
import { TENANT_PERMISSION } from "@/lib/constants/tenant-permission";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { ACTOR_TYPE } from "@/lib/constants/audit";
import { withTenantRls, withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/with-request-log";
import { errorResponse, handleAuthError, rateLimited, unauthorized } from "@/lib/api-response";
import { createRateLimiter } from "@/lib/rate-limit";
import { z } from "zod";
import { SA_TOKEN_SCOPE, SA_TOKEN_SCOPES } from "@/lib/constants/service-account";
import { MS_PER_HOUR, MS_PER_MINUTE } from "@/lib/constants/time";

const accessRequestCreateLimiter = createRateLimiter({ windowMs: MS_PER_HOUR, max: 20 });

export const runtime = "nodejs";

const VALID_ACCESS_REQUEST_STATUSES = ["PENDING", "APPROVED", "DENIED", "EXPIRED"] as const;

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
// Supports two auth modes:
// 1. SA token (Bearer sa_...) — SA self-service, serviceAccountId inferred from token
// 2. Session (admin) — admin creates on behalf of SA, serviceAccountId in body
async function handlePOST(req: NextRequest) {
  const authResult = await authOrToken(req);
  if (!authResult || authResult.type === "scope_insufficient" ||
      authResult.type === "mcp_token") {
    return unauthorized();
  }

  let tenantId: string;
  let serviceAccountId: string;
  let userId: string;
  let requestedScope: string[];
  let justification: string | undefined;
  let expiresInMinutes: number;

  if (authResult.type === "service_account") {
    // SA self-service: requires access-request:create scope
    if (!authResult.scopes.includes(SA_TOKEN_SCOPE.ACCESS_REQUEST_CREATE)) {
      return errorResponse(API_ERROR.EXTENSION_TOKEN_SCOPE_INSUFFICIENT, 403);
    }

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

    const rl = await accessRequestCreateLimiter.check(`rl:access_request_create:sa:${serviceAccountId}`);
    if (!rl.allowed) return rateLimited(rl.retryAfterMs);

    const result = await parseBody(req, saCreateSchema);
    if (!result.ok) return result.response;

    requestedScope = result.data.requestedScope;
    justification = result.data.justification;
    expiresInMinutes = result.data.expiresInMinutes;

    // Verify SA is active
    const sa = await withBypassRls(prisma, async () =>
      prisma.serviceAccount.findUnique({
        where: { id: serviceAccountId },
        select: { isActive: true, createdById: true },
      }),
    BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);
    if (!sa || !sa.isActive) {
      return errorResponse(API_ERROR.SA_NOT_FOUND, 404);
    }
    userId = sa.createdById;
  } else {
    // Admin path: session or API key auth
    if (!("userId" in authResult)) return unauthorized();
    userId = authResult.userId;

    let actor;
    try {
      actor = await requireTenantPermission(userId, TENANT_PERMISSION.SERVICE_ACCOUNT_MANAGE);
    } catch (err) {
      return handleAuthError(err);
    }
    tenantId = actor.tenantId;

    // Session reaches this handler via middleware which already enforces
    // tenant IP restriction. API key / other token types bypass middleware
    // access restriction and must be checked here.
    if (authResult.type !== "session") {
      const denied = await enforceAccessRestriction(
        req,
        userId,
        tenantId,
        resolveActorType(authResult),
      );
      if (denied) return denied;
    }

    const rl = await accessRequestCreateLimiter.check(`rl:access_request_create:${tenantId}`);
    if (!rl.allowed) return rateLimited(rl.retryAfterMs);

    const result = await parseBody(req, adminCreateSchema);
    if (!result.ok) return result.response;

    serviceAccountId = result.data.serviceAccountId;
    requestedScope = result.data.requestedScope;
    justification = result.data.justification;
    expiresInMinutes = result.data.expiresInMinutes;

    // Validate SA exists and belongs to this tenant
    const sa = await withTenantRls(prisma, tenantId, async () =>
      prisma.serviceAccount.findUnique({
        where: { id: serviceAccountId },
        select: { id: true, tenantId: true, isActive: true },
      }),
    );
    if (!sa || sa.tenantId !== tenantId || !sa.isActive) {
      return errorResponse(API_ERROR.SA_NOT_FOUND, 404);
    }
  }

  const expiresAt = new Date(Date.now() + expiresInMinutes * MS_PER_MINUTE);

  const accessRequest = await withBypassRls(prisma, async () =>
    prisma.accessRequest.create({
      data: {
        tenantId,
        serviceAccountId,
        requestedScope: requestedScope.join(","),
        justification: justification ?? null,
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
