/**
 * `tenant-domain unmapped`'s three populations, and the mapping from a sign-in
 * refusal ARM onto the population it lands in.
 *
 * In its own module for the same reason as `tenant-domain-flags.ts`: it is pure,
 * so it can be unit-tested without importing the CLI (which pulls in Prisma, the
 * driver adapter and `loadEnv()`).
 *
 * ## Why the mapping is a declared, compiler-total table
 *
 * Which heading a denial is printed under is the operator's REMEDY, and this
 * branch has got it wrong in three consecutive rounds — each time by enumerating
 * the populations from the finding in hand rather than from the set of producers:
 *
 *   - round-4 F3 — `claim_malformed` denials were invisible: `unmapped` filtered
 *                  on `tenant_claim_unmapped` alone, so an IdP emitting a
 *                  zero-width character denied every sign-in while the tool
 *                  printed "no unmapped-claim denials"
 *   - round-5 F1/S3 — the fix bucketed on `reason`, and `tenant_mismatch` has
 *                  more than one producer, so a genuine row-7 "registered to a
 *                  different tenant" denial was printed under "the remedy is at
 *                  the IdP"
 *   - round-6 F1 — bucketing moved to the `claimRefusal` FIELD, and the
 *                  `unstorable` / `claim_invalid` producer was not given one, so
 *                  that population read as row 7 and was sent to `add --from`,
 *                  a command guaranteed to refuse it
 *
 * The `satisfies Record<ClaimRefusalKind, …>` below is the mechanism: a new
 * refusal arm cannot compile until someone states which population it joins, and
 * `scripts/__tests__/tenant-domain-buckets.test.ts` checks each declaration
 * against the row the REAL producers emit — so an arm that stops carrying its
 * diagnosis reds here rather than in the next review round.
 */

import type { ClaimRefusalKind } from "@/lib/audit/auth-failure-mapping";
import { CLAIM_REFUSAL_REASON } from "@/lib/audit/auth-failure-mapping";

export const UNMAPPED_BUCKET = {
  /** Registering the claim IS the remedy — `tenant-domain add`. */
  UNREGISTERED: "unregistered",
  /** The claim resolves, to somebody else — investigate, or `add --from`. */
  OTHER_TENANT: "other_tenant",
  /** This deployment refused the value; `add` cannot register it. */
  REFUSED: "refused",
} as const;

export type UnmappedBucket = (typeof UNMAPPED_BUCKET)[keyof typeof UNMAPPED_BUCKET];

/**
 * The `AUTH_LOGIN_FAILURE` reasons the report selects. Bound as a query
 * parameter rather than spelled in the SQL, so the set has ONE source: round-4
 * F3 was a reason missing from an inline predicate, and a second copy of the
 * list is how that recurs.
 */
export const UNMAPPED_SELECTED_REASONS = [
  "tenant_claim_unmapped",
  "tenant_mismatch",
] as const;

/** The three fields of an audit row that decide its bucket. */
export type BucketInput = {
  reason: string;
  claim: string | null;
  claim_refusal: string | null;
};

/**
 * Derived from the row rather than from `reason` alone.
 *
 * `claim_refusal` is the discriminator because it is the one field an IdP cannot
 * forge: it is written only by this deployment's own refusal adjudicators, while
 * anything inside `claim` was supplied by the IdP and can be made to look like
 * whatever a runbook tells the reader to trust (round-5 S2 / D-41).
 */
export function bucketOf(row: BucketInput): UnmappedBucket {
  if (row.claim_refusal !== null) return UNMAPPED_BUCKET.REFUSED;
  return row.reason === CLAIM_REFUSAL_REASON.claim_taken
    ? UNMAPPED_BUCKET.UNREGISTERED
    : UNMAPPED_BUCKET.OTHER_TENANT;
}

/**
 * Which population each refusal arm lands in, or `null` for an arm this report
 * does not cover.
 *
 * `store_unavailable` is `null` deliberately: it emits `provider_error`, which
 * is a deployment fault rather than a claim problem, so it is outside both the
 * query's reason list and the READMEs' cause table. Stating that as a member of
 * this table — rather than leaving it out — is what makes "not reported" a
 * decision the compiler forced someone to take.
 */
export const REFUSAL_BUCKET = {
  claim_taken: UNMAPPED_BUCKET.UNREGISTERED,
  claim_collision: UNMAPPED_BUCKET.UNREGISTERED,
  claim_invalid: UNMAPPED_BUCKET.REFUSED,
  claim_malformed: UNMAPPED_BUCKET.REFUSED,
  store_unavailable: null,
} as const satisfies Record<ClaimRefusalKind, UnmappedBucket | null>;

/**
 * The one reported population that is NOT a refusal: rows 7 and 9b's
 * "the claim resolved, to a tenant this user does not belong to". No arm of
 * `ClaimRefusalKind` names it — nothing was refused — so it is stated here
 * separately rather than left as whatever `bucketOf`'s else-branch happens to
 * return. Round-5 F1/S3 was precisely this population arriving under another
 * bucket's heading.
 */
export const RESOLVED_ELSEWHERE_BUCKET: UnmappedBucket = UNMAPPED_BUCKET.OTHER_TENANT;
