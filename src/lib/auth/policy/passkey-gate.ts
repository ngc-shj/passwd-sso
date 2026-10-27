import type { NextRequest } from "next/server";
import { logAuditAsync, tenantAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION } from "@/lib/constants/audit/audit";
import { createRateLimiter } from "@/lib/security/rate-limit";
import {
  derivePasskeyState,
  passkeyEnforcementBlocks,
  PASSKEY_AUDIT_DEDUP_MS,
} from "@/lib/auth/policy/passkey-enforcement";

/**
 * Per-use passkey gate for user-bound bearer credentials (API keys, operator
 * tokens, extension-row tokens). This module is outside the proxy import
 * graph; the audit module it writes through is not — the proxy reaches it via
 * `src/lib/proxy/session-passkey-gate.ts`.
 *
 * Called from inside each validator, which is what makes the gate structural:
 * it runs before every caller's scope, clientKind and network checks, so a
 * blocked member's request answers PASSKEY_REQUIRED even where those would
 * also have refused it.
 */

export const PASSKEY_GATE_CREDENTIAL = {
  API_KEY: "api_key",
  OPERATOR_TOKEN: "operator_token",
  EXTENSION_TOKEN: "extension_token",
} as const;

export type PasskeyGateCredential =
  (typeof PASSKEY_GATE_CREDENTIAL)[keyof typeof PASSKEY_GATE_CREDENTIAL];

// Bounds the durable audit write on the refusal arm, not the refusal: every
// blocked request is denied, but each credential writes at most one row per
// window. Redis-shared across processes. Deliberately NOT failClosedOnRedisError:
// a Redis outage falls back to memory and keeps writing rows instead of none.
const auditLimiter = createRateLimiter({
  windowMs: PASSKEY_AUDIT_DEDUP_MS,
  max: 1,
});

/**
 * Whether the tenant's passkey requirement refuses this credential now.
 * Re-derives the state from the DB on every call, in its own
 * PASSKEY_ENFORCEMENT_STATE bypass — the validators' membership grant does not
 * cover `tenant` or `webAuthnCredential`. A derivation error propagates: the
 * request fails closed.
 */
export async function passkeyGateBlocks(args: {
  req: NextRequest;
  userId: string;
  tenantId: string;
  credential: PasskeyGateCredential;
  credentialId: string;
}): Promise<boolean> {
  const { req, userId, tenantId, credential, credentialId } = args;

  const state = await derivePasskeyState({ userId, tenantId });
  if (!passkeyEnforcementBlocks(state)) return false;

  const limited = await auditLimiter.check(
    `rl:passkey_gate_audit:${credential}:${credentialId}`,
  );
  if (limited.allowed) {
    await logAuditAsync({
      ...tenantAuditBase(req, userId, tenantId),
      action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED,
      metadata: { blockedPath: credential, credentialId },
    });
  }
  return true;
}
