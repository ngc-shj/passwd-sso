# Plan Review: bypass-rls-tx-callback-form

Date: 2026-07-05
Review round: 1

## Changes from Previous Round
Initial review. Round 1 materially reshaped the primary contract (C-L1).

## Security Findings

- **S1 [High, escalate → adopted]** C-L1's original fix (make the tx Serializable) needs
  40001/P2034 retry, which the codebase LACKS (zero retry infra in auth-adapter/auth.ts). It
  would convert a silent over-count into a **user-facing login 500** under concurrent sign-in.
  → **Adopted**: replaced Serializable with `pg_advisory_xact_lock(hashtext(userId))` — the
  codebase's own retry-free idiom (7 precedents). No 40001, blocks-then-proceeds.
- **S2 [High as a class, R42 → adopted]** L1 is NOT 1 site. The `isolationLevel`-grep was a
  *symptom* grep; the *primitive* ("findMany(active)→evict→create under RLS") yields **4
  sites**: session (seed), bridge-code, extension-token, mobile-token — the 3 siblings have the
  identical TOCTOU but never asked for Serializable, so are silently unprotected.
  → **Adopted**: C-L1 now covers all 4; `resource-quotas.ts` documented soft-cap → SC2.
- **S3 [Informational]** `resource-quotas.ts` is an intentional documented soft-cap (not a bug)
  → recorded as SC2, out of scope.

## Functionality Findings

- **F1 [Medium → adopted]** referenced `sites.md` didn't exist → **inlined** the full 41-site
  → bucket map into the plan.
- **F2 [Medium → adopted]** `auth-adapter.ts:158` is a HYBRID (A_NESTED + F2 `findOrCreateSsoTenant`)
  → mapped explicitly; thread tx into `findOrCreateSsoTenant(pendingClaim, tx)` (2 callers).
- **F3 [Low → adopted]** C-L1's tenant read folds into the serialized snapshot → moot now
  (advisory-lock design; recorded in consumer-flow reasoning).
- **F4 [Low → adopted]** C-C's "widen db to TxOrPrisma" contingency is dead — `transition`/
  `bulkTransition` `db` is ALREADY `TxOrPrisma` → simplified C-C, removed the contingency from
  Out-of-scope.
- **F5 [Low → adopted]** F1 static-SCIM wrapper drop is safe (auth is upstream in `authorizeScim`)
  → noted in the map.
- **F6 [Low → adopted]** F2 cascade measured ≤2 callers per helper → SC1 narrowed to F3 only
  (F2 is in-scope, not deferred).
- **F7 [Low → adopted]** `account-lockout.ts:190` inner `$transaction` carries `SET LOCAL
  lock_timeout` + `FOR UPDATE` → per-site note: preserve these on the outer tx when dropping
  the wrapper.

## Testing Findings

- **T1 [High → adopted]** the TOCTOU test is unwritable against the singleton-bound
  `createSession` (needs 2 injected clients; `raceTwoClients` needs 2 distinct clients).
  → **Adopted**: extract each count-then-create body into a client-taking helper; race via
  `raceTwoClients`. Pinned in C-L1 Testability.
- **T2 [High → adopted]** the 40001/bounded assertion was unpinned. → advisory-lock design
  makes it cleaner: assert count ≤ max AND no 40001 thrown (I-CL1-1 + I-CL1-2). Must go RED
  without the lock.
- **T3 [Medium → adopted]** I-CL1-1 (mechanism) vs I-CL1-2 (behavior) kept distinct and both
  non-negotiable.
- **T4 [Medium → adopted]** pinned the test file: `db-integration/count-then-create-toctou.integration.test.ts`,
  `SKIP=!DATABASE_URL` + `it.skipIf(SKIP)`, ≥50 iterations.
- **T5 [High → adopted]** "per-site test green" was false for ~20/27 files → added an honest
  per-site coverage matrix: only ~4 files have callback coverage; SCIM (11) + audit-chain-verify
  (5) get smoke tests; the rest are stated as guard-verified-only, not test-verified.
- **T6 [Medium → adopted]** no atomicity test for the collapsed session tx → add a rollback
  test (inject failure after evict, assert sessions still present).

## Adjacent Findings
- S2's sibling sites were flagged by Security; Functionality independently confirmed the bucket
  map; Testing confirmed the coverage gap. Strong triangulation on the R42 member-set point.

## Quality Warnings
None — all findings carried empirical evidence (real-DB isolation probe, grep of precedents,
caller counts, coverage greps).

## Recurring Issue Check

### Security expert
- RS2 (fail-open/closed): S1 — Serializable-without-retry fails *closed too hard* (500); advisory
  lock is the correct block-and-proceed posture.
- RS3 (dataflow/TOCTOU): S2 — count→evict→create race across 4 sites, derived from the primitive.
- R42: **the key finding** — L1 member-set is 4 (from the primitive), not 1 (from the symptom-grep).

### Functionality expert
- R1 (reuse): reuses `TxOrPrisma` + the advisory-lock idiom + the probe. No new primitives.
- R42: 41-site member-set independently re-derived from `eslint` (matches, correct exclusions);
  bucket counts sum to 41; hybrid site (:158) surfaced.

### Testing expert
- RT1 (mutation-killing): I-CL1-1 must go RED without the advisory lock — pinned.
- RT2 (verified vs assumed-green): T5 — honest coverage matrix replaces the false blanket claim.
- RT3 (real-DB): T4 — pinned file + DATABASE_URL gate matching the sibling integration tests.

## Round 2 target
Confirm: advisory-lock design correctness (deadlock/ordering), the 4-site member-set is complete
(no 5th count-then-create site), the coverage-matrix dispositions, and F3's honest disposition.
