import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { withTenantRls } from "@/lib/tenant-rls";
import { requireTenantPermission, TenantAuthError } from "@/lib/tenant-auth";
import { randomBytes } from "node:crypto";
import { hashToken } from "@/lib/crypto-server";
import { logAudit } from "@/lib/audit";
import { AUDIT_SCOPE, AUDIT_ACTION } from "@/lib/constants/audit";
import { AUDIT_TARGET_TYPE } from "@/lib/constants/audit-target";
import { TENANT_PERMISSION } from "@/lib/constants/tenant-permission";
import { MAX_MCP_CLIENTS_PER_TENANT, MCP_SCOPES } from "@/lib/constants/mcp";
import { z } from "zod";

const createSchema = z.object({
  name: z.string().min(1).max(100),
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
  ).min(1).max(10),
  allowedScopes: z.array(z.enum(MCP_SCOPES as [string, ...string[]])).min(1),
});

export async function GET(_req: NextRequest) {
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

  const clients = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.mcpClient.findMany({
      where: { tenantId: actor.tenantId },
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
        accessTokens: {
          where: { revokedAt: null, expiresAt: { gt: new Date() }, userId: { not: null } },
          select: { userId: true },
          distinct: ["userId"],
        },
      },
      orderBy: { createdAt: "desc" },
    }),
  );

  // Batch-fetch connected user names
  const allUserIds = [...new Set(clients.flatMap((c) => c.accessTokens.map((t) => t.userId!)))];
  const users = allUserIds.length > 0
    ? await withTenantRls(prisma, actor.tenantId, () =>
        prisma.user.findMany({
          where: { id: { in: allUserIds } },
          select: { id: true, name: true, email: true },
        }),
      )
    : [];
  const userMap = new Map(users.map((u) => [u.id, u]));

  return NextResponse.json({
    clients: clients.map(({ accessTokens, ...rest }) => ({
      ...rest,
      connectedUsers: accessTokens.map((t) => {
        const u = userMap.get(t.userId!);
        return { name: u?.name ?? u?.email ?? "Unknown" };
      }),
    })),
  });
}

export async function POST(req: NextRequest) {
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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation error", issues: parsed.error.issues }, { status: 400 });
  }

  const { name, redirectUris, allowedScopes } = parsed.data;

  // Enforce tenant limit
  const count = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.mcpClient.count({ where: { tenantId: actor.tenantId } }),
  );
  if (count >= MAX_MCP_CLIENTS_PER_TENANT) {
    return NextResponse.json(
      { error: "MCP_CLIENT_LIMIT_EXCEEDED", message: `Maximum ${MAX_MCP_CLIENTS_PER_TENANT} MCP clients per tenant` },
      { status: 422 },
    );
  }

  // Check name uniqueness
  const existing = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.mcpClient.findFirst({ where: { tenantId: actor.tenantId, name } }),
  );
  if (existing) {
    return NextResponse.json({ error: "MCP_CLIENT_NAME_CONFLICT" }, { status: 409 });
  }

  // Generate client credentials
  const clientId = "mcpc_" + randomBytes(16).toString("hex");
  const clientSecret = randomBytes(32).toString("base64url");
  const clientSecretHash = hashToken(clientSecret);

  const client = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.mcpClient.create({
      data: {
        tenantId: actor.tenantId,
        clientId,
        clientSecretHash,
        name,
        redirectUris,
        allowedScopes: allowedScopes.join(","),
        createdById: session.user.id,
      },
      select: {
        id: true,
        clientId: true,
        name: true,
        redirectUris: true,
        allowedScopes: true,
        isActive: true,
        isDcr: true,
        createdAt: true,
      },
    }),
  );

  logAudit({
    scope: AUDIT_SCOPE.TENANT,
    action: AUDIT_ACTION.MCP_CLIENT_CREATE,
    userId: session.user.id,
    tenantId: actor.tenantId,
    targetType: AUDIT_TARGET_TYPE.MCP_CLIENT,
    targetId: client.id,
    metadata: { name },
  });

  // Return clientSecret only on creation — never again
  return NextResponse.json({ client: { ...client, clientSecret } }, { status: 201 });
}
