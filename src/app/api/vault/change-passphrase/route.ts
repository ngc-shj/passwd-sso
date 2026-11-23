import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { hmacVerifier } from "@/lib/crypto/crypto-server";
import { checkStoredVerifier } from "@/lib/vault/stored-verifier-server";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { VERIFIER_VERSION } from "@/lib/crypto/verifier-version";
import { withRequestLog } from "@/lib/http/with-request-log";
import { getLogger } from "@/lib/logger";
import { logAuditAsync, logAuditInTx, personalAuditBase } from "@/lib/audit/audit";
import { withTenantRls } from "@/lib/tenant-rls";
import { AUDIT_ACTION } from "@/lib/constants/audit/audit";
import { withUserTenantRls } from "@/lib/tenant-context";
import { z } from "zod";
import { errorResponse, unauthorized } from "@/lib/http/api-response";
import { checkRateLimitOrFail } from "@/lib/security/rate-limit-audit";
import { parseBody } from "@/lib/http/parse-body";
import { hexIv, hexAuthTag, hexSalt, hexHash, WRAPPED_SECRET_KEY_MAX } from "@/lib/validations/common";
import { MS_PER_MINUTE } from "@/lib/constants/time";
import {
  invalidateUserSessions,
  type InvalidateUserSessionsResult,
} from "@/lib/auth/session/user-session-invalidation";
import { getSessionToken } from "@/app/api/sessions/helpers";
import { errorLogFields } from "@/lib/logger/error-fields";

export const runtime = "nodejs";

const changePassphraseSchema = z.object({
  currentVerifierHash: hexHash,
  encryptedSecretKey: z.string().min(1).max(WRAPPED_SECRET_KEY_MAX),
  secretKeyIv: hexIv,
  secretKeyAuthTag: hexAuthTag,
  accountSalt: hexSalt,
  newVerifierHash: hexHash,
});

const changeLimiter = createRateLimiter({
  windowMs: 15 * MS_PER_MINUTE,
  max: 3,
  failClosedOnRedisError: true,
});

/**
 * POST /api/vault/change-passphrase
 * Change the vault passphrase by re-wrapping the secret key.
 * secretKey itself does NOT change — only the wrapping key changes.
 * keyVersion is NOT bumped. EA grants are NOT affected.
 *
 * Server does not perform decryption verification — the rewrapped data
 * is stored as-is. Correctness is verified at next unlock.
 */
