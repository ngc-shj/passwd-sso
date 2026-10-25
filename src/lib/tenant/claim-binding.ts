/**
 * The claim-binding adjudicator, prisma-free so the tenant-domain CLI decides
 * with the same predicate the sign-in path does (plan
 * sso-claim-connection-binding, C3/C4). `tenant-management.ts` reads it through
 * `findClaimRow`; `tenant-domain list --unbound` asks it which rows strict mode
 * refuses.
 */

import { CLAIM_BINDING_MODE, type ClaimBindingMode } from "@/lib/auth/jackson-providers";

/** The `tenant_claims` columns every claim decision reads. */
export type ClaimRow = { tenantId: string; revokedAt: Date | null; provider: string | null };

/**
 * What an existing claim row means for a sign-in through `signInProvider` —
 * the ONE binding adjudicator (plan sso-claim-connection-binding, C4). Both
 * `resolveTenantByClaim` and `findOrCreateTenantForClaim` decide through it, so
 * the resolver and the creator cannot disagree about a bound row.
 *
 * Arm order: revoked first (unchanged — a revoked row needs an operator
 * whatever its binding), then, in strict mode only, a row with no provider and
 * a row bound to another provider. The provider id is the one attestation of
 * which connection authenticated the user: Jackson's token endpoint completed a
 * no-PKCE exchange with that provider's own credentials (C1).
 *
 * Off mode leaves resolution as it was. `unenforcedMismatch` names a bound
 * row's provider when it differs from the sign-in's, which the caller logs;
 * with one claim provider that is only a row bound to a provider no longer
 * configured.
 */
export type ClaimBindingVerdict =
  | { kind: "tenant"; id: string; unenforcedMismatch: string | null }
  | { kind: "revoked"; tenantId: string }
  | { kind: "unbound"; tenantId: string }
  | { kind: "provider_mismatch"; tenantId: string; boundProvider: string };

export function adjudicateClaimBinding(
  row: ClaimRow,
  signInProvider: string,
  mode: ClaimBindingMode,
): ClaimBindingVerdict {
  if (row.revokedAt !== null) return { kind: "revoked", tenantId: row.tenantId };
  if (mode === CLAIM_BINDING_MODE.STRICT) {
    if (row.provider === null) return { kind: "unbound", tenantId: row.tenantId };
    if (row.provider !== signInProvider) {
      return { kind: "provider_mismatch", tenantId: row.tenantId, boundProvider: row.provider };
    }
    return { kind: "tenant", id: row.tenantId, unenforcedMismatch: null };
  }
  const mismatch = row.provider !== null && row.provider !== signInProvider ? row.provider : null;
  return { kind: "tenant", id: row.tenantId, unenforcedMismatch: mismatch };
}

/**
 * An active row that strict mode refuses for every configured claim provider:
 * unbound, or bound to a provider no longer configured. Asked of the
 * adjudicator rather than restated, so `list --unbound` names exactly the rows
 * sign-in would refuse. A revoked row is not one — it needs `add`, whatever its
 * binding.
 */
export function isUnusableUnderStrict(row: ClaimRow, claimProviders: readonly string[]): boolean {
  if (row.revokedAt !== null) return false;
  return claimProviders.every(
    (provider) => adjudicateClaimBinding(row, provider, CLAIM_BINDING_MODE.STRICT).kind !== "tenant",
  );
}
