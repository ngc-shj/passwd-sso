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
  "tenant_claim_system_tenant",
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
 *
 * The second branch is a membership test over `REFUSAL_BUCKET`, not a comparison
 * against one arm's reason. Two things follow, and both were defects at some
 * point in this branch's history:
 *
 *   - `REFUSAL_BUCKET` stops being decorative. It was referenced only by its own
 *     test, so a declaration there decided nothing and CF13's arm could have
 *     been added to it while `bucketOf` kept returning `OTHER_TENANT`.
 *   - the membership is over `bucket === UNREGISTERED`, NOT over
 *     `REFUSAL_BUCKET[kind] !== null`. The looser form pulls in `claim_invalid`
 *     and `claim_malformed`, whose reason is `tenant_mismatch` — the reason the
 *     resolved-elsewhere population also carries — and would move every genuine
 *     "registered to a different tenant" denial under the wrong heading. That is
 *     round-5 F1/S3, and it is reachable only from the else-branch because those
 *     two arms always carry a `claim_refusal` and never get here.
 */
export function bucketOf(row: BucketInput): UnmappedBucket {
  if (row.claim_refusal !== null) return UNMAPPED_BUCKET.REFUSED;
  return UNREGISTERED_REASONS.has(row.reason)
    ? UNMAPPED_BUCKET.UNREGISTERED
    : RESOLVED_ELSEWHERE_BUCKET;
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
  // The claim IS registered — to the tenant that encodes "no owning tenant".
  // UNREGISTERED because that heading's remedy is `tenant-domain`, which is
  // where the operator has to go: the `tenant_claims` row must be re-pointed at
  // a real tenant. `add` refuses a sentinel target, so no operator command
  // created this row and none of the other two headings describes it.
  claim_system_tenant: UNMAPPED_BUCKET.UNREGISTERED,
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

/**
 * `reason → bucket`, derived from `REFUSAL_BUCKET` through `CLAIM_REFUSAL_REASON`.
 *
 * The map is MANY-TO-ONE by design — `claim_taken` and `claim_collision` share
 * `tenant_claim_unmapped`, `claim_invalid` and `claim_malformed` share
 * `tenant_mismatch` — and `bucketOf` reads the row's `reason`, not its arm,
 * because that is all an audit row carries. So the derivation is only sound
 * while every arm sharing a reason also shares a bucket, and nothing in the type
 * system says so. This throws at module load if that ever stops holding, which
 * is the moment someone declares a bucket for a new arm without noticing it
 * collides with an existing one's reason.
 *
 * Loud rather than silent: the alternative is a report that quietly files one of
 * the two colliding populations under the other's remedy, which is the exact
 * defect rounds 4, 5 and 6 each hit from a different direction.
 */
export function buildReasonBucketMap(
  refusalBucket: Readonly<Record<string, UnmappedBucket | null>>,
  reasonOf: Readonly<Record<string, string>>,
): ReadonlyMap<string, UnmappedBucket> {
  const map = new Map<string, UnmappedBucket>();
  for (const [kind, bucket] of Object.entries(refusalBucket)) {
    if (bucket === null) continue;
    const reason = reasonOf[kind];
    const existing = map.get(reason);
    if (existing !== undefined && existing !== bucket) {
      throw new Error(
        `tenant-domain-buckets: reason "${reason}" resolves to two buckets ` +
          `("${existing}" and "${bucket}"); an audit row carries the reason, not the arm, ` +
          `so bucketOf cannot tell them apart. Give the new arm its own reason in ` +
          `CLAIM_REFUSAL_REASON, or reconcile the two declarations in REFUSAL_BUCKET.`,
      );
    }
    map.set(reason, bucket);
  }
  return map;
}

/**
 * Taken over the real tables at module load, so a colliding declaration fails
 * the CLI at startup rather than mis-filing one population at report time. The
 * builder is a parameter-taking function so its refusal is reachable from a test
 * without mutating this module — a guard nobody has watched fail is a guard
 * nobody knows the shape of.
 */
const REASON_BUCKET = buildReasonBucketMap(REFUSAL_BUCKET, CLAIM_REFUSAL_REASON);

/**
 * The reasons `bucketOf` files under UNREGISTERED. Derived, so an arm added to
 * `REFUSAL_BUCKET` reaches the report without a second edit here — the missing
 * second edit being what round-4 F3 was.
 */
const UNREGISTERED_REASONS: ReadonlySet<string> = new Set(
  [...REASON_BUCKET.entries()]
    .filter(([, bucket]) => bucket === UNMAPPED_BUCKET.UNREGISTERED)
    .map(([reason]) => reason),
);
