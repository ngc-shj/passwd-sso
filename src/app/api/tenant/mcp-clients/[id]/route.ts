import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { withBypassRls } from "@/lib/tenant-rls";
import { requireTenantPermission, TenantAuthError } from "@/lib/tenant-auth";
import { logAudit } from "@/lib/audit";
import { AUDIT_SCOPE, AUDIT_ACTION } from "@/lib/constants/audit";
import { AUDIT_TARGET_TYPE } from "@/lib/constants/audit-target";
import { TENANT_PERMISSION } from "@/lib/constants/tenant-permission";
import { MCP_SCOPES } from "@/lib/constants/mcp";
import { z } from "zod";

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  redirectUris: z.array(z.string().url()).min(1).max(10).optional(),
  allowedScopes: z.array(z.enum(MCP_SCOPES as [string, ...string[]])).min(1).optional(),
  isActive: z.boolean().optional(),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let actor;
  try {
    actor = await requireTenantPermission(session.user.id, TENANT_PERMISSION.SERVICE_ACCOUNT_MANAGE);
  } catch (err) {
    if (err instanceof TenantAuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  const client = await withBypassRls(prisma, async () =>
    prisma.mcpClient.findFirst({
      where: { id, tenantId: actor.tenantId },
      select: {
        id: true,
        clientId: true,
        name: true,
        redirectUris: true,
        allowedScopes: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  );

  if (!client) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ client });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let actor;
  try {
    actor = await requireTenantPermission(session.user.id, TENANT_PERMISSION.SERVICE_ACCOUNT_MANAGE);
  } catch (err) {
    if (err instanceof TenantAuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  const existing = await withBypassRls(prisma, async () =>
    prisma.mcpClient.findFirst({ where: { id, tenantId: actor.tenantId } }),
  );
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Validation error", issues: parsed.error.issues }, { status: 400 });

  const data = parsed.data;
  const updateData: Record<string, unknown> = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.redirectUris !== undefined) updateData.redirectUris = data.redirectUris;
  if (data.allowedScopes !== undefined) updateData.allowedScopes = data.allowedScopes.join(",");
  if (data.isActive !== undefined) updateData.isActive = data.isActive;

  const updated = await withBypassRls(prisma, async () =>
    prisma.mcpClient.update({
      where: { id },
      data: updateData,
      select: { id: true, clientId: true, name: true, redirectUris: true, allowedScopes: true, isActive: true, updatedAt: true },
    }),
  );

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
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let actor;
  try {
    actor = await requireTenantPermission(session.user.id, TENANT_PERMISSION.SERVICE_ACCOUNT_MANAGE);
  } catch (err) {
    if (err instanceof TenantAuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  const existing = await withBypassRls(prisma, async () =>
    prisma.mcpClient.findFirst({ where: { id, tenantId: actor.tenantId } }),
  );
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await withBypassRls(prisma, async () =>
    prisma.mcpClient.delete({ where: { id } }),
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
