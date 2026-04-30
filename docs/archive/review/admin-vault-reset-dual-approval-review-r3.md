# Plan Review: admin-vault-reset-dual-approval (Round 3)
Date: 2026-04-30T09:00:00+09:00
Review round: 3

## Changes from Previous Round
Round-2 fixes for F18-F23, S10 (Critical, escalate=true), S11-S14, N1-N7 verified landed in plan text. Round-3 found one Critical convergence gap (3-reviewer consensus on F24/S18/T13) where round-2 redesign of NFR3 was not propagated to step 1.3 SQL and step 11.2 test assertion — fixed in this round.

## Functionality Findings

### F24 Critical — RESOLVED
- Round-2 NFR3 was rewritten ("auto-revoke" instead of "auto-approve") at one location, but step 1.3 retained the round-1 `SET approved_at = created_at, approved_by_id = initiated_by_id` SQL. Three reviewers independently caught the contradiction. R3 propagation gap.
- Fix applied: step 1.3 removed (placeholder note); step 1.6 is the canonical backfill SQL.

### F25 Major — RESOLVED
- Step 11.2 migration backfill test asserted the old "auto-approve" sentinel pattern (`approvedAt = createdAt, approvedById = initiatedById`).
- Fix applied: assertion now reads "auto-revoke semantics: PENDING row has `revokedAt = createdAt, approvedAt IS NULL, approvedById IS NULL`; `deriveResetStatus() === "revoked"`. Negative assertion: no row has `approvedAt != null` post-backfill."

### F26-F30 Minor — accepted as documented
- F26: revoke notification gate compatibility with backfill — confirmed: backfill is silent SQL UPDATE, never invokes revoke route.
- F27: GET history reader path correctness — confirmed: legacy auto-revoked rows have `revokedAt != null`, derive to "revoked".
- F28: `allTenants: false` literal type-system polish — minor, ignored (the discriminated union already excludes it).
- F29: 1ms boundary at `createdAt + 24h` — minor edge case, accepted (S15 covers same).
- F30: legacy-fixture pattern fits Vitest — confirmed via T15 round-3 refinement.

## Security Findings

### S15 Minor — ACCEPTED (boundary edge)
- At `now ≈ createdAt + 24h - ε`, `min(createdAt + 24h, now + EXECUTE_TTL_MS)` collapses to `createdAt + 24h`, leaving target with sub-millisecond redemption window. Availability annoyance, not a security breach.
- **Anti-Deferral**: Worst case = late-approved reset is unusable (target sees "expired" 410). Likelihood = low (requires approver clicking at the very last second of the 24h window). Cost-to-fix = none worth (the cap protects the security property; a "minimum useful window" extension would re-introduce the 24h-cap concern S12 closed). Acceptable as documented.

### S16 Major — RESOLVED
- S14 fix only addressed the user-facing channel, but the audit metadata path that recorded the distinct cause was readable by tenant admins via `/api/tenant/audit-logs` — same oracle.
- Fix applied: step 7 of approve flow now logs the distinct cause to **operational logger only** (NOT audit metadata). Audit row records only the coarse `RESET_NOT_APPROVABLE`.

### S17 Minor — RESOLVED (escalated to Major-equivalent treatment)
- Backfill option-c silently revokes legacy rows with no audit row — tenant has zero observability of the policy change at deploy time.
- Fix applied: step 1.6's SQL now includes a third statement that emits a SYSTEM-actor `ADMIN_VAULT_RESET_REVOKE` audit row per auto-revoked row with `metadata.reason = "dual_approval_migration"`.
- **Open question for impl**: confirm `audit_logs.actor_type` enum already includes `SYSTEM` (per machine-identity work). Plan flags this as a verify-during-impl item; if missing, add to step 1.1 migration.

### S18 Minor — RESOLVED
- Same convergence as F24/T13 — step 11.2 test contradicted the auto-revoke backfill.
- Fix applied: same as F25.

## Testing Findings

### T13 Critical — RESOLVED
- Same as F24/F25/S18.

### T14 Major — RESOLVED
- `pg_advisory_lock` barrier has NO existing precedent in the repo. The cited `pepper-dual-version.integration.test.ts` and `audit-outbox-skip-locked.integration.test.ts` use different patterns.
- Fix applied: step 11.2 now offers two implementation paths: (a) statistical N=50 loop without barrier (acceptable but weaker), or (b) author a real `pg_advisory_lock` helper at `src/__tests__/db-integration/helpers.ts` (preferred). Implementer picks (b) unless time-constrained.

### T15 Major — RESOLVED
- Legacy-fixture test did not specify how the master key is provisioned at test time.
- Fix applied: fixture format now specified explicitly (JSON with `masterKeyHex`, `masterKeyVersion`, `provider`, `providerAccountId`, `plaintext`, `ciphertext`). Generation script path declared (`scripts/regenerate-account-token-legacy-fixture.ts`). Test bootstraps `KeyProvider` via mock.

### T16 Minor — RESOLVED
- Discriminated-union compile-test location was unspecified.
- Fix applied: test embedded in `src/lib/auth/session/user-session-invalidation.test.ts` using `// @ts-expect-error` directive. `tsc --noEmit` (run via `npx next build`) evaluates it.

### T17 Minor — RESOLVED
- N7 AAD-binding test labeled "integration-shape unit test" was ambiguous regarding DB teardown.
- Fix applied: pinned to "pure mocked-Prisma unit test (NOT real DB)" — no DB teardown needed.

### T18 Minor — RESOLVED
- N3 self-approval test did not specify which bypass pattern to use.
- Fix applied: pattern (a) direct CAS-call (`prisma.adminVaultReset.updateMany(...)` with route's WHERE) is the recommended path. Assertion shape: `result.count === 0` AND `findUnique` post-test returns `approvedAt IS NULL`.

## Adjacent Findings
None new in round 3.

## Quality Warnings
None.

## Recurring Issue Check

### Functionality expert
- R3 propagation: F24 RESOLVED in this round (round-2 redesign incomplete; round-3 fixed step 1.3 + step 11.2 + risks table).
- All other R1-R35 entries: see prior reviews (no new gaps introduced by round-3 fixes).

### Security expert
- R3 (audit-channel oracle leakage): S16 RESOLVED.
- R12 (audit emission completeness): S17 RESOLVED — backfill emits SYSTEM-actor audit row.
- R29 (citations): no new uncited claims; verified phantom drain script removed.
- All other R1-R35 + RS1-RS3: no new issues.

### Testing expert
- R3 (test-precedent existence): T14 RESOLVED — plan offers two implementation paths.
- R5 (mocked tests pass vacuously): T18 RESOLVED — direct CAS-call pattern preferred to avoid app-level pre-check shortcut.
- All other R1-R35 + RT1-RT3: no new issues.

## Convergence assessment

Round 3 produced 1 Critical (F24/S18/T13 — single underlying issue, three-reviewer convergence), 3 Major (S16, T14, T15), and 6 Minor findings — ALL RESOLVED in this round's fixes. No new findings remain unaddressed. Recommend Phase 1 close-out.
