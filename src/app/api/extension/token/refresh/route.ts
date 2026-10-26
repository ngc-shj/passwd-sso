import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateShareToken, hashToken } from "@/lib/crypto/crypto-server";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { errorResponse } from "@/lib/http/api-response";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import { validateExtensionToken, revokeExtensionTokenFamily, EXTENSION_TOKEN_REVOKE_REASON } from "@/lib/auth/tokens/extension-token";
import { computeClientTokenExpiry, getFamilyPresenceAt } from "@/lib/auth/tokens/client-token-expiry";
import { REFRESH_REPLAY_GRACE_MS } from "@/lib/auth/tokens/mobile-token";
import { enforceAccessRestriction } from "@/lib/auth/policy/access-restriction";
import { withUserTenantRls } from "@/lib/tenant-context";
import { withBypassRls } from "@/lib/tenant-rls";
import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
import { withRequestLog } from "@/lib/http/with-request-log";
import { TokenIssueResponseSchema } from "@/lib/validations/extension-token";
import { NO_STORE_HEADERS } from "@/lib/http/cache-headers";
import logger from "@/lib/logger";
import { MS_PER_MINUTE } from "@/lib/constants/time";
import {
  EXTENSION_TOKEN_IDLE_TIMEOUT_DEFAULT,
  EXTENSION_TOKEN_ABSOLUTE_TIMEOUT_DEFAULT,
} from "@/lib/validations/common";

export const runtime = "nodejs";

const refreshLimiter = createRateLimiter({
  windowMs: 15 * MS_PER_MINUTE,
  max: 20,
  failClosedOnRedisError: true,
});

const BEARER_RE = /^Bearer\s+(.+)$/i;

/**
 * Replay detection for a token the validator has already reported REVOKED.
 * `validateExtensionToken` returns early on a revoked row (no `data`), so the
 * route re-hashes the presented bearer and looks the row up directly.
 *
 * A presentation long after the row was revoked — beyond
 * `REFRESH_REPLAY_GRACE_MS`, the window that covers a legitimate client
 * retrying its own just-rotated request after a dropped response — means an
 * attacker is replaying an already-rotated token: revoke the whole family.
 * `revokeExtensionTokenFamily` itself only audits when it actually revoked a
 * live row, so a family that is already dead (logout, overflow, prior replay)
 * stays a silent no-op here. Within the grace window, do nothing (plan §C5).
 */
async function detectRefreshReplay(req: NextRequest): Promise<void> {
  const bearer = req.headers.get("authorization")?.match(BEARER_RE)?.[1]?.trim();
  if (!bearer) return;

  const tokenHash = hashToken(bearer);
  const row = await withBypassRls(prisma, async (tx) =>
    tx.extensionToken.findUnique({
      where: { tokenHash },
      select: { revokedAt: true, familyId: true, userId: true, tenantId: true },
    }),
  BYPASS_GRANT.EXTENSION_TOKEN_LIFECYCLE);

  if (!row?.revokedAt) return; // Not found, or a benign race — nothing to detect.

  if (Date.now() - row.revokedAt.getTime() > REFRESH_REPLAY_GRACE_MS) {
    await revokeExtensionTokenFamily({
      familyId: row.familyId,
      userId: row.userId,
      tenantId: row.tenantId,
      reason: EXTENSION_TOKEN_REVOKE_REASON.REPLAY_DETECTED,
    });
  }
}

/**
 * POST /api/extension/token/refresh
 *
 * Accepts a still-valid Bearer token and issues a new token with fresh TTL.
 * The old token is revoked atomically.
 *
 * Decoupled from the Auth.js web session (C5, FR1): the token's own row
 * carries its tenant, and its family's presence timestamp (C4) — not session
 * liveness — bounds how long it may keep refreshing.
 *
 * Passkey enforcement (C5): the per-use gate now lives inside
 * validateExtensionToken itself, so a blocked member is refused
 * PASSKEY_REQUIRED there, before replay detection or any family check below
 * ever runs — there is no separate inline gate here any more.
 */
