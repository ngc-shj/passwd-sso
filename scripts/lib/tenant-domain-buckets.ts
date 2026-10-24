/**
 * `tenant-domain unmapped`'s four populations, and the mapping from a sign-in
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
  /**
   * Strict binding refused the presenting provider: the claim's row is unbound,
   * or bound to another provider (plan sso-claim-connection-binding, C4).
   */
  PROVIDER_BINDING: "provider_binding",
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
  "tenant_claim_unbound",
  "tenant_claim_provider_mismatch",
] as const;

export type UnmappedSelectedReason = (typeof UNMAPPED_SELECTED_REASONS)[number];

/**
 * The bucket of a selected row that carries NO refusal diagnosis, per reason —
 * a full table over the selected reasons rather than a membership test with an
 * else-branch, so a reason added to the selection cannot compile without its
 * heading. A row WITH a diagnosis is REFUSED whatever its reason (`bucketOf`).
 *
 * `tenant_mismatch` is OTHER_TENANT here because its diagnosis-carrying arms
 * (`claim_invalid`, `claim_malformed`) never reach this table; the check below
 * holds every other declared arm to it.
 */
export const REASON_BUCKET = {
  tenant_claim_unmapped: UNMAPPED_BUCKET.UNREGISTERED,
  tenant_mismatch: UNMAPPED_BUCKET.OTHER_TENANT,
  tenant_claim_system_tenant: UNMAPPED_BUCKET.UNREGISTERED,
  tenant_claim_unbound: UNMAPPED_BUCKET.PROVIDER_BINDING,
  tenant_claim_provider_mismatch: UNMAPPED_BUCKET.PROVIDER_BINDING,
} as const satisfies Record<UnmappedSelectedReason, UnmappedBucket>;

/** The three fields of an audit row that decide its bucket. */
export type BucketInput = {
  reason: string;
  claim: string | null;
  claim_refusal: string | null;
};

/**
 * Derived from the row rather than from `reason` alone.
 *
 * A reason outside the selection throws: the query binds
 * `UNMAPPED_SELECTED_REASONS`, so one arriving here means the two have come
 * apart, and filing it under some default heading would name a remedy for a
 * population nobody classified.
 *
 * `claim_refusal` is the discriminator because it is the one field an IdP cannot
 * forge: it is written only by this deployment's own refusal adjudicators, while
 * anything inside `claim` was supplied by the IdP and can be made to look like
 * whatever a runbook tells the reader to trust (round-5 S2 / D-41).
 *
 * Before the table, the second branch was a membership test derived from
 * `REFUSAL_BUCKET`, with OTHER_TENANT as its else-branch: correct for the
 * reasons it knew, and a silent OTHER_TENANT for any reason added later.
 */
export function bucketOf(row: BucketInput): UnmappedBucket {
  if (row.claim_refusal !== null) return UNMAPPED_BUCKET.REFUSED;
  if (!Object.prototype.hasOwnProperty.call(REASON_BUCKET, row.reason)) {
    throw new Error(`tenant-domain-buckets: reason "${row.reason}" is not one the report selects`);
  }
  return REASON_BUCKET[row.reason as UnmappedSelectedReason];
}

/**
 * Which population each refusal arm lands in, or `null` for an arm this report
 * does not cover.
 *
 * `store_unavailable` and the two C5 provider-propagation arms are `null`
 * deliberately: they emit `provider_error`, which is a deployment fault rather
 * than a claim problem, so it is outside both the query's reason list and the
 * READMEs' cause table. Stating that as a member of
 * this table — rather than leaving it out — is what makes "not reported" a
 * decision the compiler forced someone to take.
 */
export const REFUSAL_BUCKET = {
  claim_taken: UNMAPPED_BUCKET.UNREGISTERED,
  claim_invalid: UNMAPPED_BUCKET.REFUSED,
  claim_malformed: UNMAPPED_BUCKET.REFUSED,
  store_unavailable: null,
  provider_unavailable: null,
  provider_disagreement: null,
  claim_unbound: UNMAPPED_BUCKET.PROVIDER_BINDING,
  claim_provider_mismatch: UNMAPPED_BUCKET.PROVIDER_BINDING,
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
 * The map is MANY-TO-ONE by design — `claim_invalid` and `claim_malformed`
 * share `tenant_mismatch` — and `bucketOf` reads the row's `reason`, not its arm,
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
const REASON_BUCKET_MAP = buildReasonBucketMap(REFUSAL_BUCKET, CLAIM_REFUSAL_REASON);

/**
 * Holds `REFUSAL_BUCKET` to `REASON_BUCKET`, so the arm table decides something:
 * every reported arm that carries no diagnosis must land, through its reason,
 * where it declares, and an arm declared unreported must not have a selected
 * reason. REFUSED arms are exempt — they always carry a diagnosis and never
 * reach the table. Parameter-taking for the same reason as the builder above.
 */
export function assertReasonTableAgrees(
  reasonBucketMap: ReadonlyMap<string, UnmappedBucket>,
  refusalBucket: Readonly<Record<string, UnmappedBucket | null>>,
  reasonOf: Readonly<Record<string, string>>,
  reasonTable: Readonly<Record<string, UnmappedBucket>>,
): void {
  for (const [reason, bucket] of reasonBucketMap) {
    if (bucket === UNMAPPED_BUCKET.REFUSED) continue;
    if (reasonTable[reason] !== bucket) {
      throw new Error(
        `tenant-domain-buckets: reason "${reason}" is declared "${bucket}" by REFUSAL_BUCKET ` +
          `but "${reasonTable[reason] ?? "unselected"}" by REASON_BUCKET`,
      );
    }
  }
  for (const [kind, bucket] of Object.entries(refusalBucket)) {
    if (bucket === null && Object.prototype.hasOwnProperty.call(reasonTable, reasonOf[kind])) {
      throw new Error(
        `tenant-domain-buckets: ${kind} is declared unreported but its reason "${reasonOf[kind]}" is selected`,
      );
    }
  }
}

assertReasonTableAgrees(REASON_BUCKET_MAP, REFUSAL_BUCKET, CLAIM_REFUSAL_REASON, REASON_BUCKET);
