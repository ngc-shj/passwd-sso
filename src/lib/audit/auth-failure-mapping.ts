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
export type ClaimRefusalKind = Exclude<ClaimTenantResolution["kind"], "tenant">;

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
 *
 * The `satisfies` below is what forces a new arm to be classified here rather
 * than defaulting to whatever an index lookup happens to return — it is how
 * claim_collision was caught the day it was added.
 */
export const CLAIM_REFUSAL_REASON = {
  claim_taken: "tenant_claim_unmapped",
  claim_collision: "tenant_claim_unmapped",
  claim_invalid: "tenant_mismatch",
} as const satisfies Record<
  ClaimRefusalKind,
  Extract<AuthLoginFailureReason, "tenant_mismatch" | "tenant_claim_unmapped">
>;

// Auth.js provider ids that map onto the audit enum. A table rather than the
// chained ternary it replaces, because two emit sites now need the same
// mapping and a second spelling of it is a drift waiting to happen. Providers
// absent here (including `passkey`, which signs in through its own route and
// never reaches an Auth.js provider id) fall through to "unknown".
const AUDIT_PROVIDER_BY_ID = {
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
  return (
    AUDIT_PROVIDER_BY_ID[provider as keyof typeof AUDIT_PROVIDER_BY_ID] ??
    "unknown"
  );
}