async function handlePOST(req: NextRequest) {
  const result = await validateExtensionToken(req);

  if (!result.ok) {
    if (result.error === "EXTENSION_TOKEN_REVOKED") {
      await detectRefreshReplay(req);
    }
    if (result.error === "PASSKEY_REQUIRED") {
      return errorResponse(API_ERROR.PASSKEY_REQUIRED);
    }
    return errorResponse(API_ERROR[result.error], 401);
  }

  const { tokenId, userId, tenantId, scopes, familyId, familyCreatedAt, cnfJkt } = result.data;

  // Tenant network-boundary enforcement comes BEFORE rate limit so an
  // off-network holder of a stolen bearer cannot burn the legitimate
  // user's per-user refresh budget (DoS the live extension). tenantId
  // comes directly from the validated token row.
  const denied = await enforceAccessRestriction(req, userId, tenantId);
  if (denied) return denied;

  const blocked = await checkRateLimitOrFail({
    req,
    limiter: refreshLimiter,
    key: `rl:ext_refresh:${userId}`,
    scope: "extension.token_refresh",
    userId,
    tenantId,
  });
  if (blocked) return blocked;

  // Read tenant extension-token TTL policy. Tenant comes from the token row
  // itself — no Auth.js session lookup (C5, FR1).
  const tenant = await withBypassRls(prisma, async (tx) =>
    tx.tenant.findUnique({
      where: { id: tenantId },
      select: {
        extensionTokenIdleTimeoutMinutes: true,
        extensionTokenAbsoluteTimeoutMinutes: true,
      },
    }),
  BYPASS_GRANT.TOKEN_TENANT_LOOKUP);
  // FAIL-CLOSED: tenantId is FK-backed, so a null tenant row is data
  // corruption, NOT "no policy". These columns are non-nullable with schema
  // defaults, so `?? DEFAULT` only fires on a vanished tenant — where defaulting
  // to the ceiling could refresh a token to a longer TTL than a tenant that had
  // tightened it. Refuse the refresh instead. (Mirrors issueExtensionToken.)
  if (!tenant) {
    throw new Error(
      `extension token refresh: tenant ${tenantId} not found`,
    );
  }
  // Columns are non-nullable with schema defaults; the `?? DEFAULT` is a
  // defensive floor for a field-null that cannot occur in practice.
  const idleMinutes =
    tenant.extensionTokenIdleTimeoutMinutes ?? EXTENSION_TOKEN_IDLE_TIMEOUT_DEFAULT;
  const absoluteMinutes =
    tenant.extensionTokenAbsoluteTimeoutMinutes ??
    EXTENSION_TOKEN_ABSOLUTE_TIMEOUT_DEFAULT;

  const now = new Date();

  // Family absolute timeout enforcement. Pre-migration tokens have null familyId;
  // we refuse to refresh them so every live token eventually converges to a family.
  if (!familyId || !familyCreatedAt) {
    return errorResponse(API_ERROR.EXTENSION_TOKEN_SESSION_EXPIRED);
  }
  const familyAgeMs = now.getTime() - familyCreatedAt.getTime();
  if (familyAgeMs > absoluteMinutes * MS_PER_MINUTE) {
    // Revoke the entire family and audit. Do NOT issue a new token.
    await revokeExtensionTokenFamily({
      familyId,
      userId,
      tenantId,
      reason: EXTENSION_TOKEN_REVOKE_REASON.FAMILY_EXPIRED,
    });
    return errorResponse(API_ERROR.EXTENSION_TOKEN_SESSION_EXPIRED);
  }

  // C4: presence gate. Idle is redefined as "time since the last
  // server-verified vault unlock (presence)", not refresh activity — a token
  // that keeps refreshing itself without ever proving the passphrase again
  // must still die `idle` after the last real unlock.
  const presenceAt = await withBypassRls(prisma, async (tx) =>
    getFamilyPresenceAt(tx, familyId, familyCreatedAt),
  BYPASS_GRANT.EXTENSION_TOKEN_LIFECYCLE);
  if (presenceAt.getTime() + idleMinutes * MS_PER_MINUTE <= now.getTime()) {
    await revokeExtensionTokenFamily({
      familyId,
      userId,
      tenantId,
      reason: EXTENSION_TOKEN_REVOKE_REASON.PRESENCE_EXPIRED,
    });
    return errorResponse(API_ERROR.EXTENSION_TOKEN_SESSION_EXPIRED);
  }

  // Interactive transaction: revoke old (optimistic lock), then create new only if revoke succeeded
  const expiresAt = computeClientTokenExpiry({
    now,
    presenceAt,
    familyCreatedAt,
    idleMinutes,
    absoluteMinutes,
  });
  const plaintext = generateShareToken();
  const newTokenHash = hashToken(plaintext);
  const scopeCsv = scopes.join(",");

  const created = await withUserTenantRls(userId, async () =>
    prisma.$transaction(async (tx) => {
      const revoked = await tx.extensionToken.updateMany({
        where: { id: tokenId, revokedAt: null, expiresAt: { gt: now } },
        data: { revokedAt: now },
      });

      if (revoked.count === 0) {
        return null; // Already revoked by concurrent refresh
      }

      const newToken = await tx.extensionToken.create({
        data: {
          userId,
          tenantId,
          tokenHash: newTokenHash,
          scope: scopeCsv,
          expiresAt,
          // Carry the family forward so the absolute cap persists across rotations
          familyId,
          familyCreatedAt,
          // Carry the presence max forward (C4) — the new row's own future
          // presence writes only ever raise it.
          lastPresenceAt: presenceAt,
          // Carry cnfJkt forward — DPoP binding MUST persist across rotation
          cnfJkt,
        },
        select: { expiresAt: true, scope: true, cnfJkt: true },
      });

      return newToken;
    }),
  );

  if (!created) {
    return errorResponse(API_ERROR.EXTENSION_TOKEN_REVOKED);
  }

  const body = {
    token: plaintext,
    expiresAt: created.expiresAt.toISOString(),
    scope: created.scope.split(","),
    cnfJkt: created.cnfJkt,
  };

  const parsed = TokenIssueResponseSchema.safeParse(body);
  if (!parsed.success) {
    logger.error({ error: parsed.error.message }, "extension token refresh response validation failed");
    return errorResponse(API_ERROR.INTERNAL_ERROR);
  }

  return NextResponse.json(parsed.data, { headers: { ...NO_STORE_HEADERS } });
}

export const POST = withRequestLog(handlePOST);
