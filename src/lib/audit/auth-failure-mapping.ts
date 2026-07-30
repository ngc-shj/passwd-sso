/**
 * Translation of internal identifiers into the AUTH_LOGIN_FAILURE audit
 * vocabulary (C11 / OWASP A09-1).
 *
 * Its own module because the two sign-in refusal sites have to agree on it and
 * neither can import the other: `src/auth.ts`'s signIn callback refuses for a
 * user that already exists, `src/lib/auth/session/auth-adapter.ts`'s
 * `createUser` refuses on the first-ever sign-in (no user row yet), and
 * `src/auth.ts` already imports the adapter — the reverse edge would close a
 * cycle through the module-level `NextAuth()` call.
 */

import type { ClaimTenantResolution } from "@/lib/tenant/tenant-management";
import type {
  AuthLoginFailureReason,
  AuthProvider,
} from "@/lib/audit/auth-failure";

/** The refusal arms of `findOrCreateTenantForClaim` — everything but a tenant. */
export type ClaimResolutionRefusalKind = Exclude<ClaimTenantResolution["kind"], "tenant">;

/**
 * The refusal decided one layer earlier, at the ingest boundary: the IdP
 * asserted a claim and `extractTenantClaimValue` refused the VALUE, so no
 * resolution ever runs (round-3 M1). It belongs in the same table because the
 * two sign-in refusal sites have to dispatch it exactly as they dispatch the
 * resolution arms — the defect was that they dispatched it as "no claim".
 */
export type ClaimIngestRefusalKind = "claim_malformed";

/** Every arm that can deny a sign-in over a claim, from either adjudicator. */
export type ClaimRefusalKind = ClaimResolutionRefusalKind | ClaimIngestRefusalKind;

/**
 * Deny reason per refusal arm of `findOrCreateTenantForClaim` (round-1 M2).
 * The two arms have different triggers and different operator remedies, and
 * collapsing them — as the single `null` used to — hid the one that matters
 * most:
 *   claim_taken   — a revoked tenant_claims row owns the claim (D2). Emitted
 *                   as tenant_claim_unmapped because that is the reason
 *                   `tenant-domain unmapped` filters on; without it a
 *                   revoked-claim lockout is invisible to the tool this PR
 *                   ships for exactly that diagnosis.
 *   claim_collision — an existing tenant's external_id folds onto the claim
 *                   (round-2 F-A). Also tenant_claim_unmapped: the remedy is
 *                   an explicit `tenant-domain add` naming the tenant that
 *                   should own the free UNIQUE(claim) slot, which is the
 *                   remedy `unmapped` exists to point at.
 *   claim_invalid — the claim fails storableClaimSchema (SC9). Nothing is
 *                   registrable, so "register the claim" is not the remedy;
 *                   tenant_mismatch, as row 8b always specified.
 *   claim_malformed — the IdP's asserted VALUE was refused at ingest
 *                   (round-3 M1). Same remedy class as claim_invalid — the
 *                   value is unstorable, so `tenant-domain add` cannot help
 *                   and surfacing it in `unmapped` would point the operator
 *                   at a command that must refuse. The fix is at the IdP, and
 *                   `metadata.claimRefusal` — its OWN key, not a marker inside
 *                   the attacker-supplied `metadata.claim` (round-5 S2) —
 *                   names which rule the value broke. tenant_mismatch.
 *
 * The `satisfies` below is what forces a new arm to be classified here rather
 * than defaulting to whatever an index lookup happens to return — it is how
 * claim_collision was caught the day it was added.
 */
export const CLAIM_REFUSAL_REASON = {
  claim_taken: "tenant_claim_unmapped",
  claim_collision: "tenant_claim_unmapped",
  claim_invalid: "tenant_mismatch",
  claim_malformed: "tenant_mismatch",
} as const satisfies Record<
  ClaimRefusalKind,
  Extract<AuthLoginFailureReason, "tenant_mismatch" | "tenant_claim_unmapped">
>;

// Auth.js provider ids that map onto the audit enum. A table rather than the
// chained ternary it replaces, because two emit sites now need the same
// mapping and a second spelling of it is a drift waiting to happen. Providers
// absent here (including `passkey`, which signs in through its own route and
// never reaches an Auth.js provider id) fall through to "unknown".
// Exported so its test derives the positive cases from the table instead of
// hand-copying them (round-4 T6): a provider added here but not to the test's
// own list was silently untested, which is the same per-sample-versus-derived
// split T9 fixed for the unsafe-character ranges.
export const AUDIT_PROVIDER_BY_ID = {
  google: "google",
  nodemailer: "nodemailer",
  "boxyhq-saml": "saml",
  "saml-jackson": "saml",
  credentials: "credentials",
} as const satisfies Record<string, AuthProvider>;

export function toAuditProvider(
  provider: string | null | undefined,
): AuthProvider {
  if (!provider) return "unknown";
  // hasOwnProperty, not a bare index (round-3 S3-3). An object literal
  // inherits from Object.prototype, so `AUDIT_PROVIDER_BY_ID["constructor"]`
  // — and `toString`, `valueOf`, `__proto__` — resolve to inherited FUNCTIONS,
  // which are truthy, so `?? "unknown"` never fires and the function returns
  // something that is not an AuthProvider at all. That value goes straight
  // into an audit row's `provider` field. The Auth.js provider id is
  // attacker-influenceable at the callback boundary, so this is reachable
  // input, not a theoretical one.
  if (!Object.prototype.hasOwnProperty.call(AUDIT_PROVIDER_BY_ID, provider)) {
    return "unknown";
  }
  return AUDIT_PROVIDER_BY_ID[provider as keyof typeof AUDIT_PROVIDER_BY_ID];
}