async function handlePOST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return unauthorized();
  }

  const blocked = await checkRateLimitOrFail({
    req: request,
    limiter: changeLimiter,
    key: `rl:vault_change_pass:${session.user.id}`,
    scope: "vault.change_passphrase",
    userId: session.user.id,
  });
  if (blocked) return blocked;

  const result = await parseBody(request, changePassphraseSchema);
  if (!result.ok) return result.response;
  const data = result.data;

  const user = await withUserTenantRls(session.user.id, async () =>
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: {
        vaultSetupAt: true,
        passphraseVerifierHmac: true,
        passphraseVerifierVersion: true,
        accountSalt: true,
        tenantId: true,
      },
    }),
  );

  if (!user?.vaultSetupAt) {
    return errorResponse(API_ERROR.VAULT_NOT_SETUP);
  }

  // Verify current passphrase via verifier (must be set — backfilled during unlock)
  const verifier = await checkStoredVerifier(request, {
    userId: session.user.id,
    tenantId: user.tenantId,
    clientVerifierHash: data.currentVerifierHash,
    storedHmac: user.passphraseVerifierHmac,
    storedVersion: user.passphraseVerifierVersion,
  });
  if (verifier !== "ok") {
    return errorResponse(
      verifier === "not-set" ? API_ERROR.VERIFIER_NOT_SET : API_ERROR.INVALID_PASSPHRASE,
    );
  }

  // Update: re-wrapped secret key + new verifier (keyVersion unchanged). The
  // fact-of-change audit is written in the same transaction, so a passphrase
  // change can never commit without its audit trail (as recovery-key/recover).
  // withTenantRls(tx) with the snapshot's tenantId, which is already in hand,
  // rather than withUserTenantRls, which would resolve the tenant a second time.
  //
  // The verifier was checked against the snapshot read above, in another
  // transaction, so the write is a compare-and-swap on accountSalt — the one
  // column every vault-wrapping writer (setup, change-passphrase, recover,
  // rotate-key, vault reset) moves. Two requests proving the same old
  // passphrase both pass the check; only the first to commit rewraps, and the
  // other gets 409 with no audit row and no session invalidation.
  const committed = await withTenantRls(prisma, user.tenantId, async (tx) => {
    const { count } = await tx.user.updateMany({
      where: { id: session.user.id, accountSalt: user.accountSalt },
      data: {
        accountSalt: data.accountSalt,
        encryptedSecretKey: data.encryptedSecretKey,
        secretKeyIv: data.secretKeyIv,
        secretKeyAuthTag: data.secretKeyAuthTag,
        passphraseVerifierHmac: hmacVerifier(data.newVerifierHash),
        passphraseVerifierVersion: VERIFIER_VERSION,
      },
    });
    if (count === 0) return false;

    await logAuditInTx(tx, user.tenantId, {
      ...personalAuditBase(request, session.user.id),
      action: AUDIT_ACTION.VAULT_PASSPHRASE_CHANGE,
      metadata: { phase: "committed" },
    });
    return true;
  });

  if (!committed) {
    return errorResponse(API_ERROR.VAULT_WRAP_CONFLICT);
  }

  // C6 (OWASP A07-1): invalidate all OTHER sessions + bearer tokens across
  // all tenants. The current device just proved possession of the OLD
  // passphrase, so the requester's session is the legitimate actor —
  // killing it would force confusing re-sign-in UX without adding security
  // (the attack the audit closes is OTHER sessions surviving a known-leak
  // passphrase change). Vault still re-locks because the key wrap changed.
  // Failure here returns 500 — the passphrase change already committed and
  // the client must instruct the user to manually sign out other devices.
  let invalidationResult: InvalidateUserSessionsResult | null = null;
  try {
    invalidationResult = await invalidateUserSessions(session.user.id, {
      allTenants: true,
      reason: "change_passphrase",
      excludeSessionToken: getSessionToken(request),
    });
    if (invalidationResult.cacheTombstoneFailures > 0) {
      getLogger().warn(
        { userId: session.user.id, failures: invalidationResult.cacheTombstoneFailures },
        "vault.changePassphrase.tombstoneFailures",
      );
    }
  } catch (err) {
    getLogger().error(
      { userId: session.user.id, error: errorLogFields(err) },
      "vault.changePassphrase.invalidateFailed",
    );
  }

  // Completion detail (best-effort, as vault/reset and rotate-key): the
  // invalidation outcome is known only after the transaction. Losing this on a
  // crash loses the counts, not the fact-of-change recorded above.
  await logAuditAsync({
    ...personalAuditBase(request, session.user.id),
    action: AUDIT_ACTION.VAULT_PASSPHRASE_CHANGE,
    metadata: {
      phase: "completed",
      invalidationFailed: invalidationResult === null,
      invalidatedSessions: invalidationResult?.sessions ?? null,
      invalidatedExtensionTokens: invalidationResult?.extensionTokens ?? null,
      invalidatedApiKeys: invalidationResult?.apiKeys ?? null,
      invalidatedMcpAccessTokens: invalidationResult?.mcpAccessTokens ?? null,
      invalidatedMcpRefreshTokens: invalidationResult?.mcpRefreshTokens ?? null,
      invalidatedDelegationSessions: invalidationResult?.delegationSessions ?? null,
      invalidatedOperatorTokens: invalidationResult?.operatorTokens ?? null,
      cacheTombstoneFailures: invalidationResult?.cacheTombstoneFailures ?? null,
    },
  });

  if (invalidationResult === null) {
    return errorResponse(API_ERROR.SESSION_INVALIDATE_FAILED);
  }

  getLogger().info({ userId: session.user.id }, "vault.changePassphrase.success");

  return NextResponse.json({ success: true });
}

export const POST = withRequestLog(handlePOST);
