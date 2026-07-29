/**
 * Emit AUTH_LOGIN_FAILURE audit event (C11 / OWASP A09-1).
 *
 * Identifier is hashed with HMAC(pepper, email + ":" + tenantId) truncated to
 * 16 hex chars (64 bits). Tenant binding prevents cross-tenant correlation of
 * the same email's failures. Raw email is never persisted.
 *
 * Per-tenant binding: tenantId="" is used when the failure occurs before a
 * tenant can be determined (e.g., unknown email, magic link entry). This
 * yields a stable global hash for that email across pre-tenant failures.
 * `identifierHashScope` records which binding produced the hash — see
 * IDENTIFIER_HASH_SCOPE below. The field never claims a binding for a hash
 * that does not exist: it is null when there was no email to hash at all.
 *
 * Pepper resolution (C8):
 *   1. AUDIT_IDENTIFIER_PEPPER           — explicit override
 *   2. AUTH_SECRET (>= 32 chars)         — HKDF-derived, domain-separated
 *   3. neither                           — no hash is computed
 * Unlike src/lib/auth/session/session-cache.ts, there is no dev fallback to
 * another real secret: that fallback exists to preserve digest compatibility
 * with pre-existing rows, a requirement this module does not have. Emitting
 * an unkeyed record is the honest branch.
 */

import { createHmac, hkdfSync } from "node:crypto";
import { logAuditAsync } from "@/lib/audit/audit";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants";
import { ACTOR_TYPE } from "@/lib/constants/audit/audit";
import { SYSTEM_ACTOR_ID } from "@/lib/constants/app";
import { MAX_TENANT_CLAIM_LENGTH } from "@/lib/validations/common.server";
import { getLogger } from "@/lib/logger";

export type AuthLoginFailureReason =
  | "unknown_email"
  | "tenant_mismatch"
  | "provider_error"
  | "magic_link_expired"
  | "credential_mismatch"
  | "tenant_claim_unmapped";

export type AuthProvider =
  | "google"
  | "nodemailer"
  | "saml"
  | "passkey"
  | "credentials"
  | "unknown";

/**
 * Which binding produced `identifierHash`, recorded on the audit row itself so
 * two hashes of the same email are only ever compared when they were computed
 * the same way. Round 1 found the two pre-existing `tenant_mismatch` emit sites
 * already disagreed on whether to pass a tenantId, so the binding has to be a
 * property of the record rather than a convention.
 */
export const IDENTIFIER_HASH_SCOPE = {
  /** Bound to a known tenant — comparable only within that tenant. */
  TENANT: "tenant",
  /** No tenant known at failure time — a stable global hash for that email. */
  GLOBAL: "global",
  /** No key material at all (see getIdentifierPepper): no hash was computed. */
  UNKEYED: "unkeyed",
} as const;

export type IdentifierHashScope =
  (typeof IDENTIFIER_HASH_SCOPE)[keyof typeof IDENTIFIER_HASH_SCOPE];

const IDENTIFIER_PEPPER_INFO = "audit-identifier-pepper-v1";
// Matches envSchema's production floor for AUTH_SECRET (superRefine, prod-only —
// the field itself is .optional()), checked again here because this module
// runs regardless of NODE_ENV.
const MIN_AUTH_SECRET_LENGTH = 32;

// Memoised pepper, derived on first use rather than at module load so the
// "no pepper configured" warning reflects the branch actually taken.
// undefined = not yet derived; null = derived, no key material available.
let identifierPepper: Buffer | null | undefined;
let warnedNoPepper = false;

function getIdentifierPepper(): Buffer | null {
  if (identifierPepper !== undefined) return identifierPepper;

  const explicit = process.env.AUDIT_IDENTIFIER_PEPPER;
  if (explicit) {
    identifierPepper = Buffer.from(explicit, "utf8");
    return identifierPepper;
  }

  const authSecret = process.env.AUTH_SECRET;
  if (authSecret && authSecret.length >= MIN_AUTH_SECRET_LENGTH) {
    // HKDF-domain-separate so AUTH_SECRET is never used verbatim as the HMAC key.
    const okm = hkdfSync("sha256", authSecret, "", IDENTIFIER_PEPPER_INFO, 32);
    identifierPepper = Buffer.from(okm);
    return identifierPepper;
  }

  if (!warnedNoPepper) {
    warnedNoPepper = true;
    getLogger().warn(
      "AUDIT_IDENTIFIER_PEPPER not configured and AUTH_SECRET unavailable/too short; auth-failure identifier hashes are unkeyed",
    );
  }
  identifierPepper = null;
  return null;
}

function hashIdentifier(email: string, tenantId: string, pepper: Buffer): string {
  return createHmac("sha256", pepper)
    .update(`${email.toLowerCase()}:${tenantId}`)
    .digest("hex")
    .slice(0, 16);
}

export async function emitAuthLoginFailure(args: {
  email: string | null;
  tenantId?: string | null;
  provider: AuthProvider;
  reason: AuthLoginFailureReason;
  userId?: string | null;
  claim?: string | null;
}): Promise<void> {
  let identifierHash: string | null = null;
  let identifierHashScope: IdentifierHashScope | null = null;

  if (args.email) {
    const pepper = getIdentifierPepper();
    if (pepper) {
      identifierHash = hashIdentifier(args.email, args.tenantId ?? "", pepper);
      identifierHashScope = args.tenantId
        ? IDENTIFIER_HASH_SCOPE.TENANT
        : IDENTIFIER_HASH_SCOPE.GLOBAL;
    } else {
      identifierHashScope = IDENTIFIER_HASH_SCOPE.UNKEYED;
    }
  }

  const metadata: Record<string, unknown> = {
    provider: args.provider,
    reason: args.reason,
    identifierHash,
    identifierHashScope,
  };
  if (args.claim != null) {
    metadata.claim = args.claim.slice(0, MAX_TENANT_CLAIM_LENGTH);
  }

  await logAuditAsync({
    scope: AUDIT_SCOPE.PERSONAL,
    // SYSTEM actor: failed sign-in has no authenticated user yet.
    userId: args.userId ?? SYSTEM_ACTOR_ID,
    actorType: ACTOR_TYPE.SYSTEM,
    metadata,
    action: AUDIT_ACTION.AUTH_LOGIN_FAILURE,
  });
}
