/**
 * Delegation session management.
 * POST: Create a new delegation session (browser sends decrypted entries)
 * GET: List active delegation sessions for the current user
 * DELETE: Bulk revoke all active delegation sessions (called on vault lock)
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { assertOrigin } from "@/lib/auth/csrf";
import { prisma } from "@/lib/prisma";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { resolveUserTenantId } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/with-request-log";
import { logAuditAsync, personalAuditBase, tenantAuditBase } from "@/lib/audit";
import { AUDIT_ACTION } from "@/lib/constants";
import { MCP_SCOPE } from "@/lib/constants/mcp";
import { API_ERROR } from "@/lib/api-error-codes";
import { errorResponse, unauthorized, rateLimited } from "@/lib/api-response";
import { parseBody } from "@/lib/parse-body";
import { createRateLimiter } from "@/lib/rate-limit";
import { MS_PER_MINUTE } from "@/lib/constants/time";
import {
  DELEGATION_DEFAULT_TTL_SEC,
  DELEGATION_MAX_TTL_SEC,
  DELEGATION_MAX_ENTRIES,
  DELEGATION_MIN_TTL_SEC,
  storeDelegationEntries,
  evictDelegationRedisKeys,
  revokeAllDelegationSessions,
} from "@/lib/auth/delegation";
import type { DelegationMetadata } from "@/lib/auth/delegation";

export const runtime = "nodejs";

const delegationRateLimiter = createRateLimiter({
  windowMs: 15 * MS_PER_MINUTE,
  max: 10,
});

const createDelegationSchema = z.object({
  mcpTokenId: z.string().uuid(),
  ttlSeconds: z.number().int().min(DELEGATION_MIN_TTL_SEC).max(DELEGATION_MAX_TTL_SEC).optional(),
  note: z.string().max(255).optional(),
  entries: z
    .array(
      z.object({
        id: z.string().uuid(),
        title: z.string().max(200),
        username: z.string().max(200).nullish(),
        urlHost: z.string().max(200).nullish(),
        tags: z.array(z.string()).max(20).nullish(),
      }),
    )
    .min(1)
    .max(DELEGATION_MAX_ENTRIES),
});

async function handlePOST(request: NextRequest) {
  const originError = assertOrigin(request);
  if (originError) return originError;

  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const userId = session.user.id;
  const tenantId = await resolveUserTenantId(userId);
  if (!tenantId) {
    return errorResponse(API_ERROR.NO_TENANT, 403);
  }

  // Rate limit
  const rateLimitResult = await delegationRateLimiter.check(`delegation:create:${userId}`);
  if (!rateLimitResult.allowed) {
    return rateLimited(rateLimitResult.retryAfterMs);
  }

  const result = await parseBody(request, createDelegationSchema);
  if (!result.ok) return result.response;

  // Extract metadata entries — no secrets in request body
  const { mcpTokenId, ttlSeconds, note, entries } = result.data;
  const metadataEntries: DelegationMetadata[] = entries;

  // Verify MCP token belongs to this user's tenant, not expired/revoked, has decrypt scope
  const mcpToken = await withBypassRls(prisma, () =>
    prisma.mcpAccessToken.findFirst({
      where: {
        id: mcpTokenId,
        tenantId,
        userId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true, scope: true, clientId: true },
    }),
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);

  if (!mcpToken) {
    return errorResponse(API_ERROR.MCP_TOKEN_NOT_FOUND, 404);
  }

  const scopes = mcpToken.scope.split(",").map((s) => s.trim());
  const hasDelegationScope =
    scopes.includes(MCP_SCOPE.CREDENTIALS_LIST) ||
    scopes.includes(MCP_SCOPE.CREDENTIALS_USE);
  if (!hasDelegationScope) {
    return errorResponse(API_ERROR.MCP_TOKEN_SCOPE_INSUFFICIENT, 403);
  }

  // Check tenant policy for TTL
  const tenant = await withBypassRls(prisma, () =>
    prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        delegationDefaultTtlSec: true,
        delegationMaxTtlSec: true,
      },
    }),
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);

  const maxTtl = tenant?.delegationMaxTtlSec ?? DELEGATION_MAX_TTL_SEC;
  const defaultTtl = tenant?.delegationDefaultTtlSec ?? DELEGATION_DEFAULT_TTL_SEC;
  const effectiveTtl = Math.min(ttlSeconds ?? defaultTtl, maxTtl);

  // Verify entry ownership (userId + tenantId)
  const entryIds = metadataEntries.map((e) => e.id);
  const ownedEntries = await withBypassRls(prisma, () =>
    prisma.passwordEntry.findMany({
      where: {
        id: { in: entryIds },
        userId,
        tenantId,
        deletedAt: null,
      },
      select: { id: true },
    }),
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);

  const ownedIds = new Set(ownedEntries.map((e) => e.id));
  const missingIds = entryIds.filter((id) => !ownedIds.has(id));
  if (missingIds.length > 0) {
    return errorResponse(API_ERROR.DELEGATION_ENTRIES_NOT_FOUND, 403);
  }

  // Auto-revoke existing delegation for this token (one-active-per-token)
  const existingSession = await withBypassRls(prisma, () =>
    prisma.delegationSession.findFirst({
      where: {
        userId,
        mcpTokenId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    }),
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);

  if (existingSession) {
    await evictDelegationRedisKeys(userId, existingSession.id).catch(() => {});
    await withBypassRls(prisma, () =>
      prisma.delegationSession.updateMany({
        where: { id: existingSession.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);
  }

  // Create delegation session
  const expiresAt = new Date(Date.now() + effectiveTtl * 1000);
  const delegationSession = await withBypassRls(prisma, () =>
    prisma.delegationSession.create({
      data: {
        tenantId,
        userId,
        mcpTokenId,
        entryIds,
        note: note ?? null,
        expiresAt,
      },
    }),
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);

  // Store metadata entries in Redis — rollback DB session on failure
  try {
    await storeDelegationEntries(
      userId,
      delegationSession.id,
      metadataEntries,
      effectiveTtl * 1000,
    );
  } catch {
    await withBypassRls(prisma, () =>
      prisma.delegationSession.delete({ where: { id: delegationSession.id } }),
    BYPASS_PURPOSE.CROSS_TENANT_LOOKUP).catch(() => {});
    return errorResponse(API_ERROR.DELEGATION_STORE_FAILED, 503);
  }

  // Audit log — both personal and tenant scope (no plaintext in metadata!)
  // tenantId is preserved on the PERSONAL emit (helper does not set it for personal scope,
  // but downstream JSON log + test assertions require the field — see plan Pattern 5).
  const auditBody = {
    action: AUDIT_ACTION.DELEGATION_CREATE,
    targetId: delegationSession.id,
    metadata: { entryCount: entryIds.length, mcpClientId: mcpToken.clientId },
  };
  await Promise.all([
    logAuditAsync({ ...personalAuditBase(request, userId), tenantId, ...auditBody }),
    logAuditAsync({ ...tenantAuditBase(request, userId, tenantId), ...auditBody }),
  ]);

  return NextResponse.json({
    delegationSessionId: delegationSession.id,
    expiresAt: expiresAt.toISOString(),
    entryCount: entryIds.length,
  });
}

async function handleGET(_request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const { id: userId } = session.user;
  const tenantId = await resolveUserTenantId(userId);
  if (!tenantId) {
    return errorResponse(API_ERROR.NO_TENANT, 403);
  }

  const sessions = await withBypassRls(prisma, () =>
    prisma.delegationSession.findMany({
      where: {
        userId,
        tenantId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: {
        id: true,
        mcpTokenId: true,
        entryIds: true,
        note: true,
        expiresAt: true,
        createdAt: true,
        mcpAccessToken: {
          select: {
            mcpClient: {
              select: { name: true, clientId: true },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);

  // Also return available MCP tokens with delegation-relevant scopes
  const availableTokens = await withBypassRls(prisma, () =>
    prisma.mcpAccessToken.findMany({
      where: {
        userId,
        tenantId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: {
        id: true,
        scope: true,
        expiresAt: true,
        mcpClient: {
          select: { name: true, clientId: true },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);

  return NextResponse.json({
    sessions: sessions.map((s) => ({
      id: s.id,
      mcpTokenId: s.mcpTokenId,
      mcpClientName: s.mcpAccessToken.mcpClient.name,
      mcpClientId: s.mcpAccessToken.mcpClient.clientId,
      entryCount: s.entryIds.length,
      note: s.note,
      expiresAt: s.expiresAt.toISOString(),
      createdAt: s.createdAt.toISOString(),
    })),
    availableTokens: availableTokens.map((t) => {
      const tokenScopes = t.scope.split(",").map((s) => s.trim());
      return {
        id: t.id,
        mcpClientName: t.mcpClient.name,
        mcpClientId: t.mcpClient.clientId,
        hasDelegationScope:
          tokenScopes.includes(MCP_SCOPE.CREDENTIALS_LIST) ||
          tokenScopes.includes(MCP_SCOPE.CREDENTIALS_USE),
        expiresAt: t.expiresAt.toISOString(),
      };
    }),
  });
}

async function handleDELETE(request: NextRequest) {
  const originError = assertOrigin(request);
  if (originError) return originError;

  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const userId = session.user.id;
  const tenantId = await resolveUserTenantId(userId);
  if (!tenantId) {
    return errorResponse(API_ERROR.NO_TENANT, 403);
  }

  const count = await revokeAllDelegationSessions(userId, tenantId, "vault_lock");

  return NextResponse.json({ revokedCount: count });
}

export const POST = withRequestLog(handlePOST);
export const GET = withRequestLog(handleGET);
export const DELETE = withRequestLog(handleDELETE);
