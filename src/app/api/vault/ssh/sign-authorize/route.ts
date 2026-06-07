/**
 * POST /api/vault/ssh/sign-authorize
 *
 * Per-signature authorization endpoint for the vault SSH agent.
 * The CLI agent calls this before every SIGN_REQUEST operation.
 * Authorized → sign locally. Denied or unreachable → SSH_AGENT_FAILURE.
 *
 * Auth: session cookie OR MCP token with `ssh:sign` scope.
 * Extension tokens, API keys, and SA tokens are not accepted.
 *
 * Security note: per-sign authorize is an honest-agent audit/revocation
 * control. A process already holding the decrypted key can sign locally
 * regardless of this gate — the value is audit completeness and immediate
 * revocation for entries that are archived, trashed, or whose vault is
 * in travel mode.
 */

import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { authOrToken, hasUserId } from "@/lib/auth/session/auth-or-token";
import { MCP_SCOPE } from "@/lib/constants/auth/mcp";
import { enforceAccessRestriction } from "@/lib/auth/policy/access-restriction";
import { logAuditAsync, personalAuditBase, resolveActorType } from "@/lib/audit/audit";
import { AUDIT_ACTION } from "@/lib/constants/audit/audit";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import { MS_PER_MINUTE } from "@/lib/constants/time";

const signRateLimiter = createRateLimiter({
  windowMs: MS_PER_MINUTE,
  max: 120,
  failClosedOnRedisError: true,
});

const signBodySchema = z.object({
  // PasswordEntry id — CUID v1 or UUID (mixed legacy). Intentionally NOT
  // z.string().uuid() to avoid rejecting CUID-format ids.
  keyId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  // "SHA256:<base64>" — client-asserted audit metadata only; not re-verified server-side.
  fingerprint: z.string().max(100),
  // Populated from a verified session-bind@openssh.com exchange on the CLI side.
  // Stored as audit metadata; v1 does not use forwarding flag in authz decisions.
  host: z
    .object({
      hostKeyFingerprint: z.string().max(100),
      forwarded: z.boolean(),
    })
    .optional(),
});

export async function POST(request: NextRequest) {
  // Accept session cookie or MCP token with ssh:sign scope.
  // Extension tokens, API keys, and SA tokens are intentionally rejected.
  const authResult = await authOrToken(request, MCP_SCOPE.SSH_SIGN);
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

  // Tenant network-boundary enforcement for non-session auth.
  if (authResult.type !== "session") {
    const tenantIdOverride =
      authResult.type === "mcp_token" ? authResult.tenantId : undefined;
    const denied = await enforceAccessRestriction(request, userId, tenantIdOverride);
    if (denied) return denied;
  }

  // Rate limit per user: 120/min, fail-closed on Redis unavailability.
  const tenantIdForAudit =
    authResult.type === "mcp_token" ? authResult.tenantId : null;
  const blocked = await checkRateLimitOrFail({
    req: request,
    limiter: signRateLimiter,
    key: `ssh-sign:${userId}`,
    scope: "vault.ssh_sign",
    userId,
    tenantId: tenantIdForAudit,
    envelope: () =>
      NextResponse.json(
        { authorized: false, reason: "service_unavailable" },
        { status: 503, headers: { "Retry-After": "30" } },
      ),
    rateLimitedEnvelope: (retryAfterMs) =>
      NextResponse.json(
        { authorized: false, reason: "rate_limit" },
        {
          status: 429,
          headers: {
            "Retry-After": String(
              retryAfterMs != null && retryAfterMs > 0
                ? Math.ceil(retryAfterMs / 1000)
                : 30,
            ),
          },
        },
      ),
  });
  if (blocked) return blocked;

  // Parse request body
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ authorized: false, reason: "invalid_params" }, { status: 400 });
  }
  const parsed = signBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ authorized: false, reason: "invalid_params" }, { status: 400 });
  }

  const { keyId, fingerprint, host } = parsed.data;

  // Authorization boundary: look up the SSH_KEY entry by userId + keyId.
  // The userId predicate (from the authenticated token, never the body)
  // prevents cross-user IDOR: a keyId owned by another user returns entry_not_found.
  const { prisma } = await import("@/lib/prisma");
  const { withBypassRls, BYPASS_PURPOSE } = await import("@/lib/tenant-rls");

  const entry = await withBypassRls(
    prisma,
    (tx) =>
      tx.passwordEntry.findFirst({
        where: {
          id: keyId,
          userId,
          entryType: "SSH_KEY",
          isArchived: false,
          deletedAt: null,
        },
        select: { id: true },
      }),
    BYPASS_PURPOSE.CROSS_TENANT_LOOKUP,
  );

  const actorType = resolveActorType(authResult);

  if (entry) {
    // Authorized: emit audit row and return success.
    await logAuditAsync({
      ...personalAuditBase(request, userId),
      action: AUDIT_ACTION.SSH_KEY_SIGN,
      actorType,
      targetId: keyId,
      metadata: { fingerprint, host },
    });
    return NextResponse.json({ authorized: true });
  }

  // Entry not found, archived, soft-deleted, wrong type, or owned by another user.
  await logAuditAsync({
    ...personalAuditBase(request, userId),
    action: AUDIT_ACTION.SSH_KEY_SIGN_DENIED,
    actorType,
    targetId: keyId,
    metadata: { fingerprint, host },
  });
  return NextResponse.json(
    { authorized: false, reason: "entry_not_found" },
    { status: 403 },
  );
}
