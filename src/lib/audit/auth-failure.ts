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
 *   1. AUDIT_IDENTIFIER_PEPPER (>= 32 chars) — explicit override
 *   2. AUTH_SECRET (>= 32 chars)             — HKDF-derived, domain-separated
 *   3. neither                               — no hash is computed
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
import type { ClaimRefusalDiagnosis } from "@/lib/tenant/claim-refusal";
import { getLogger } from "@/lib/logger";

export type AuthLoginFailureReason =
  | "unknown_email"
  | "tenant_mismatch"
  | "provider_error"
  | "magic_link_expired"
  | "credential_mismatch"
  | "tenant_claim_unmapped"
  /**
   * The claim resolved — to `SYSTEM_TENANT_ID`, the encoding of "no owning
   * tenant". A PostgreSQL CHECK refuses the write at that point
   * (`users_not_system_tenant` / `tenant_members_not_system_tenant`), so the
   * sign-in denies and the reason has to say which denial it was.
   *
   * Its own member rather than a reuse of `tenant_claim_unmapped`: the two
   * remedies differ, and `bucketOf` decides the heading from the reason, so
   * borrowing one would file this under a population it is not in. Reachable
   * only out of band — `tenant-domain add` refuses a sentinel target on the
   * resolved id — which is why this member is observability, not a control.
   */
  | "tenant_claim_system_tenant";

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
// runs regardless of NODE_ENV. The same floor applies to the explicit override:
// envSchema narrows AUDIT_IDENTIFIER_PEPPER further (hex64), but this module
// reads process.env directly rather than the validated singleton, so an
// override that never passed the schema still has to be rejected here. A
// one-byte HMAC key is worse than the honest unkeyed branch, because the
// record then claims key material it does not have (round-1 Sec F5).
const MIN_KEY_MATERIAL_LENGTH = 32;

// Memoised pepper, derived on first use rather than at module load so the
// "no pepper configured" warning reflects the branch actually taken.
// undefined = not yet derived; null = derived, no key material available.
let identifierPepper: Buffer | null | undefined;
let warnedNoPepper = false;

function getIdentifierPepper(): Buffer | null {
  if (identifierPepper !== undefined) return identifierPepper;

  const explicit = process.env.AUDIT_IDENTIFIER_PEPPER;
  if (explicit && explicit.length >= MIN_KEY_MATERIAL_LENGTH) {
    identifierPepper = Buffer.from(explicit, "utf8");
    return identifierPepper;
  }

  const authSecret = process.env.AUTH_SECRET;
  if (authSecret && authSecret.length >= MIN_KEY_MATERIAL_LENGTH) {
    // HKDF-domain-separate so AUTH_SECRET is never used verbatim as the HMAC key.
    const okm = hkdfSync("sha256", authSecret, "", IDENTIFIER_PEPPER_INFO, 32);
    identifierPepper = Buffer.from(okm);
    return identifierPepper;
  }

  if (!warnedNoPepper) {
    warnedNoPepper = true;
    getLogger().warn(
      "AUDIT_IDENTIFIER_PEPPER and AUTH_SECRET are both unavailable or too short; auth-failure identifier hashes are unkeyed",
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
  /** The value the IdP asserted. Attacker-influenceable by definition. */
  claim?: string | null;
  /**
   * Why this deployment refused the asserted value — machine-generated,
   * printable ASCII, and never a value any party supplied.
   *
   * Its own metadata key rather than a prefix inside `claim` (round-5 S2):
   * the two are read by an operator deciding which remedy applies, and a
   * marker that lives inside an attacker-controlled string can be asserted
   * verbatim by that attacker. `refused: contains U+200B` passes the ingest
   * boundary as an ordinary claim — verified — so the prefix was a forgeable
   * trust signal in a runbook that told operators to trust it.
   *
   * The BRAND is round-6 SEC-R6-3. A separate key stops the IdP forging the
   * signal from the value side; it does not stop a caller in this repo from
   * writing an arbitrary string into it, which is what the comment below used
   * to be standing in for. `ClaimRefusalDiagnosis` can only come out of
   * `claimRefusal()` in `@/lib/tenant/claim-refusal`, so the guarantee is now
   * a compile error rather than a convention.
   */
  claimRefusal?: ClaimRefusalDiagnosis | null;
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
    // `.slice` cuts at a UTF-16 code-unit boundary, so an astral character
    // straddling the cap leaves a LONE SURROGATE. Postgres rejects one in
    // `jsonb` (22P02), and logAuditAsync swallows the failure into a
    // dead-letter — the whole row is lost, silently. That is round-4 S1: it
    // was reachable through the claim rendering this round removed, and it is
    // guarded here as well because this is the shared boundary every caller
    // crosses and nothing enforces the "already ≤ cap" precondition the safety
    // of the bare slice depended on.
    metadata.claim = args.claim.slice(0, MAX_TENANT_CLAIM_LENGTH).toWellFormed();
  }
  if (args.claimRefusal != null) {
    // No slice or well-formedness guard needed, and the reason is now
    // structural rather than a survey of callers: `ClaimRefusalDiagnosis` comes
    // only from `claimRefusal()`, whose two producers (the ingest boundary and
    // `storableClaimSchema`'s own issue text) emit bounded printable ASCII.
    // Deliberately NOT defended here anyway: a guard would suggest this field
    // takes untrusted input, and the whole point of separating it from `claim`
    // is that it does not.
    metadata.claimRefusal = args.claimRefusal;
  }

  await logAuditAsync({
    scope: AUDIT_SCOPE.PERSONAL,
    // SYSTEM actor: failed sign-in has no authenticated user yet.
    userId: args.userId ?? SYSTEM_ACTOR_ID,
    actorType: ACTOR_TYPE.SYSTEM,
    // Forwarding the tenant is what files the denial under the tenant it is
    // ABOUT. logAuditAsync -> resolveTenantId returns params.tenantId directly
    // when present; without it, a denial with no user row (every first-ever
    // sign-in, where userId falls back to SYSTEM_ACTOR_ID and no such users row
    // exists) resolves none and is recorded under SYSTEM_TENANT_ID — the
    // encoding of "no owning tenant". The row is written either way; what is
    // lost is the attribution, so `tenant-domain unmapped` (which groups by
    // tenant_id) shows the failure under `__system__` instead of under the
    // tenant whose claim was refused. It used to be lost entirely — the emit
    // dead-lettered and wrote no row at all — which made this comment's older
    // wording ("OBSERVABLE, not merely emitted") true for a stronger reason
    // than it is now. `?? undefined` because AuditLogParams.tenantId is
    // optional, not nullable.
    tenantId: args.tenantId ?? undefined,
    metadata,
    action: AUDIT_ACTION.AUTH_LOGIN_FAILURE,
  });
}
