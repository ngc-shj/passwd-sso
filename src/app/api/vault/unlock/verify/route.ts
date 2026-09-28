/**
 * POST /api/vault/unlock/verify
 *
 * Server-side presence proof for a long-lived extension/iOS client token
 * (plan C2). The client already unlocked the vault locally (it holds the
 * decrypted secret key); this call proves that unlock to the server by
 * resubmitting `authHash`, which records presence for the token's family
 * (C4) — the family's idle expiry (C3) is measured from this timestamp,
 * not from refresh activity.
 *
 * Auth: extension/iOS client token only (Bearer + DPoP, scope
 * `vault:unlock-data`). A session-cookie caller has no token row to record
 * presence against, so it is rejected — this endpoint has no role for the
 * web app (SC3). `checkAuth`'s scope is shared with `MCP_SCOPE.VAULT_UNLOCK_DATA`,
 * so an MCP token can also reach this far; it is rejected below alongside
 * IOS_AUTOFILL, since only a BROWSER_EXTENSION/IOS_APP client token has a
 * family to record presence for.
 *
 * Unlike `/api/vault/unlock`, a wrong hash here does NOT feed account
 * lockout (S1) — a token holder without the passphrase must not be able to
 * lock the owner out. It is rate-limited per token family instead.
 */
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { checkAuth } from "@/lib/auth/session/check-auth";
import { EXTENSION_TOKEN_SCOPE } from "@/lib/constants";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { errorResponse, unauthorized } from "@/lib/http/api-response";
import { withRequestLog } from "@/lib/http/with-request-log";
import { getLogger } from "@/lib/logger";
import { checkLockout } from "@/lib/auth/policy/account-lockout";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import { parseBody } from "@/lib/http/parse-body";
import { hexHash } from "@/lib/validations/common";
import { withUserTenantRls } from "@/lib/tenant-context";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { compareVaultAuthHash } from "@/lib/vault/verify-auth-hash";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION } from "@/lib/constants/audit/audit";
import { MS_PER_MINUTE } from "@/lib/constants/time";
import type { ExtensionTokenClientKind } from "@prisma/client";

export const runtime = "nodejs";

const verifySchema = z.object({
  authHash: hexHash,
}).strict();

const PRESENCE_CLIENT_KINDS: ReadonlySet<string> = new Set<ExtensionTokenClientKind>([
  "BROWSER_EXTENSION",
  "IOS_APP",
]);

const verifyLimiter = createRateLimiter({
  windowMs: 5 * MS_PER_MINUTE,
  max: 5,
  failClosedOnRedisError: true,
});

async function handlePOST(request: NextRequest) {
  const authResult = await checkAuth(request, { scope: EXTENSION_TOKEN_SCOPE.VAULT_UNLOCK_DATA });
  if (!authResult.ok) return authResult.response;

  // A session cookie has no token row to record presence against — this
  // endpoint has no role for the web app.
  if (authResult.auth.type === "session") {
    return unauthorized();
  }
  // Only a browser-extension or iOS-app client token has a family to record
  // presence for. IOS_AUTOFILL (upload-only, no unlock UI) and any other
  // Bearer type that happens to carry this scope (e.g. an MCP token — the
  // scope string is shared with MCP_SCOPE.VAULT_UNLOCK_DATA) are refused.
  // Allowlist, not denylist: a client kind added to the enum later must not
  // gain presence recording (idle extension) without a decision here.
  if (authResult.auth.type !== "token") {
    return errorResponse(API_ERROR.FORBIDDEN);
  }
  if (!PRESENCE_CLIENT_KINDS.has(authResult.auth.clientKind)) {
    return errorResponse(API_ERROR.FORBIDDEN);
  }
  const { userId, tenantId, tokenId, familyId, clientKind } = authResult.auth;

  const result = await parseBody(request, verifySchema);
  if (!result.ok) return result.response;

  // Lockout check — before rate limiter and passphrase verification. A
  // locked account must not leak whether the presented hash was correct.
  const lockoutStatus = await checkLockout(userId);
  if (lockoutStatus.locked) {
    return errorResponse(API_ERROR.ACCOUNT_LOCKED, undefined, {
      lockedUntil: lockoutStatus.lockedUntil,
    });
  }

  // Per-family limiter (not per-user): a stolen token guessing the passphrase
  // is bounded per family without letting one abusive family exhaust the
  // budget for the user's other, legitimate families.
  const blocked = await checkRateLimitOrFail({
    req: request,
    limiter: verifyLimiter,
    key: `rl:vault_unlock_verify:${familyId}`,
    scope: "vault.unlock_verify",
    userId,
    tenantId,
  });
  if (blocked) return blocked;

  const user = await withUserTenantRls(userId, async () =>
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        vaultSetupAt: true,
        masterPasswordServerHash: true,
        masterPasswordServerSalt: true,
      },
    }),
  );

  if (!user?.vaultSetupAt || !user.masterPasswordServerHash || !user.masterPasswordServerSalt) {
    return errorResponse(API_ERROR.VAULT_NOT_SETUP);
  }
  // Snapshot narrowed (non-null) values — TS does not retain the guard's
  // narrowing through the whole `user` object passed to another function.
  const { masterPasswordServerHash, masterPasswordServerSalt } = user;

  if (!compareVaultAuthHash(result.data.authHash, { masterPasswordServerHash, masterPasswordServerSalt })) {
    // No recordFailure/resetLockout (S1) — this path never feeds lockout.
    await logAuditAsync({
      ...personalAuditBase(request, userId),
      tenantId,
      action: AUDIT_ACTION.VAULT_UNLOCK_FAILED,
      metadata: { source: "client_token", clientKind },
    });
    return errorResponse(API_ERROR.AUTH_HASH_MISMATCH);
  }

  // Success: record presence on the presenting row only. expiresAt is NOT
  // recomputed here — it takes effect at the next rotation (C3/C4).
  await withBypassRls(prisma, async (tx) =>
    tx.extensionToken.update({
      where: { id: tokenId },
      data: { lastPresenceAt: new Date() },
    }),
  BYPASS_PURPOSE.TOKEN_LIFECYCLE);

  getLogger().info({ userId, clientKind }, "vault.unlock.verify.success");

  return NextResponse.json({ verified: true });
}

export const POST = withRequestLog(handlePOST);
