import { type NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { withTenantRls } from "@/lib/tenant-rls";
import { requireTenantPermission, TenantAuthError } from "@/lib/tenant-auth";
import { logAudit } from "@/lib/audit";
import { AUDIT_SCOPE, AUDIT_ACTION } from "@/lib/constants/audit";
import { AUDIT_TARGET_TYPE } from "@/lib/constants/audit-target";
import { TENANT_PERMISSION } from "@/lib/constants/tenant-permission";
import { MCP_SCOPES } from "@/lib/constants/mcp";
import { API_ERROR } from "@/lib/api-error-codes";
import { errorResponse, unauthorized, notFound, zodValidationError } from "@/lib/api-response";
import { z } from "zod";

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

export async function GET(
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
    if (err instanceof TenantAuthError) {
      return errorResponse(err.message, err.status);
    }
    throw err;
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

export async function PUT(
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
    if (err instanceof TenantAuthError) {
      return errorResponse(err.message, err.status);
    }
    throw err;
  }

  const existing = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.mcpClient.findFirst({ where: { id, tenantId: actor.tenantId } }),
  );
  if (!existing) return notFound();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(API_ERROR.INVALID_JSON, 400);
  }

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return zodValidationError(parsed.error);

  const data = parsed.data;
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

  logAudit({
    scope: AUDIT_SCOPE.TENANT,
    action: AUDIT_ACTION.MCP_CLIENT_UPDATE,
    userId: session.user.id,
    tenantId: actor.tenantId,
    targetType: AUDIT_TARGET_TYPE.MCP_CLIENT,
    targetId: id,
    metadata: data as Record<string, unknown>,
  });

  return NextResponse.json({ client: updated });
}

export async function DELETE(
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
    if (err instanceof TenantAuthError) {
      return errorResponse(err.message, err.status);
    }
    throw err;
  }

  const existing = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.mcpClient.findFirst({ where: { id, tenantId: actor.tenantId } }),
  );
  if (!existing) return notFound();

  await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.mcpClient.delete({ where: { id, tenantId: actor.tenantId } }),
  );

  logAudit({
    scope: AUDIT_SCOPE.TENANT,
    action: AUDIT_ACTION.MCP_CLIENT_DELETE,
    userId: session.user.id,
    tenantId: actor.tenantId,
    targetType: AUDIT_TARGET_TYPE.MCP_CLIENT,
    targetId: id,
    metadata: { name: existing.name },
  });

  return NextResponse.json({ ok: true });
}
