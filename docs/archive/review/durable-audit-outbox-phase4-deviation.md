# Coding Deviation Log: durable-audit-outbox Phase 4
Created: 2026-04-13

## Deviations from Plan

### D1: AuditLog column name `chainPrevHash` instead of `prevHash`
- **Plan description**: Plan §4.1 specified `prevHash Bytes? @map("prev_hash")` on AuditLog
- **Actual implementation**: Used `chainPrevHash Bytes? @map("chain_prev_hash")` to avoid naming collision with `AuditChainAnchor.prevHash`
- **Reason**: Both models have a `prevHash` field. Using `chainPrevHash` on `AuditLog` disambiguates at the Prisma client level and in column names.
- **Impact scope**: SQL column name is `chain_prev_hash` instead of `prev_hash`. Verify endpoint and worker both reference the correct column name.

### D2: `firstTimestampViolationSeq` added to verify response
- **Plan description**: Plan §4.2 specified `created_at` monotonic non-decreasing check but the response shape was `{ ok, firstTamperedSeq?, firstGapAfterSeq?, totalVerified }`
- **Actual implementation**: Added `firstTimestampViolationSeq` to the response and included it in the `ok` determination
- **Reason**: Code review Finding T5 identified the `created_at` ordering check as dead code (comment-only branch). Adding `firstTimestampViolationSeq` makes the check actionable and observable.
- **Impact scope**: Verify endpoint response shape has one additional field. `ok` is now false when timestamp violations are detected.

### D3: Integration tests (7 files) deferred to separate implementation
- **Plan description**: Plan Step 29 specified 8 integration test files + 1 unit test
- **Actual implementation**: Only the unit test (`audit-chain.unit.test.ts`, 11 tests) and CI prerequisite (`singleFork: true`) were implemented
- **Reason**: Integration tests require a running PostgreSQL instance and cannot be verified in this session. The CI job (`audit-outbox-integration` in ci.yml) is also not yet created. These are tracked as follow-up work.
- **Impact scope**: Integration test coverage for chain ordering, tamper detection, cross-tenant, disabled tenant, RLS, verify endpoint, and worker role grants is not yet in place.

### D4: CI integration job not yet added
- **Plan description**: Plan Step 30 specified adding `audit-outbox-integration` CI job to `.github/workflows/ci.yml`
- **Actual implementation**: Not yet added
- **Reason**: Same as D3 — requires careful alignment with existing CI structure and PostgreSQL service setup.
- **Impact scope**: Integration tests cannot run in CI until the job is added.
