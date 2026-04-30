# Code Review: admin-vault-reset-dual-approval
Date: 2026-04-30T20:30:00+09:00
Review round: 1

## Changes from Previous Round
Initial code review.

## Functionality Findings

### F1 [Minor]: Deviation log empty despite documented additive deviations
- File: `docs/archive/review/admin-vault-reset-dual-approval-deviation.md`
- Problem: file contains only the title; two additive deviations are not recorded — (a) GET response shape adds `initiatedBy.id` and `approvedBy.id`; (b) approve audit metadata adds `newExpiresAt`.
- Impact: traceability gap.
- Fix: append deviation entries.

### F2 [Minor]: notification-messages.test.ts not exhaustive over NOTIFICATION_TYPE_VALUES
- File: `src/lib/notification/notification-messages.test.ts:4-11`
- Problem: hardcoded `KEYS` array is a subset of `NOTIFICATION_TYPE_VALUES`; plan T8 wanted full iteration.
- Impact: regression on a NOTIFICATION_TYPE that lacks a message will not be caught here (would surface in dev runtime).
- Fix: replace with `NOTIFICATION_TYPE_VALUES` OR document the carve-out.

### F3 [Minor]: Backfill audit row uses initiator id as user_id, not SYSTEM sentinel
- File: `prisma/migrations/20260430120002_admin_vault_reset_backfill/migration.sql:39`
- Problem: SYSTEM-actor audit row sets `user_id = r.initiated_by_id` while `actor_type = 'SYSTEM'`. The schema convention (per `src/lib/constants/app.ts:62` SYSTEM_ACTOR_ID sentinel + `prisma/schema.prisma:992-994` AuditLog comment) is to use the SYSTEM_ACTOR_ID UUID for SYSTEM rows.
- Impact: audit-trail attribution confusion.
- Fix: use `'00000000-0000-4000-8000-000000000001'::uuid` (SYSTEM_ACTOR_ID); keep initiator in metadata.initiatedById.

## Security Findings

