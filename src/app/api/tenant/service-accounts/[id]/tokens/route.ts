import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/crypto/crypto-server";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { requireTenantPermission } from "@/lib/auth/access/tenant-auth";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { parseBody } from "@/lib/http/parse-body";
import { TENANT_PERMISSION } from "@/lib/constants/auth/tenant-permission";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { withTenantRls } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse, errorResponseWithMessage, handleAuthError, notFound, unauthorized } from "@/lib/http/api-response";
import {
  SA_TOKEN_PREFIX,
  MAX_SA_TOKENS_PER_ACCOUNT,
} from "@/lib/constants/auth/service-account";
import { saTokenCreateSchema } from "@/lib/validations/service-account";
import { MS_PER_DAY } from "@/lib/constants/time";
import { requireRecentCurrentAuthMethod } from "@/lib/auth/session/recent-current-auth-method";

type Params = { params: Promise<{ id: string }> };

export const runtime = "nodejs";

// GET /api/tenant/service-accounts/[id]/tokens — List tokens for a service account
async function handleGET(req: NextRequest, { params }: Params) {
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

  const { id } = await params;

  const sa = await withTenantRls(prisma, actor.tenantId, async (tx) =>
    tx.serviceAccount.findUnique({
      where: { id },
      select: { id: true, tenantId: true },
    }),
  );

  if (!sa || sa.tenantId !== actor.tenantId) {
    return notFound();
  }

  const tokens = await withTenantRls(prisma, actor.tenantId, async (tx) =>
    tx.serviceAccountToken.findMany({
      where: { serviceAccountId: id },
      select: {
        id: true,
        name: true,
        scope: true,
        prefix: true,
        expiresAt: true,
        createdAt: true,
        revokedAt: true,
        lastUsedAt: true,
      },
      orderBy: { createdAt: "desc" },
    }),
  );

  return NextResponse.json(tokens);
}

// POST /api/tenant/service-accounts/[id]/tokens — Create a new token for a service account
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
    return handleAuthError(err);
  }

  const stepUpError = await requireRecentCurrentAuthMethod(req);
  if (stepUpError) return stepUpError;

  const { id } = await params;

  const sa = await withTenantRls(prisma, actor.tenantId, async (tx) =>
    tx.serviceAccount.findUnique({
      where: { id },
      select: { id: true, tenantId: true, isActive: true, tenant: { select: { saTokenMaxExpiryDays: true } } },
    }),
  );

  if (!sa || sa.tenantId !== actor.tenantId) {
    return notFound();
  }

  if (!sa.isActive) {
    return errorResponseWithMessage(API_ERROR.SA_INACTIVE, "Service account is inactive");
  }

  const result = await parseBody(req, saTokenCreateSchema);
  if (!result.ok) return result.response;

  const plaintext = SA_TOKEN_PREFIX + randomBytes(32).toString("hex");
  const prefix = plaintext.slice(0, 7);
  const tokenHash = hashToken(plaintext);
  const scope = result.data.scope.join(",");

  // Enforce tenant-level SA token max expiry policy
  let expiresAt = new Date(result.data.expiresAt);
  const maxExpiryDays = sa.tenant?.saTokenMaxExpiryDays;
  if (maxExpiryDays != null) {
    const maxExpiresAt = new Date(Date.now() + maxExpiryDays * MS_PER_DAY);
    if (expiresAt > maxExpiresAt) {
      expiresAt = maxExpiresAt;
    }
  }

  let token;
  try {
    token = await withTenantRls(prisma, actor.tenantId, async (tx) =>
      prisma.$transaction(async (tx) => {
        // "Active" = not revoked AND not expired, matching extension/operator/
        // SCIM token limit checks — expired-but-not-revoked tokens are unusable
        // and must not consume a slot.
        const activeTokenCount = await tx.serviceAccountToken.count({
          where: { serviceAccountId: id, revokedAt: null, expiresAt: { gt: new Date() } },
        });
        if (activeTokenCount >= MAX_SA_TOKENS_PER_ACCOUNT) {
          throw new Error("Token limit exceeded");
        }
        return tx.serviceAccountToken.create({
          data: {
            serviceAccountId: id,
            tenantId: actor.tenantId,
            tokenHash,
            prefix,
            name: result.data.name,
            scope,
            expiresAt,
          },
        });
      }),
    );
  } catch (err) {
    if (err instanceof Error && err.message === "Token limit exceeded") {
      return errorResponse(API_ERROR.SA_TOKEN_LIMIT_EXCEEDED);
    }
    throw err;
  }

  await logAuditAsync({
    ...tenantAuditBase(req, session.user.id, actor.tenantId),
    action: AUDIT_ACTION.SERVICE_ACCOUNT_TOKEN_CREATE,
    targetType: AUDIT_TARGET_TYPE.SERVICE_ACCOUNT_TOKEN,
    targetId: token.id,
    metadata: { serviceAccountId: id, name: result.data.name, scope },
  });

  // Return plaintext token only once — no-store prevents caching of sensitive token
  return NextResponse.json(
    {
      id: token.id,
      token: plaintext,
      name: token.name,
      scope: token.scope,
      prefix: token.prefix,
      expiresAt: token.expiresAt,
      createdAt: token.createdAt,
    },
    { status: 201, headers: { "Cache-Control": "no-store" } },
  );
}

export const GET = withRequestLog(handleGET);
export const POST = withRequestLog(handlePOST);
