/**
 * GET /api/vault/delegation/check
 *
 * Authorization check endpoint for the decrypt agent.
 * Returns whether a specific entry is delegated for a specific MCP client.
 * The agent calls this before every decrypt operation (no caching).
 *
 * Auth: session cookie OR MCP token with `delegation:check` scope.
 * Extension tokens, API keys, and SA tokens are not accepted.
 */

import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { authOrToken, hasUserId } from "@/lib/auth/session/auth-or-token";
import { MCP_SCOPE, MCP_CLIENT_ID_PREFIX } from "@/lib/constants/auth/mcp";
import { enforceAccessRestriction } from "@/lib/auth/policy/access-restriction";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION } from "@/lib/constants/audit/audit";
import { createRateLimiter } from "@/lib/security/rate-limit";

const checkRateLimiter = createRateLimiter({ windowMs: 60_000, max: 120 });

const checkParamsSchema = z.object({
  clientId: z.string().startsWith(MCP_CLIENT_ID_PREFIX).max(100),
  entryId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
});

export async function GET(request: NextRequest) {
  // Accept session cookie or MCP token with delegation:check scope.
  // Extension tokens, API keys, and SA tokens are intentionally rejected.
  const authResult = await authOrToken(request, MCP_SCOPE.DELEGATION_CHECK);
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
  // already passed the middleware check; the scope gate (C4) limits the
  // reachable bearer types to mcp_token only — api_key / extension_token
  // cannot carry `delegation:check` and are rejected upstream as
  // `scope_insufficient` at line 36. service_account tokens are rejected
  // even earlier by the `hasUserId` gate at line 37-39 because SA tokens
  // carry `serviceAccountId`, not `userId`.
  if (authResult.type !== "session") {
    const tenantIdOverride =
      authResult.type === "mcp_token" ? authResult.tenantId : undefined;
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

  // Intra-user IDOR guard: an MCP token may only check its own client's
  // delegation. Without this, a user-X token issued for client A could
  // probe delegation state of the same user's other MCP client B.
  if (authResult.type === "mcp_token" && authResult.mcpClientId !== clientId) {
    return NextResponse.json({ authorized: false, reason: "unauthorized" }, { status: 403 });
  }

  // Find active delegation session via MCP client's public clientId
  const { prisma } = await import("@/lib/prisma");
  const { withBypassRls, BYPASS_PURPOSE } = await import("@/lib/tenant-rls");

  const session = await withBypassRls(prisma, () =>
    prisma.delegationSession.findFirst({
      where: {
        userId,
        mcpAccessToken: {
          // When auth is MCP token, also bind the lookup to the calling
          // token's tokenId — defense-in-depth on top of the clientId
          // equality check above.
          ...(authResult.type === "mcp_token" ? { tokenId: authResult.tokenId } : {}),
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
