# Plan Review: codebase-review-fixes
Date: 2026-04-16
Review round: 2

## Changes from Previous Round
Initial review

## Functionality Findings

### F1 Major: mergeActionGroups() must handle both duplicate keys (admin AND scim)
- Problem: Plan only mentions `group:admin` as a duplicate key example. `group:scim` also exists in both TENANT and TEAM action group maps. Spec must explicitly call out both.
- Impact: If merge logic isn't tested for both duplicate keys, `group:scim` might silently drop tenant-only SCIM actions.
- Recommended action: Update plan to list both duplicate keys. Add test cases for both.

### F2 Major: Personal download date boundary clarification needed
- Problem: Plan adds date boundary requirement to team download but personal download also has no date boundary (only MAX_ROWS). Plan doesn't clarify whether this asymmetry is intentional.
- Impact: Inconsistent API behavior across download endpoints.
- Recommended action: Clarify in plan that personal download has MAX_ROWS already (sufficient), and team download is the only one missing both caps.

### F3 Major: ValidatedScimToken JSDoc update missing from files list
- Problem: `scim-token.ts` JSDoc references `SCIM_SYSTEM_USER_ID` which will be removed.
- Recommended action: Add JSDoc update to Finding 5 files list.

### F4+S1 Major: chain-verify truncation — audit metadata + response disambiguation (merged)
- Problem: (F4) Audit log metadata doesn't include truncation flag. (S1) Response doesn't distinguish truncation from tampering — `ok: false` alone is ambiguous.
- Impact: SIEM/compliance tools can't distinguish partial verification from detected tampering.
- Recommended action: Add `truncated` to audit metadata. Add `reason` field to response (`"TRUNCATED" | "TAMPER_DETECTED" | "GAP_DETECTED" | "TIMESTAMP_VIOLATION"`).

### F6+S5 Major: enforceAccessRestriction SCIM userId handling (merged)
- Problem: SCIM routes call `enforceAccessRestriction(req, "scim", tenantId)` with literal string `"scim"` as userId (not UUID). After Finding 5 fix, must pass `SYSTEM_ACTOR_ID` + explicit `tenantIdOverride`.
- Impact: Without `tenantIdOverride`, `resolveUserTenantId(SYSTEM_ACTOR_ID)` returns null, potentially bypassing access restriction.
- Recommended action: All SCIM `enforceAccessRestriction` calls must use `enforceAccessRestriction(req, SYSTEM_ACTOR_ID, token.tenantId)`.

### F5 Minor: CSV header column order consistency across 3 download routes
- Recommended action: Add test asserting all 3 routes produce identical CSV header columns.

## Security Findings

### S2 Major: Bootstrap migration guard TOCTOU race condition
- Problem: Plan says "before the migration transaction" but guard must be INSIDE `$transaction` block to prevent concurrent member addition between check and migration.
- Impact: Race condition allows migration to proceed with >1 member if concurrent join occurs.
- Recommended action: Move guard to first operation inside `prisma.$transaction(async (tx) => { ... })`.

### S3 Minor: MCP/DCR endpoint rate limiter not confirmed
- Problem: `/api/mcp/register` is unauthenticated (RFC 7591). Plan adds logging only; doesn't confirm existing rate limiter.
- Recommended action: Verify rate limiter exists on MCP routes during Finding 8 implementation. Add if missing.

### S4 Minor: operatorId metadata not searchable via audit API
- Problem: After Finding 7, `metadata.operatorId` may not be filterable in audit log search API.
- Recommended action: Verify audit API metadata search capability. Note in plan considerations.

## Testing Findings

### T1+T8 Major: Finding 1 test specifics incomplete (merged with F2)
- Problem: Plan doesn't specify importing `AUDIT_LOG_MAX_ROWS`/`AUDIT_LOG_BATCH_SIZE` from shared constants. Boundary value tests (remaining=1) not planned.
- Recommended action: Test must import constants from `@/lib/validations/common.server`, use `maxBatches` pattern from personal download test.

### T2+F3 Major: SCIM test updates need explicit detail (merged)
- Problem: `scim-token.test.ts` imports `SCIM_SYSTEM_USER_ID` which will be removed. Test assertions must change to `SYSTEM_ACTOR_ID` + `actorType: SYSTEM`.
- Recommended action: Update Testing Strategy to specify exact import/assertion changes.

### T3 Major: Finding 4 export test mock data needs sentinel actors
- Problem: Existing mock data lacks `userId` top-level field and sentinel actor entries.
- Recommended action: Add mock entries with `SYSTEM_ACTOR_ID`/`ANONYMOUS_ACTOR_ID` and assert their correct output.

### T4 Major: Finding 3 test file path unspecified
- Problem: `mergeActionGroups()` test needs a home. `src/app/api/tenant/audit-logs/route.test.ts` exists but `src/lib/constants/audit.test.ts` doesn't.
- Recommended action: Create `src/lib/constants/audit.test.ts` for `mergeActionGroups()` pure function tests.

### T5 Minor: Finding 6 test must assert ok: false when truncated
- Recommended action: Update test spec to assert both `truncated: true` AND `ok: false`.

### T6 Major: team download mock shape divergence
- Problem: JSONL and CSV test mocks have different shapes. Finding 4 fix needs unified mock with `userId`, `actorType` at top level.
- Recommended action: Unify mock shape in team download tests during Finding 4 implementation.

### T7 Minor: Finding 2 testability — extract guard as testable helper
- Recommended action: Extract `assertBootstrapSingleMember()` as a testable pure function.

## Adjacent Findings
None tagged.

## Quality Warnings
None flagged.

## Recurring Issue Check
### Functionality expert
- R1: Checked — F1 (mergeActionGroups reuse), no other reimplementation
- R2: Checked — no new hardcoded constants
- R3: Checked — F6 (enforceAccessRestriction pattern across SCIM routes)
- R4: N/A — no mutations adding event dispatch
- R5: Checked — no new multi-step DB ops without tx
- R6: N/A — no cascade deletes
- R7: N/A — no route/selector changes
- R8: N/A — no UI components
- R9: Checked — no async dispatch in tx boundaries
- R10: Checked — no circular imports
- R11: Checked — action group merge is the fix itself
- R12: Checked — no new audit actions
- R13: N/A — no event dispatch
- R14: N/A — no new DB roles
- R15: N/A — no migrations
- R16: N/A — no DB role/privilege tests

### Security expert
- R1-R8: N/A or checked (no issues)
- R9: Checked — no async dispatch in tx
- R10: Checked — no circular imports
- R11: Checked — action group fix addresses this
- R12: Checked — no new audit actions
- R13: N/A — no event dispatch
- R14-R16: N/A — no migrations
- RS1: Checked — no new credential comparisons
- RS2: Checked — S3 (MCP rate limiter verification needed)
- RS3: Checked — no new request parameters

### Testing expert
- R1-R16: Checked (see individual statuses in testing output)
- RT1: T6 (mock shape divergence)
- RT2: T7 (bootstrap guard testability)
- RT3: T8 (shared constant import pattern)
