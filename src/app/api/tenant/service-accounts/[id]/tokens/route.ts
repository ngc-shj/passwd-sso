import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { hashToken } from "@/lib/crypto/crypto-server";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { requireTenantPermission } from "@/lib/auth/tenant-auth";
import { API_ERROR } from "@/lib/api-error-codes";
import { parseBody } from "@/lib/parse-body";
import { TENANT_PERMISSION } from "@/lib/constants/tenant-permission";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { withTenantRls } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/with-request-log";
import { handleAuthError, notFound, unauthorized } from "@/lib/api-response";
import {
  SA_TOKEN_PREFIX,
  MAX_SA_TOKENS_PER_ACCOUNT,
} from "@/lib/constants/service-account";
import { saTokenCreateSchema } from "@/lib/validations/service-account";
import { MS_PER_DAY } from "@/lib/constants/time";

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

  const sa = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.serviceAccount.findUnique({
      where: { id },
      select: { id: true, tenantId: true },
    }),
  );

  if (!sa || sa.tenantId !== actor.tenantId) {
    return notFound();
  }

  const tokens = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.serviceAccountToken.findMany({
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

  const { id } = await params;

  const sa = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.serviceAccount.findUnique({
      where: { id },
      select: { id: true, tenantId: true, isActive: true, tenant: { select: { saTokenMaxExpiryDays: true } } },
    }),
  );

  if (!sa || sa.tenantId !== actor.tenantId) {
    return notFound();
  }

  if (!sa.isActive) {
    return NextResponse.json(
      { error: API_ERROR.SA_NOT_FOUND, message: "Service account is inactive" },
      { status: 409 },
    );
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
    token = await withTenantRls(prisma, actor.tenantId, async () =>
      prisma.$transaction(async (tx) => {
        const activeTokenCount = await tx.serviceAccountToken.count({
          where: { serviceAccountId: id, revokedAt: null },
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
      return NextResponse.json(
        { error: API_ERROR.SA_TOKEN_LIMIT_EXCEEDED },
        { status: 409 },
      );
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