No findings. All P0/P1 invariants from rounds 1-3 of the plan review are correctly implemented:
- S10: account-token AAD bytes byte-for-byte unchanged; legacy fixture regression test exists
- FR12: AAD = `tenantId:resetId:targetEmailAtInitiate` (3 segments, distinct from account-token's 2)
- F3+S2 / FR7: invalidateUserSessions(allTenants:true) drops tenant filter; discriminated union enforced compile+runtime
- CAS guards: approve has initiatedById:{not:actor.id}; execute has approvedAt:{not:null}; revoke covers both pending+approved
- Migration backfill: auto-revoke (NOT auto-approve); SYSTEM-actor audit emitted
- S14+S16: decrypt failure returns generic 409; distinct cause to operational logger only; audit metadata coarse cause
- RS2: approve has both per-actor + per-target rate limiters
- encryptedToken NULLed on revoke + execute success

## Testing Findings

### T-A [Minor]: Migration test re-runs paraphrased SQL, not the real migration
- File: `src/__tests__/db-integration/admin-vault-reset-migration.integration.test.ts:144-198`
- Problem: `runBackfill()` rewrites the migration's SQL inline (with added `tenant_id` scope); the real `migration.sql` is never executed.
- Impact: a migration regression of the kind T2 was created to catch could ship with the test green if the migration drifts but the test copy doesn't.
- Anti-Deferral: Worst case = migration drift undetected. Likelihood = low (migration file is reviewed in PR; test file is reviewed in same PR). Cost-to-fix = the real SQL has no tenant scoping; test isolation requires the inlined version. **Accepted with documentation comment update**.

### T-B [Minor]: Race-loop sanity assertion cannot fail
- File: `src/__tests__/db-integration/admin-vault-reset-dual-approval.integration.test.ts:198-201`
- Problem: `expect(winnerCount + loserCount).toBe(ITERATIONS)` is true by construction.
- Fix: replace with `expect(winnerCount).toBeGreaterThan(0); expect(loserCount).toBeGreaterThan(0);`.

### T-C [Minor]: GET history shape uses `toHaveProperty`, not strict equality (R19)
- File: `src/app/api/tenant/members/[userId]/reset-vault/route.test.ts:619-638`
- Problem: subset assertion would not catch leaked sensitive fields (tokenHash, encryptedToken).
- Fix: use `toEqual` against the exact key set.

### T-D [Minor]: AAD-binding test does not exercise real decrypt failure
- File: `src/app/api/tenant/members/.../approve/route.test.ts:387-408`
- Problem: route test mocks decryptResetToken; the AAD-mutation-causes-failure flow is exercised only in the crypto-unit test.
- Anti-Deferral: Worst case = AAD encrypt/decrypt mismatch survives the route test. Likelihood = low (covered by `admin-reset-token-crypto.test.ts` AAD-mismatch case). Cost-to-fix = high (real-decrypt route test requires bootstrapping KeyProvider in route test). **Accepted with deferral**.

### T-E [Minor]: Cross-tenant test silently skipped without REDIS_URL
- File: `src/__tests__/db-integration/admin-vault-reset-cross-tenant-sessions.integration.test.ts:35,41`
- Problem: `describe.skipIf(!redisAvailable)` — CI without Redis silently skips FR7 test.
- Anti-Deferral: Worst case = FR7 not covered in CI lacking Redis. Likelihood = low (project's `npm run test:integration` requires Redis). Cost-to-fix = medium (refactor `skipIf` to throw). **Accepted — project's integration test runner is the gate**.

### T-F [Minor]: admin-reset-token-crypto missing key-version mismatch case
- Marked optional by the reviewer.

## Adjacent Findings
None.

## Quality Warnings
No findings triggered VAGUE / NO-EVIDENCE / UNTESTED-CLAIM gates.

## Recurring Issue Check

### Functionality expert
R1-R35 all checked or N/A — see /tmp/tri-BrZuvL/func-findings.txt for full enumeration. No new findings beyond F1, F2, F3.

### Security expert
R1-R35 + RS1-RS3 all checked. No findings.

### Testing expert
R1-R35 + RT1-RT3 all checked or N/A — see /tmp/tri-BrZuvL/test-findings.txt. Six minors (T-A through T-F).

## Resolution Status

### F1 Minor: Deviation log empty
- Action: Populated `docs/archive/review/admin-vault-reset-dual-approval-deviation.md` with three additive deviations (D1: GET shape adds id; D2: approve audit adds newExpiresAt; D3: notification-messages test scoped to types-with-messages).
- Modified file: `docs/archive/review/admin-vault-reset-dual-approval-deviation.md`

### F2 Minor: notification-messages test scope — Accepted with deviation entry
- Action: Documented in deviation log D3 (Anti-Deferral: Worst case = NOTIFICATION_TYPE addition without message; surfaces in dev runtime; cost-to-fix = 5 min in next minor release).
- Modified file: `docs/archive/review/admin-vault-reset-dual-approval-deviation.md`

### F3 Minor: Backfill audit row user_id
- Action: Migration SQL now uses `'00000000-0000-4000-8000-000000000001'::uuid` (SYSTEM_ACTOR_ID sentinel) instead of `r.initiated_by_id`. Initiator preserved in `metadata.initiatedById`.
- Modified file: `prisma/migrations/20260430120002_admin_vault_reset_backfill/migration.sql:34-44`
- Note: dev DB has 0 auto-revoked rows (verified via SELECT COUNT) so no production-data drift; the fix matters only for fresh deploys and CI integration tests.

### T-A Minor: Migration test paraphrased SQL — Accepted (Anti-Deferral)
- Action: Documented as Accepted; no code change. Rationale per Anti-Deferral above.

### T-B Minor: Race-loop sanity assertion
- Action: Changed sanity check from tautological `winnerCount + loserCount === ITERATIONS` to `winnerCount > 0 AND loserCount > 0` so a deterministic-winner regression is caught.
- Modified file: `src/__tests__/db-integration/admin-vault-reset-dual-approval.integration.test.ts:201-202`

### T-C Minor: GET history `toEqual` strict shape
- Action: Replaced 11-line `toHaveProperty` chain with strict `Object.keys(json[0]).sort()` against the exact 10-key expected set; added strict assertion on nested `initiatedBy` shape.
- Modified file: `src/app/api/tenant/members/[userId]/reset-vault/route.test.ts:619-642`
- Catches accidental leaks of `tokenHash`, `encryptedToken`, or any other field that should not surface to admin clients.

### T-D Minor: AAD-binding real decrypt — Accepted (Anti-Deferral)
- Action: Documented as Accepted; covered by `admin-reset-token-crypto.test.ts` AAD-mismatch case.

### T-E Minor: Cross-tenant test skipIf — Accepted (Anti-Deferral)
- Action: Documented as Accepted; project's `npm run test:integration` requires REDIS_URL.

### T-F Minor: admin-reset-token-crypto key-version mismatch — Accepted as optional
- Action: No code change; reviewer marked optional.
