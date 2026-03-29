/**
 * GET /api/vault/delegation/check
 *
 * Authorization check endpoint for the decrypt agent.
 * Returns whether a specific entry is delegated to a specific MCP token.
 * The agent calls this before every decrypt operation (no caching).
 *
 * Auth: session cookie OR Bearer token (extension/API key).
 */

import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { authOrToken } from "@/lib/auth-or-token";
import { logAudit } from "@/lib/audit";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants/audit";
import { createRateLimiter } from "@/lib/rate-limit";
import { extractClientIp } from "@/lib/ip-access";

const checkRateLimiter = createRateLimiter({ windowMs: 60_000, max: 120 });

const checkParamsSchema = z.object({
  mcpTokenId: z.string().uuid(),
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

  const userId = authResult.userId;

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
    mcpTokenId: url.searchParams.get("mcpTokenId"),
    entryId: url.searchParams.get("entryId"),
  });
  if (!parsed.success) {
    return NextResponse.json({ authorized: false, reason: "invalid_params" }, { status: 400 });
  }

  const { mcpTokenId, entryId } = parsed.data;

  // Single-query: find active delegation session AND check entryId in one DB call
  const { prisma } = await import("@/lib/prisma");
  const { withBypassRls } = await import("@/lib/tenant-rls");

  const session = await withBypassRls(prisma, () =>
    prisma.delegationSession.findFirst({
      where: {
        userId,
        mcpTokenId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true, expiresAt: true, entryIds: true },
      orderBy: { createdAt: "desc" },
    }),
  );

  if (!session) {
    return NextResponse.json({ authorized: false, reason: "no_session" }, { status: 403 });
  }

  if (!session.entryIds.includes(entryId)) {
    return NextResponse.json({ authorized: false, reason: "entry_not_delegated" }, { status: 403 });
  }

  // Lightweight audit (success only — failed checks are visible via rate limit and 403 responses)
  logAudit({
    action: AUDIT_ACTION.DELEGATION_CHECK,
    scope: AUDIT_SCOPE.PERSONAL,
    userId,
    targetId: entryId,
    metadata: { mcpTokenId, sessionId: session.id },
    ip: extractClientIp(request),
    userAgent: request.headers.get("user-agent"),
  });

  return NextResponse.json({
    authorized: true,
    sessionId: session.id,
    expiresAt: session.expiresAt.toISOString(),
  });
}
