import { type NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { withTenantRls } from "@/lib/tenant-rls";
import { requireTenantPermission } from "@/lib/auth/access/tenant-auth";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION } from "@/lib/constants/audit/audit";
import { AUDIT_TARGET_TYPE } from "@/lib/constants/audit/audit-target";
import { TENANT_PERMISSION } from "@/lib/constants/auth/tenant-permission";
import { MCP_SCOPES } from "@/lib/constants/auth/mcp";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { errorResponse, handleAuthError, notFound, unauthorized } from "@/lib/http/api-response";
import { parseBody } from "@/lib/http/parse-body";
import { z } from "zod";
import { withRequestLog } from "@/lib/http/with-request-log";

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  redirectUris: z.array(
    z.string().url().refine(
      (u) => {
        try {
          const url = new URL(u);
          return url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost");
        } catch { return false; }
      },
      { message: "redirect_uri must use https:// or http://localhost" },
    ),
  ).min(1).max(10).optional(),
  allowedScopes: z.array(z.enum(MCP_SCOPES as [string, ...string[]])).min(1).optional(),
  isActive: z.boolean().optional(),
});

async function handleGET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.id) return unauthorized();

  let actor;
  try {
    actor = await requireTenantPermission(session.user.id, TENANT_PERMISSION.SERVICE_ACCOUNT_MANAGE);
  } catch (err) {
    return handleAuthError(err);
  }

  const client = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.mcpClient.findFirst({
      where: { id, tenantId: actor.tenantId },
      select: {
        id: true,
        clientId: true,
        name: true,
        redirectUris: true,
        allowedScopes: true,
        isActive: true,
        isDcr: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  );

  if (!client) return notFound();
  return NextResponse.json({ client });
}

async function handlePUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.id) return unauthorized();

  let actor;
  try {
    actor = await requireTenantPermission(session.user.id, TENANT_PERMISSION.SERVICE_ACCOUNT_MANAGE);
  } catch (err) {
    return handleAuthError(err);
  }

  const existing = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.mcpClient.findFirst({ where: { id, tenantId: actor.tenantId } }),
  );
  if (!existing) return notFound();

  const result = await parseBody(req, updateSchema);
  if (!result.ok) return result.response;
  const data = result.data;
  const updateData: Record<string, unknown> = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.redirectUris !== undefined) updateData.redirectUris = data.redirectUris;
  if (data.allowedScopes !== undefined) updateData.allowedScopes = data.allowedScopes.join(",");
  if (data.isActive !== undefined) updateData.isActive = data.isActive;

  let updated;
  try {
    updated = await withTenantRls(prisma, actor.tenantId, async () =>
      prisma.mcpClient.update({
        where: { id },
        data: updateData,
        select: { id: true, clientId: true, name: true, redirectUris: true, allowedScopes: true, isActive: true, isDcr: true, updatedAt: true },
      }),
    );
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return errorResponse(API_ERROR.MCP_CLIENT_NAME_CONFLICT, 409);
    }
    throw err;
  }

  await logAuditAsync({
    ...tenantAuditBase(req, session.user.id, actor.tenantId),
    action: AUDIT_ACTION.MCP_CLIENT_UPDATE,
    targetType: AUDIT_TARGET_TYPE.MCP_CLIENT,
    targetId: id,
    // Spread known schema fields explicitly so future updateSchema
    // additions do not silently expand the audit payload.
    metadata: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.redirectUris !== undefined && { redirectUris: data.redirectUris }),
      ...(data.allowedScopes !== undefined && { allowedScopes: data.allowedScopes }),
      ...(data.isActive !== undefined && { isActive: data.isActive }),
    },
  });

  return NextResponse.json({ client: updated });
}

async function handleDELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.id) return unauthorized();

  let actor;
  try {
    actor = await requireTenantPermission(session.user.id, TENANT_PERMISSION.SERVICE_ACCOUNT_MANAGE);
  } catch (err) {
    return handleAuthError(err);
  }

  const existing = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.mcpClient.findFirst({ where: { id, tenantId: actor.tenantId } }),
  );
  if (!existing) return notFound();

  await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.mcpClient.delete({ where: { id, tenantId: actor.tenantId } }),
  );

  await logAuditAsync({
    ...tenantAuditBase(req, session.user.id, actor.tenantId),
    action: AUDIT_ACTION.MCP_CLIENT_DELETE,
    targetType: AUDIT_TARGET_TYPE.MCP_CLIENT,
    targetId: id,
    metadata: { name: existing.name },
  });

  return NextResponse.json({ ok: true });
}

export const GET = withRequestLog(handleGET);
export const PUT = withRequestLog(handlePUT);
export const DELETE = withRequestLog(handleDELETE);
