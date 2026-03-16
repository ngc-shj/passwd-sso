# Plan Review: optimize-db-access-loops
Date: 2026-03-16T00:00:00+09:00
Review round: 2

## Changes from Previous Round
Round 1 → Round 2:
- Step 6 (bulk ops): Changed to $transaction wrapping approach
- Steps 1-2 (SCIM PUT/PATCH): Added OWNER protection, separate update/create
- Step 3 (Dir Sync): Added role: { not: "OWNER" } to deactivation where clause
- Step 4 (Sessions): Added null guard and sessionToken security note
- Step 9 (SCIM Groups list): Moved to Low priority
- Step 8 (rotate-key): Added count verification
- Testing strategy: Concrete test files and scenarios added
- All Round 1 Major findings resolved

## Round 1 Findings — Resolution Status

### Functionality
- F1 [Major] Bulk ops audit log → RESOLVED (Step 6: $transaction wrapping)
- F2 [Minor] Sessions null guard → RESOLVED (Step 4: null guard pattern)
- F3 [Minor] SCIM Groups already parallel → RESOLVED (moved to Low priority)

### Security
- S1 [Major] tenantId in batch query → RESOLVED (tenantId in all where clauses)
- S2 [Major] OWNER protection in createMany → RESOLVED (explicit OWNER check)
- S3 [Major] Dir Sync OWNER deactivation → RESOLVED (role filter in where)
- S4 [Minor] sessionToken exposure → RESOLVED (security note added)
- S5 [Minor] createMany count → RESOLVED (count assertion)

### Testing
- T1 [Major] scim-group-service no tests → RESOLVED (concrete test file in plan)
- T2 [Major] engine.ts no tests → RESOLVED (concrete test file in plan)
- T3 [Major] Test strategy specificity → RESOLVED (files and scenarios listed)
- T4 [Minor] mockTransaction divergence → RESOLVED (absorbed by T1)

## Round 2 New Findings

### Security Findings

#### S6 [Major] Dir Sync toUpdate path does not protect OWNER from IdP deactivation
When IdP sets active=false for a user, the toUpdate path (engine.ts L316-335) processes the update without checking OWNER role. Only the toDeactivate path has OWNER protection.
- Impact: OWASP A04 — IdP admin can bypass OWNER protection via active=false
- Recommended: Add OWNER guard in toUpdate path
- Status: RESOLVED in plan (Step 3: added OWNER protection in toUpdate path)

### Testing Findings

#### T5 [Major] vitest.config.ts coverage.include missing new test targets
coverage.include does not include scim-group-service.ts and engine.ts
- Impact: Coverage regression prevention does not apply to these files
- Recommended: Add to coverage.include
- Status: RESOLVED in plan (testing strategy updated)

## Adjacent Findings
None
