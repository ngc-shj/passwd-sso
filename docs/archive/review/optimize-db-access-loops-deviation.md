# Coding Deviation Log: optimize-db-access-loops
Created: 2026-03-16T12:00:00+09:00

## Deviations from Plan

### D-1: Step 7 (Empty trash) kept as-is
- **Plan description**: Evaluate removing redundant findMany or using single deleteMany
- **Actual implementation**: No change — kept existing `$transaction` pattern
- **Reason**: The existing findMany is needed for audit log entry IDs, and the pattern is already optimal with $transaction
- **Impact scope**: None (no change)

### D-2: Step 9 (SCIM Groups list batch) deferred to Low priority
- **Plan description**: Batch-fetch all teamMembers with OR filter
- **Actual implementation**: Moved to Low priority, not implemented
- **Reason**: Existing code already uses `Promise.all` for parallel queries; batch-fetch optimization benefit is marginal
- **Impact scope**: None (no change)

### D-3: Step 18 (Rotate-key unbounded findMany) not implemented
- **Plan description**: Use count first, then only load IDs if count matches
- **Actual implementation**: Not implemented
- **Reason**: The existing pattern with `findMany` + set comparison is more robust and simpler; adding a count query would add a round-trip without clear benefit
- **Impact scope**: None (no change)

### D-4: New test files created (2 files)
- **Plan description**: Create scim-group-service.test.ts and engine.test.ts
- **Actual implementation**: Both files created with comprehensive test suites (19 + 12 tests)
- **Reason**: As planned
- **Impact scope**: Test coverage improvement

### D-5: vitest.config.ts coverage.include not updated
- **Plan description**: Add scim-group-service.ts and engine.ts to coverage.include
- **Actual implementation**: Not updated — vitest.config.ts does not have a coverage.include section
- **Reason**: Project uses default coverage configuration without explicit include list
- **Impact scope**: None (coverage still applies to these files via default glob)
