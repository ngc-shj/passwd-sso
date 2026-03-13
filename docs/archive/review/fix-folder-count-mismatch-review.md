# Plan Review: fix-folder-count-mismatch
Date: 2026-03-13T00:00:00+09:00
Review round: 1

## Changes from Previous Round
Initial review

## Local LLM Pre-screening Results
| # | Severity | Issue |
|---|----------|-------|
| 1 | Major | No explicit authorization check for new count queries (existing endpoints already have auth — no action needed) |
| 2 | Major | Scope ambiguity for archived-view counts (plan covers default view only by design — clarified) |
| 3 | Major | Testing strategy relies on static code-grep (switched to proper unit tests) |
| 4 | Minor | Missing API doc updates (count semantics unchanged for tags; folders now correct — no doc change needed) |
| 5 | Minor | TypeScript `as const` inference issue (addressed by using plain object with spread) |
| 6 | Minor | No data-consistency verification step (server-rendered counts; no CDN/cache involved) |

## Functionality Findings (Senior Software Engineer)

### F1 [Major] TypeScript type incompatibility with `as const`
- **Problem:** `ACTIVE_ENTRY_WHERE` typed `as const` creates a literal type that may not satisfy both `Prisma.PasswordEntryWhereInput` and `Prisma.TeamPasswordEntryWhereInput`.
- **Impact:** Compile errors or unsafe type casts at usage sites.
- **Recommended action:** Use a plain object (without `as const`) and spread it into each query. TypeScript will infer the correct types at each call site.
- **Resolution:** Accepted. Plan updated to use plain object with spread.

### F2 [Major] Tag tree view (`?tree=true`) regression risk
- **Problem:** `/api/tags` has a `tree=true` path with `flattenTagTree` that maps `passwordCount`. Mechanical constant replacement could break this path.
- **Impact:** Tag tree view counts become 0.
- **Recommended action:** Add test case for `?tree=true` count correctness.
- **Resolution:** Accepted. Test case added to plan.

### F3 [Minor] `_count.select` syntax clarification
- **Problem:** Team route uses `_count: { select: { passwords: true } }` which needs `{ passwords: { where: ... } }` form.
- **Recommended action:** Note the syntax difference in implementation steps.
- **Resolution:** Accepted. Note added.

## Security Findings (Security Engineer)

### S1 [Major] Emergency access endpoint must NOT use `ACTIVE_ENTRY_WHERE`
- **Problem:** `/api/emergency-access/[id]/vault/entries` intentionally returns archived entries for grantee recovery. Applying `ACTIVE_ENTRY_WHERE` would exclude archived entries, causing data loss in emergency scenarios.
- **Impact:** Emergency access users cannot recover archived passwords.
- **Recommended action:** Define explicit exclusion list of endpoints that must NOT use the shared constant.
- **Resolution:** Accepted. Exclusion list added to plan.

### S2 [Major] Emergency access RLS context uses grantee instead of owner
- **Problem:** Existing bug where `withUserTenantRls(session.user.id, ...)` uses grantee's tenant context to query owner's entries.
- **Impact:** Cross-tenant access issues.
- **Recommended action:** Track as separate issue.
- **Resolution:** Out of scope for this fix. Noted for separate tracking.

### S3 [Minor] Future extensibility concern for `ACTIVE_ENTRY_WHERE`
- **Problem:** Future additions (e.g., `expiresAt` filter) would affect all consumers.
- **Recommended action:** Add JSDoc warning about change impact.
- **Resolution:** Accepted. JSDoc added.

## Testing Findings (QA Engineer)

### T1 [Major] Tests must verify actual Prisma `where` arguments, not just constant shape
- **Problem:** Shape-only tests don't verify endpoints actually use the constant. Existing tests don't check `where` args.
- **Impact:** Regression can occur without test detection.
- **Recommended action:** Add `toHaveBeenCalledWith` assertions in endpoint tests to verify `_count.select.*.where` matches expected filter.
- **Resolution:** Accepted. Endpoint-level where verification added to test plan.

### T2 [Major] All endpoints must use shared constant (including already-correct ones)
- **Problem:** Partial refactoring defeats the purpose of a single source of truth.
- **Resolution:** Already in plan (steps 5-7). No change needed.

### T3 [Minor] Existing folder tests don't verify `where` conditions
- **Problem:** Same as T1 — existing tests pass regardless of filter changes.
- **Resolution:** Merged with T1.
