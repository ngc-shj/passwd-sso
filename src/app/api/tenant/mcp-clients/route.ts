import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { withTenantRls } from "@/lib/tenant-rls";
import { requireTenantPermission } from "@/lib/auth/tenant-auth";
import { randomBytes } from "node:crypto";
import { hashToken } from "@/lib/crypto/crypto-server";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit";
import { AUDIT_ACTION } from "@/lib/constants/audit";
import { AUDIT_TARGET_TYPE } from "@/lib/constants/audit-target";
import { TENANT_PERMISSION } from "@/lib/constants/tenant-permission";
import { MAX_MCP_CLIENTS_PER_TENANT, MCP_SCOPES } from "@/lib/constants/mcp";
import { API_ERROR } from "@/lib/api-error-codes";
import { errorResponse, handleAuthError, unauthorized } from "@/lib/api-response";
import { parseBody } from "@/lib/parse-body";
import { z } from "zod";
import { withRequestLog } from "@/lib/with-request-log";

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

async function handleGET(_req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return unauthorized();

  let actor;
  try {
    actor = await requireTenantPermission(session.user.id, TENANT_PERMISSION.SERVICE_ACCOUNT_MANAGE);
  } catch (err) {
    return handleAuthError(err);
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
          select: { userId: true, lastUsedAt: true },
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
    clients: clients.map(({ accessTokens, ...rest }) => {
      // Find the most recent lastUsedAt from all access tokens
      const mostRecentLastUsed = accessTokens
        .map(t => t.lastUsedAt)
        .filter((d): d is Date => d !== null)
        .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

      return {
        ...rest,
        lastUsedAt: mostRecentLastUsed?.toISOString() ?? null,
        connectedUsers: accessTokens.map((t) => {
          const u = userMap.get(t.userId!);
          return { name: u?.name ?? null, email: u?.email ?? null };
        }),
      };
    }),
  });
}

async function handlePOST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return unauthorized();

  let actor;
  try {
    actor = await requireTenantPermission(session.user.id, TENANT_PERMISSION.SERVICE_ACCOUNT_MANAGE);
  } catch (err) {
    return handleAuthError(err);
  }

  const result = await parseBody(req, createSchema);
  if (!result.ok) return result.response;
  const { name, redirectUris, allowedScopes } = result.data;

  // Enforce tenant limit
  const count = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.mcpClient.count({ where: { tenantId: actor.tenantId } }),
  );
  if (count >= MAX_MCP_CLIENTS_PER_TENANT) {
    return errorResponse(API_ERROR.MCP_CLIENT_LIMIT_EXCEEDED, 422, { message: `Maximum ${MAX_MCP_CLIENTS_PER_TENANT} MCP clients per tenant` });
  }

  // Check name uniqueness
  const existing = await withTenantRls(prisma, actor.tenantId, async () =>
    prisma.mcpClient.findFirst({ where: { tenantId: actor.tenantId, name } }),
  );
  if (existing) {
    return errorResponse(API_ERROR.MCP_CLIENT_NAME_CONFLICT, 409);
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

  await logAuditAsync({
    ...tenantAuditBase(req, session.user.id, actor.tenantId),
    action: AUDIT_ACTION.MCP_CLIENT_CREATE,
    targetType: AUDIT_TARGET_TYPE.MCP_CLIENT,
    targetId: client.id,
    metadata: { name },
  });

  // Return clientSecret only on creation — never again
  return NextResponse.json({ client: { ...client, clientSecret } }, { status: 201 });
}

export const GET = withRequestLog(handleGET);
export const POST = withRequestLog(handlePOST);
