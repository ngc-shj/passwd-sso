import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/crypto-server";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { requireTenantPermission, TenantAuthError } from "@/lib/tenant-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { TENANT_PERMISSION } from "@/lib/constants/tenant-permission";
import { AUDIT_ACTION, AUDIT_SCOPE, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { dispatchTenantWebhook } from "@/lib/webhook-dispatcher";
import { withTenantRls } from "@/lib/tenant-rls";
import { withBypassRls } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/with-request-log";
import { errorResponse, unauthorized, notFound } from "@/lib/api-response";
import { SA_TOKEN_PREFIX, MAX_SA_TOKENS_PER_ACCOUNT } from "@/lib/constants/service-account";
import { parseSaTokenScopes } from "@/lib/service-account-token";
import { randomBytes } from "node:crypto";

type Params = { params: Promise<{ id: string }> };

export const runtime = "nodejs";

const DEFAULT_JIT_TTL_SEC = 3600;   // 1 hour
const MAX_JIT_TTL_SEC = 86400;      // 24 hours

// POST /api/tenant/access-requests/[id]/approve — Approve an access request and issue JIT token
async function handlePOST(req: NextRequest, { params }: Params) {
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

  const { id: requestId } = await params;

  // Fetch the access request to get serviceAccountId and requestedScope
  const request = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.accessRequest.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        tenantId: true,
        serviceAccountId: true,
        requestedScope: true,
        status: true,
        serviceAccount: { select: { isActive: true } },
      },
    }),
  );

  if (!request || request.tenantId !== actor.tenantId) {
    return notFound();
  }

  if (!request.serviceAccount.isActive) {
    return NextResponse.json(
      { error: API_ERROR.SA_NOT_FOUND, message: "Service account is inactive" },
      { status: 409 },
    );
  }

  // Read tenant policy for JIT TTL bounds
  const tenant = await withBypassRls(prisma, async () =>
    prisma.tenant.findUnique({
      where: { id: actor.tenantId },
      select: { jitTokenDefaultTtlSec: true, jitTokenMaxTtlSec: true },
    }),
  );

  const defaultTtlSec = tenant?.jitTokenDefaultTtlSec ?? DEFAULT_JIT_TTL_SEC;
  const maxTtlSec = Math.min(tenant?.jitTokenMaxTtlSec ?? MAX_JIT_TTL_SEC, MAX_JIT_TTL_SEC);
  const ttlSec = Math.min(defaultTtlSec, maxTtlSec);

  let result: { plaintext: string; expiresAt: Date; tokenId: string };
  try {
    result = await prisma.$transaction(async (tx) => {
      // Enforce token limit per SA
      const activeTokenCount = await tx.serviceAccountToken.count({
        where: { serviceAccountId: request.serviceAccountId, revokedAt: null },
      });
      if (activeTokenCount >= MAX_SA_TOKENS_PER_ACCOUNT) {
        throw new Error("Token limit exceeded");
      }

      // Optimistic lock: only update if still PENDING and belongs to this tenant
      const updated = await tx.accessRequest.updateMany({
        where: { id: requestId, status: "PENDING", tenantId: actor.tenantId },
        data: {
          status: "APPROVED",
          approvedById: session.user.id,
          approvedAt: new Date(),
        },
      });

      if (updated.count === 0) {
        throw new Error("Already processed or wrong tenant");
      }

      // Re-validate scope against SA allowlist at approval time
      const validatedScopes = parseSaTokenScopes(request.requestedScope);
      if (validatedScopes.length === 0) {
        throw new Error("No valid scopes after re-validation");
      }
      const validatedScope = validatedScopes.join(",");

      // Issue a short-lived SA token scoped to validated scopes only
      const plaintext = SA_TOKEN_PREFIX + randomBytes(32).toString("hex");
      const tokenHash = hashToken(plaintext);
      const expiresAt = new Date(Date.now() + ttlSec * 1000);

      const token = await tx.serviceAccountToken.create({
        data: {
          serviceAccountId: request.serviceAccountId,
          tenantId: actor.tenantId,
          tokenHash,
          prefix: plaintext.slice(0, 7),
          name: `JIT-${requestId.slice(0, 8)}`,
          scope: validatedScope,
          expiresAt,
        },
      });

      await tx.accessRequest.update({
        where: { id: requestId },
        data: { grantedTokenId: token.id, grantedTokenTtlSec: ttlSec },
      });

      return { plaintext, expiresAt, tokenId: token.id };
    });
  } catch (err) {
    if (err instanceof Error && err.message === "Already processed or wrong tenant") {
      return NextResponse.json(
        { error: API_ERROR.CONFLICT },
        { status: 409 },
      );
    }
    if (err instanceof Error && err.message === "Token limit exceeded") {
      return NextResponse.json(
        { error: API_ERROR.SA_TOKEN_LIMIT_EXCEEDED },
        { status: 409 },
      );
    }
    if (err instanceof Error && err.message === "No valid scopes after re-validation") {
      return NextResponse.json(
        { error: "INVALID_SCOPE", message: "No valid scopes remain after re-validation" },
        { status: 400 },
      );
    }
    throw err;
  }

  logAudit({
    scope: AUDIT_SCOPE.TENANT,
    action: AUDIT_ACTION.ACCESS_REQUEST_APPROVE,
    userId: session.user.id,
    tenantId: actor.tenantId,
    targetType: AUDIT_TARGET_TYPE.ACCESS_REQUEST,
    targetId: requestId,
    metadata: {
      serviceAccountId: request.serviceAccountId,
      tokenId: result.tokenId,
      ttlSec,
    },
    ...extractRequestMeta(req),
  });
  void dispatchTenantWebhook({
    type: AUDIT_ACTION.ACCESS_REQUEST_APPROVE,
    tenantId: actor.tenantId,
    timestamp: new Date().toISOString(),
    data: { accessRequestId: requestId, serviceAccountId: request.serviceAccountId },
  });

  // Return plaintext token only once — no-store prevents caching of sensitive token
  return NextResponse.json(
    {
      token: result.plaintext,
      expiresAt: result.expiresAt,
      ttlSec,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export const POST = withRequestLog(handlePOST);
