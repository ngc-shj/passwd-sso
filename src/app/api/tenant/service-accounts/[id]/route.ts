import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
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
import { errorResponse, notFound, unauthorized } from "@/lib/api-response";
import { serviceAccountUpdateSchema } from "@/lib/validations/service-account";

type Params = { params: Promise<{ id: string }> };

export const runtime = "nodejs";

// GET /api/tenant/service-accounts/[id] — Get a single service account
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
    if (err instanceof TenantAuthError) {
      return errorResponse(err.message, err.status);
    }
    throw err;
  }

  const { id } = await params;

  const sa = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.serviceAccount.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        description: true,
        identityType: true,
        isActive: true,
        teamId: true,
        tenantId: true,
        createdAt: true,
        updatedAt: true,
        createdBy: { select: { id: true, name: true, email: true } },
        _count: {
          select: {
            tokens: { where: { revokedAt: null } },
          },
        },
      },
    }),
  );

  if (!sa || sa.tenantId !== actor.tenantId) {
    return notFound();
  }

  return NextResponse.json(sa);
}

// PUT /api/tenant/service-accounts/[id] — Update a service account
async function handlePUT(req: NextRequest, { params }: Params) {
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

  const { id } = await params;

  const existing = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.serviceAccount.findUnique({
      where: { id },
      select: { id: true, tenantId: true },
    }),
  );

  if (!existing || existing.tenantId !== actor.tenantId) {
    return notFound();
  }

  const result = await parseBody(req, serviceAccountUpdateSchema);
  if (!result.ok) return result.response;

  let sa;
  try {
    sa = await withTenantRls(prisma, actor.tenantId, async () =>
      prisma.serviceAccount.update({
        where: { id },
        data: {
          ...(result.data.name !== undefined && { name: result.data.name }),
          ...(result.data.description !== undefined && { description: result.data.description }),
          ...(result.data.isActive !== undefined && { isActive: result.data.isActive }),
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

  logAudit({
    scope: AUDIT_SCOPE.TENANT,
    action: AUDIT_ACTION.SERVICE_ACCOUNT_UPDATE,
    userId: session.user.id,
    tenantId: actor.tenantId,
    targetType: AUDIT_TARGET_TYPE.SERVICE_ACCOUNT,
    targetId: id,
    metadata: result.data,
    ...extractRequestMeta(req),
  });
  void dispatchTenantWebhook({
    type: AUDIT_ACTION.SERVICE_ACCOUNT_UPDATE,
    tenantId: actor.tenantId,
    timestamp: new Date().toISOString(),
    data: { serviceAccountId: id },
  });

  return NextResponse.json(sa);
}

// DELETE /api/tenant/service-accounts/[id] — Soft-delete a service account and revoke all its tokens
async function handleDELETE(req: NextRequest, { params }: Params) {
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

  // Hard-delete: cascade removes tokens and access requests automatically
  await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.serviceAccount.delete({
      where: { id },
    }),
  );

  logAudit({
    scope: AUDIT_SCOPE.TENANT,
    action: AUDIT_ACTION.SERVICE_ACCOUNT_DELETE,
    userId: session.user.id,
    tenantId: actor.tenantId,
    targetType: AUDIT_TARGET_TYPE.SERVICE_ACCOUNT,
    targetId: id,
    ...extractRequestMeta(req),
  });
  void dispatchTenantWebhook({
    type: AUDIT_ACTION.SERVICE_ACCOUNT_DELETE,
    tenantId: actor.tenantId,
    timestamp: new Date().toISOString(),
    data: { serviceAccountId: id },
  });

  return NextResponse.json({ success: true });
}

export const GET = withRequestLog(handleGET);
export const PUT = withRequestLog(handlePUT);
export const DELETE = withRequestLog(handleDELETE);
