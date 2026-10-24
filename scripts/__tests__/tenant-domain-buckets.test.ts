import { describe, expect, it } from "vitest";
import {
  REASON_BUCKET,
  REFUSAL_BUCKET,
  RESOLVED_ELSEWHERE_BUCKET,
  assertReasonTableAgrees,
  UNMAPPED_BUCKET,
  UNMAPPED_SELECTED_REASONS,
  bucketOf,
  buildReasonBucketMap,
} from "../lib/tenant-domain-buckets";
import { CLAIM_REFUSAL_REASON } from "@/lib/audit/auth-failure-mapping";
import {
  refusalFromLookup,
  claimRefusalOf,
  type ClaimLookup,
} from "@/lib/tenant/tenant-management";
import { claimRefusal } from "@/lib/tenant/claim-refusal";
import { extractTenantClaimValue } from "@/lib/tenant/tenant-claim";

/**
 * Guard for the third R42 class this branch produced: **which remedy an operator
 * is sent to.** It was wrong in rounds 4, 5 and 6, each time because the
 * population set was enumerated from the finding in hand.
 *
 * The mechanism is that `REFUSAL_BUCKET` is `satisfies
 * Record<ClaimRefusalKind, …>` — a new arm cannot compile without a declared
 * bucket — plus the cases below, which check each declaration against the row the
 * REAL producers emit rather than against a row written here. Concretely, the
 * `reason` comes from `CLAIM_REFUSAL_REASON`, and the presence of a diagnosis
 * comes from `claimRefusalOf` / `extractTenantClaimValue`. Round-6 F1 was a
 * producer that stopped carrying its diagnosis, so a restated row would have
 * agreed with the wrong answer.
 */

const CLAIM = "alias.example";
const UNSTORABLE_REFUSAL = claimRefusal("claim must be printable ASCII");

/** The `ClaimLookup` refusal arms, each with the audit reason it produces. */
const OWNER = "00000000-0000-4000-a000-000000000001";
const LOOKUP_ARMS = {
  revoked: { kind: "revoked", tenantId: OWNER },
  unstorable: { kind: "unstorable", refusal: UNSTORABLE_REFUSAL },
  unbound: { kind: "unbound", tenantId: OWNER },
  provider_mismatch: { kind: "provider_mismatch", tenantId: OWNER, boundProvider: "saml-jackson-b" },
} satisfies Record<
  Exclude<ClaimLookup, { kind: "tenant" } | { kind: "unregistered" }>["kind"],
  Exclude<ClaimLookup, { kind: "tenant" } | { kind: "unregistered" }>
>;

