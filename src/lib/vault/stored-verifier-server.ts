import type { NextRequest } from "next/server";
import { verifyPassphraseVerifier } from "@/lib/crypto/crypto-server";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION } from "@/lib/constants";

export type StoredVerifierCheck = "ok" | "not-set" | "wrong";

/**
 * Check a client verifier hash against a user's stored verifier HMAC (the
 * passphrase verifier or the recovery-key verifier), dual-version: against the
 * pepper version it was stored under. A stored version whose pepper is not
 * configured is "wrong" to the caller, and writes a VERIFIER_PEPPER_MISSING
 * tenant audit so operators see the misconfiguration. Each route maps the
 * result to its own error codes, inside `if (result !== "ok")` so that only
 * "ok" reaches the write: a lost or mistyped mapping then refuses with the
 * other error code instead of falling through to the mutation.
 */
export async function checkStoredVerifier(
  request: NextRequest,
  params: {
    userId: string;
    tenantId: string;
    clientVerifierHash: string;
    storedHmac: string | null;
    storedVersion: number;
  },
): Promise<StoredVerifierCheck> {
  const { userId, tenantId, clientVerifierHash, storedHmac, storedVersion } = params;
  if (!storedHmac) return "not-set";

  const result = verifyPassphraseVerifier(clientVerifierHash, storedHmac, storedVersion);
  if (result.ok) return "ok";
  if (result.reason === "MISSING_PEPPER_VERSION") {
    await logAuditAsync({
      ...tenantAuditBase(request, userId, tenantId),
      action: AUDIT_ACTION.VERIFIER_PEPPER_MISSING,
      metadata: { storedVersion },
    });
  }
  return "wrong";
}
