/**
 * GET /api/vault/delegation/check
 *
 * Authorization check endpoint for the decrypt agent.
 * Returns whether a specific entry is delegated for a specific MCP client.
 * The agent calls this before every decrypt operation (no caching).
 *
 * Auth: session cookie OR Bearer token (extension/API key).
 */

import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { authOrToken, hasUserId } from "@/lib/auth/auth-or-token";
import { enforceAccessRestriction } from "@/lib/auth/access-restriction";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION } from "@/lib/constants/audit";
import { MCP_CLIENT_ID_PREFIX } from "@/lib/constants/mcp";
import { createRateLimiter } from "@/lib/security/rate-limit";

const checkRateLimiter = createRateLimiter({ windowMs: 60_000, max: 120 });

const checkParamsSchema = z.object({
  clientId: z.string().startsWith(MCP_CLIENT_ID_PREFIX).max(100),
  entryId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
});

export async function GET(request: NextRequest) {
  // Accept both session cookie and Bearer token (CLI agent uses Bearer)
  const authResult = await authOrToken(request);
  if (!authResult) {
    return NextResponse.json({ authorized: false, reason: "unauthorized" }, { status: 401 });
  }
  if (authResult.type === "scope_insufficient") {
    return NextResponse.json({ authorized: false, reason: "unauthorized" }, { status: 403 });
  }
  if (!hasUserId(authResult)) {
    return NextResponse.json({ authorized: false, reason: "unauthorized" }, { status: 403 });
  }

  const userId = authResult.userId;

  // Tenant network-boundary enforcement for non-session auth. Session
  // already passed the middleware check; Bearer (extension / api_key /
  // mcp_token) bypassed middleware and must be re-checked here.
  if (authResult.type !== "session") {
    const tenantIdOverride =
      authResult.type === "api_key" || authResult.type === "mcp_token"
        ? authResult.tenantId
        : undefined;
    const denied = await enforceAccessRestriction(request, userId, tenantIdOverride);
    if (denied) return denied;
  }

  // Rate limit per user
  const rl = await checkRateLimiter.check(`delegation:check:${userId}`);
  if (!rl.allowed) {
    return NextResponse.json(
      { authorized: false, reason: "rate_limit" },
      { status: 429, headers: { "Retry-After": String(Math.ceil((rl.retryAfterMs ?? 60000) / 1000)) } },
    );
  }

  // Parse query params
  const url = new URL(request.url);
  const parsed = checkParamsSchema.safeParse({
    clientId: url.searchParams.get("clientId"),
    entryId: url.searchParams.get("entryId"),
  });
  if (!parsed.success) {
    return NextResponse.json({ authorized: false, reason: "invalid_params" }, { status: 400 });
  }

  const { clientId, entryId } = parsed.data;

  // Find active delegation session via MCP client's public clientId
  const { prisma } = await import("@/lib/prisma");
  const { withBypassRls, BYPASS_PURPOSE } = await import("@/lib/tenant-rls");

  const session = await withBypassRls(prisma, () =>
    prisma.delegationSession.findFirst({
      where: {
        userId,
        mcpAccessToken: {
          mcpClient: { clientId },
        },
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true, expiresAt: true, entryIds: true },
      orderBy: { createdAt: "desc" },
    }),
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);

  if (!session) {
    return NextResponse.json({ authorized: false, reason: "no_session" }, { status: 403 });
  }

  if (!session.entryIds.includes(entryId)) {
    return NextResponse.json({ authorized: false, reason: "entry_not_delegated" }, { status: 403 });
  }

  // Lightweight audit (success only)
  await logAuditAsync({
    ...personalAuditBase(request, userId),
    action: AUDIT_ACTION.DELEGATION_CHECK,
    targetId: entryId,
    metadata: { clientId, sessionId: session.id },
  });

  return NextResponse.json({
    authorized: true,
    sessionId: session.id,
    expiresAt: session.expiresAt.toISOString(),
  });
}