describe("tenant-domain unmapped buckets", () => {
  it("declares a bucket for every refusal arm, and no extras", () => {
    // Totality is a compile-time property (`satisfies`); this pins the CHOICE,
    // which the type cannot, and fails if an arm is added to the table without
    // being added here.
    expect(REFUSAL_BUCKET).toEqual({
      claim_taken: UNMAPPED_BUCKET.UNREGISTERED,
      claim_invalid: UNMAPPED_BUCKET.REFUSED,
      claim_malformed: UNMAPPED_BUCKET.REFUSED,
      // Not reported: `provider_error` is a deployment fault, outside both the
      // query's reason list and the READMEs' cause table.
      store_unavailable: null,
      // C5's two provider-propagation faults: `provider_error`, like the above.
      provider_unavailable: null,
      provider_disagreement: null,
      // C4: one heading for both binding refusals — investigate, then bind or
      // re-point. Neither carries a diagnosis, so this declaration decides it.
      claim_unbound: UNMAPPED_BUCKET.PROVIDER_BINDING,
      claim_provider_mismatch: UNMAPPED_BUCKET.PROVIDER_BINDING,
      // CF13. A table key only — never passed as a `claimRefusal` VALUE, since
      // its adjudicator is a PostgreSQL CHECK and a CHECK produces no
      // diagnosis. So `bucketOf`'s first branch cannot fire for it and THIS
      // declaration is what decides its heading.
      claim_system_tenant: UNMAPPED_BUCKET.UNREGISTERED,
    });
  });

  it("every reported arm's reason is one the query selects", () => {
    // Round-4 F3 in mechanical form: a bucket declared for an arm whose reason
    // the SQL does not select is a heading that can never print.
    for (const [kind, bucket] of Object.entries(REFUSAL_BUCKET)) {
      const reason = CLAIM_REFUSAL_REASON[kind as keyof typeof CLAIM_REFUSAL_REASON];
      if (bucket === null) {
        expect(
          (UNMAPPED_SELECTED_REASONS as readonly string[]).includes(reason),
          `${kind} is declared unreported but its reason ${reason} IS selected`,
        ).toBe(false);
        continue;
      }
      expect(
        (UNMAPPED_SELECTED_REASONS as readonly string[]).includes(reason),
        `${kind} is declared reported as ${bucket} but its reason ${reason} is not selected`,
      ).toBe(true);
    }
  });

  /**
   * The load-bearing half. Each row is assembled from what production actually
   * produces — the arm goes through the real `refusalFromLookup`, its reason
   * through the real `CLAIM_REFUSAL_REASON`, and its diagnosis through the real
   * `claimRefusalOf` — so an arm that loses its diagnosis reds here.
   */
  it.each(Object.values(LOOKUP_ARMS).map((arm) => [arm.kind, arm] as const))(
    "a %s lookup buckets where REFUSAL_BUCKET declares",
    (_label, arm) => {
      const refusal = refusalFromLookup(arm);
      const row = {
        reason: CLAIM_REFUSAL_REASON[refusal.kind],
        // src/auth.ts passes the asserted claim on every resolution refusal.
        claim: CLAIM,
        claim_refusal: claimRefusalOf(refusal),
      };
      expect(bucketOf(row)).toBe(REFUSAL_BUCKET[refusal.kind]);
    },
  );

  it("an ingest refusal buckets where REFUSAL_BUCKET declares", () => {
    // The real ingest boundary, not a fixture: `claim_malformed` carries a
    // diagnosis and NO claim (round-5 S2), and both halves decide the bucket.
    const extraction = extractTenantClaimValue(
      { provider: "saml-jackson", type: "oidc", providerAccountId: "x" },
      { organization: "beta.example​" },
    );
    expect(extraction.kind).toBe("malformed");
    if (extraction.kind !== "malformed") return;
    const row = {
      reason: CLAIM_REFUSAL_REASON.claim_malformed,
      claim: null,
      claim_refusal: extraction.diagnosis,
    };
    expect(bucketOf(row)).toBe(REFUSAL_BUCKET.claim_malformed);
  });

  it("a claim that resolved to a DIFFERENT tenant buckets as other_tenant (row 7)", () => {
    // The one reported population that is not a refusal. Round-5 F1/S3 was this
    // row arriving under the refused heading, and round-6 F1 was an unstorable
    // claim arriving under THIS one — so both directions need a case.
    const row = { reason: "tenant_mismatch", claim: CLAIM, claim_refusal: null };
    expect(bucketOf(row)).toBe(RESOLVED_ELSEWHERE_BUCKET);
  });

  it("a sentinel-target refusal buckets as unregistered, carrying no diagnosis", () => {
    // CF13's arm, and the shape that makes it awkward: it is the only reported
    // arm whose adjudicator is outside this process, so it arrives with
    // `claim_refusal: null` and `bucketOf`'s first branch never sees it. What
    // decides the heading is the reason's membership in `REFUSAL_BUCKET`, which
    // is why the second branch had to become a membership test — the previous
    // `reason === CLAIM_REFUSAL_REASON.claim_taken` comparison returns
    // OTHER_TENANT for this row and sends the operator to `add --from`.
    const row = {
      reason: CLAIM_REFUSAL_REASON.claim_system_tenant,
      claim: CLAIM,
      claim_refusal: null,
    };
    expect(bucketOf(row)).toBe(REFUSAL_BUCKET.claim_system_tenant);
    expect(bucketOf(row)).toBe(UNMAPPED_BUCKET.UNREGISTERED);
  });

  it("keeps claim_taken's own bucketing after the widening", () => {
    // The arm the second branch used to be spelled for. A membership test that
    // silently stopped including it would be invisible to every other case
    // here, because they all go through REFUSAL_BUCKET on both sides.
    const row = {
      reason: CLAIM_REFUSAL_REASON.claim_taken,
      claim: CLAIM,
      claim_refusal: null,
    };
    expect(bucketOf(row)).toBe(UNMAPPED_BUCKET.UNREGISTERED);
  });

  it("does not file a bare tenant_mismatch as unregistered after the widening", () => {
    // The direction the looser derivation would have broken. `claim_invalid`
    // and `claim_malformed` both declare REFUSED and both spell
    // `tenant_mismatch`, so a membership test over `bucket !== null` would pull
    // that reason in — and every genuine "registered to a different tenant"
    // denial, which carries no diagnosis, would move under the wrong heading.
    expect(
      bucketOf({ reason: "tenant_mismatch", claim: CLAIM, claim_refusal: null }),
    ).not.toBe(UNMAPPED_BUCKET.UNREGISTERED);
  });

  it("refuses a reason that two arms give different buckets", () => {
    // The guard the widening made necessary. `bucketOf` reads a row's REASON,
    // and two arms legitimately share one — so the derivation is sound only
    // while arms sharing a reason share a bucket, which no type states. Proved
    // against a colliding table rather than by mutating the real one: the real
    // pair (claim_invalid / claim_malformed) both declare REFUSED today, and
    // flipping either is what this refuses.
    expect(() =>
      buildReasonBucketMap(
        { claim_invalid: UNMAPPED_BUCKET.REFUSED, claim_malformed: UNMAPPED_BUCKET.UNREGISTERED },
        { claim_invalid: "tenant_mismatch", claim_malformed: "tenant_mismatch" },
      ),
    ).toThrow(/resolves to two buckets/);
  });

  it("accepts the many-to-one map the real tables declare", () => {
    // The allow arm: the refusal above is satisfied by a builder that throws
    // unconditionally, and the real tables ARE many-to-one — two arms per reason
    // on both reported reasons.
    const map = buildReasonBucketMap(REFUSAL_BUCKET, CLAIM_REFUSAL_REASON);
    expect(map.get(CLAIM_REFUSAL_REASON.claim_taken)).toBe(UNMAPPED_BUCKET.UNREGISTERED);
    expect(map.get(CLAIM_REFUSAL_REASON.claim_system_tenant)).toBe(UNMAPPED_BUCKET.UNREGISTERED);
    expect(map.get(CLAIM_REFUSAL_REASON.claim_invalid)).toBe(UNMAPPED_BUCKET.REFUSED);
    // `store_unavailable` declares null and must not appear at all.
    expect(map.has(CLAIM_REFUSAL_REASON.store_unavailable)).toBe(false);
  });

  it("distinguishes an unstorable claim from a row-7 mismatch on the FIELD, not the reason", () => {
    // Both carry `tenant_mismatch` AND a claim. The diagnosis is the only thing
    // that separates them, which is exactly why round-6 F1 mis-bucketed one:
    // they were byte-identical without it.
    const unstorable = refusalFromLookup({ kind: "unstorable", refusal: UNSTORABLE_REFUSAL });
    const shared = { reason: CLAIM_REFUSAL_REASON.claim_invalid, claim: CLAIM };
    expect(bucketOf({ ...shared, claim_refusal: claimRefusalOf(unstorable) })).toBe(
      UNMAPPED_BUCKET.REFUSED,
    );
    expect(bucketOf({ ...shared, claim_refusal: null })).toBe(UNMAPPED_BUCKET.OTHER_TENANT);
  });

  it("REASON_BUCKET covers exactly the selected reasons", () => {
    expect(Object.keys(REASON_BUCKET).sort()).toEqual([...UNMAPPED_SELECTED_REASONS].sort());
  });

  it.each([
    ["tenant_claim_unbound", UNMAPPED_BUCKET.PROVIDER_BINDING],
    ["tenant_claim_provider_mismatch", UNMAPPED_BUCKET.PROVIDER_BINDING],
    ["tenant_claim_unmapped", UNMAPPED_BUCKET.UNREGISTERED],
    ["tenant_claim_system_tenant", UNMAPPED_BUCKET.UNREGISTERED],
    ["tenant_mismatch", UNMAPPED_BUCKET.OTHER_TENANT],
  ] as const)("a diagnosis-free %s row buckets as %s", (reason, bucket) => {
    expect(bucketOf({ reason, claim: CLAIM, claim_refusal: null })).toBe(bucket);
  });

  it("refuses a reason the report does not select, rather than defaulting a heading", () => {
    expect(() => bucketOf({ reason: "provider_error", claim: CLAIM, claim_refusal: null })).toThrow(
      /not one the report selects/,
    );
  });

  it("refuses an arm table that disagrees with the reason table", () => {
    // Synthetic: the real tables agree, which the module-load call proves.
    expect(() =>
      assertReasonTableAgrees(
        new Map([["tenant_claim_unbound", UNMAPPED_BUCKET.UNREGISTERED]]),
        { claim_unbound: UNMAPPED_BUCKET.UNREGISTERED },
        { claim_unbound: "tenant_claim_unbound" },
        REASON_BUCKET,
      ),
    ).toThrow(/declared "unregistered" by REFUSAL_BUCKET/);
    expect(() =>
      assertReasonTableAgrees(
        new Map(),
        { provider_unavailable: null },
        { provider_unavailable: "tenant_claim_unbound" },
        REASON_BUCKET,
      ),
    ).toThrow(/declared unreported/);
    expect(() =>
      assertReasonTableAgrees(
        buildReasonBucketMap(REFUSAL_BUCKET, CLAIM_REFUSAL_REASON),
        REFUSAL_BUCKET,
        CLAIM_REFUSAL_REASON,
        REASON_BUCKET,
      ),
    ).not.toThrow();
  });
});
