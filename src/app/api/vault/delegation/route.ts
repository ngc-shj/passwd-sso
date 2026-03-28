/**
 * Delegation session management.
 * POST: Create a new delegation session (browser sends decrypted entries)
 * GET: List active delegation sessions for the current user
 * DELETE: Bulk revoke all active delegation sessions (called on vault lock)
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { assertOrigin } from "@/lib/csrf";
import { prisma } from "@/lib/prisma";
import { withBypassRls } from "@/lib/tenant-rls";
import { resolveUserTenantId } from "@/lib/tenant-context";
import { withRequestLog } from "@/lib/with-request-log";
import { logAudit } from "@/lib/audit";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
import { MCP_SCOPE } from "@/lib/constants/mcp";
import { createRateLimiter } from "@/lib/rate-limit";
import {
  DELEGATION_DEFAULT_TTL_SEC,
  DELEGATION_MAX_TTL_SEC,
  DELEGATION_MAX_ENTRIES,
  DELEGATION_MIN_TTL_SEC,
  storeDelegationEntries,
  evictDelegationRedisKeys,
  revokeAllDelegationSessions,
} from "@/lib/delegation";
import type { DelegationEntryData } from "@/lib/delegation";

export const runtime = "nodejs";

const delegationRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
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
        username: z.string().max(200).nullable().optional(),
        password: z.string().max(1024).nullable().optional(),
        url: z.string().max(512).nullable().optional(),
        notes: z.string().max(2000).nullable().optional(),
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
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = session.user.id;
  const tenantId = await resolveUserTenantId(userId);
  if (!tenantId) {
    return NextResponse.json({ error: "No tenant" }, { status: 403 });
  }

  // Rate limit
  const rateLimitResult = await delegationRateLimiter.check(`delegation:create:${userId}`);
  if (!rateLimitResult.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": String(Math.ceil((rateLimitResult.retryAfterMs ?? 60000) / 1000)) } },
    );
  }

  const body = await request.json();
  const parsed = createDelegationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.issues },
      { status: 400 },
    );
  }

  // Extract plaintext entries immediately — never pass to logging
  const { mcpTokenId, ttlSeconds, note, entries } = parsed.data;
  const plaintextEntries: DelegationEntryData[] = entries;

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
  );

  if (!mcpToken) {
    return NextResponse.json({ error: "MCP token not found or expired" }, { status: 404 });
  }

  const scopes = mcpToken.scope.split(",").map((s) => s.trim());
  if (!scopes.includes(MCP_SCOPE.CREDENTIALS_DECRYPT)) {
    return NextResponse.json(
      { error: "MCP token does not have credentials:decrypt scope" },
      { status: 403 },
    );
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
  );

  const maxTtl = tenant?.delegationMaxTtlSec ?? DELEGATION_MAX_TTL_SEC;
  const defaultTtl = tenant?.delegationDefaultTtlSec ?? DELEGATION_DEFAULT_TTL_SEC;
  const effectiveTtl = Math.min(ttlSeconds ?? defaultTtl, maxTtl);

  // Verify entry ownership (userId + tenantId)
  const entryIds = plaintextEntries.map((e) => e.id);
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
  );

  const ownedIds = new Set(ownedEntries.map((e) => e.id));
  const missingIds = entryIds.filter((id) => !ownedIds.has(id));
  if (missingIds.length > 0) {
    return NextResponse.json(
      { error: "Some entries not found or not accessible" },
      { status: 403 },
    );
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
  );

  if (existingSession) {
    await evictDelegationRedisKeys(userId, existingSession.id).catch(() => {});
    await withBypassRls(prisma, () =>
      prisma.delegationSession.update({
        where: { id: existingSession.id },
        data: { revokedAt: new Date() },
      }),
    );
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
  );

  // Store entries in Redis — rollback DB session on failure
  try {
    await storeDelegationEntries(
      userId,
      delegationSession.id,
      plaintextEntries,
      effectiveTtl * 1000,
    );
  } catch {
    await withBypassRls(prisma, () =>
      prisma.delegationSession.delete({ where: { id: delegationSession.id } }),
    ).catch(() => {});
    return NextResponse.json(
      { error: "Failed to store delegation entries" },
      { status: 503 },
    );
  }

  // Audit log (no plaintext in metadata!)
  logAudit({
    scope: AUDIT_SCOPE.PERSONAL,
    action: AUDIT_ACTION.DELEGATION_CREATE,
    userId,
    tenantId,
    targetId: delegationSession.id,
    metadata: { entryCount: entryIds.length, mcpClientId: mcpToken.clientId },
    ip: request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip"),
    userAgent: request.headers.get("user-agent"),
  });

  return NextResponse.json({
    delegationSessionId: delegationSession.id,
    expiresAt: expiresAt.toISOString(),
    entryCount: entryIds.length,
  });
}

async function handleGET(_request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: userId } = session.user;

  const sessions = await withBypassRls(prisma, () =>
    prisma.delegationSession.findMany({
      where: {
        userId,
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
  );

  // Also return available MCP tokens with credentials:decrypt scope
  const availableTokens = await withBypassRls(prisma, () =>
    prisma.mcpAccessToken.findMany({
      where: {
        userId,
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
  );

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
    availableTokens: availableTokens.map((t) => ({
      id: t.id,
      mcpClientName: t.mcpClient.name,
      mcpClientId: t.mcpClient.clientId,
      hasDecryptScope: t.scope.split(",").map((s) => s.trim()).includes("credentials:decrypt"),
      expiresAt: t.expiresAt.toISOString(),
    })),
  });
}

async function handleDELETE(request: NextRequest) {
  const originError = assertOrigin(request);
  if (originError) return originError;

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = session.user.id;
  const tenantId = await resolveUserTenantId(userId);
  if (!tenantId) {
    return NextResponse.json({ error: "No tenant" }, { status: 403 });
  }

  const count = await revokeAllDelegationSessions(userId, tenantId, "vault_lock");

  return NextResponse.json({ revokedCount: count });
}

export const POST = withRequestLog(handlePOST);
export const GET = withRequestLog(handleGET);
export const DELETE = withRequestLog(handleDELETE);
