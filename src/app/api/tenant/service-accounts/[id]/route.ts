import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { requireTenantPermission } from "@/lib/auth/tenant-auth";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { parseBody } from "@/lib/http/parse-body";
import { TENANT_PERMISSION } from "@/lib/constants/auth/tenant-permission";
import { AUDIT_ACTION, AUDIT_TARGET_TYPE } from "@/lib/constants";
import { withTenantRls } from "@/lib/tenant-rls";
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse, handleAuthError, notFound, unauthorized } from "@/lib/http/api-response";
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
    return handleAuthError(err);
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
    return handleAuthError(err);
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
      return errorResponse(API_ERROR.SA_NAME_CONFLICT, 409);
    }
    throw err;
  }

  await logAuditAsync({
    ...tenantAuditBase(req, session.user.id, actor.tenantId),
    action: AUDIT_ACTION.SERVICE_ACCOUNT_UPDATE,
    targetType: AUDIT_TARGET_TYPE.SERVICE_ACCOUNT,
    targetId: id,
    metadata: result.data,
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

  // Hard-delete: cascade removes tokens and access requests automatically
  await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.serviceAccount.delete({
      where: { id },
    }),
  );

  await logAuditAsync({
    ...tenantAuditBase(req, session.user.id, actor.tenantId),
    action: AUDIT_ACTION.SERVICE_ACCOUNT_DELETE,
    targetType: AUDIT_TARGET_TYPE.SERVICE_ACCOUNT,
    targetId: id,
  });

  return NextResponse.json({ success: true });
}

export const GET = withRequestLog(handleGET);
export const PUT = withRequestLog(handlePUT);
export const DELETE = withRequestLog(handleDELETE);
