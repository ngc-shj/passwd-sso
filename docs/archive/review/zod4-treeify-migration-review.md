# Code Review: Zod 4 flatten() → treeifyError() Migration
Date: 2026-04-05
Review round: 1 (complete)

## Summary

Zod 4 deprecated `flatten()` and `format()` on ZodError. The recommended replacement is `z.treeifyError(err)`.
16 locations use `.flatten()` across the codebase: 8 via `validationError()` helper (Category A), 6 inline (Category B), 1 in `parseBody()` (Category C), 1 in JSDoc (Category D).

## Functionality Findings

### F-01 [Critical] Breaking API response shape for frontend consumers

- **File**: `src/components/settings/base-webhook-card.tsx:146`, `src/components/team/team-create-dialog.tsx:186`
- **Evidence**: Both components access `data?.details?.fieldErrors?.url?.length` and `data?.details?.fieldErrors?.slug?.length` respectively
- **Problem**: `flatten()` returns `{ formErrors: string[], fieldErrors: Record<string, string[]> }`. `treeifyError()` returns `{ errors: string[], properties: Record<string, { errors: string[] }> }`. These shapes are incompatible. After migration, `fieldErrors` will be `undefined`, causing field-level error display to silently disappear.
- **Impact**: Users submitting invalid webhook URLs or team slugs will see only a generic "validation error" toast instead of the specific field error message.
- **Recommended action**: Update both frontend consumers to use the new path (`data?.details?.properties?.url?.errors?.length` etc.) in the same PR as the API-side migration.

### F-02 [Major] Architecture: centralize treeifyError in helper, not at call sites

- **File**: `src/lib/api-response.ts:34`, `src/lib/parse-body.ts:46`
- **Evidence**: `validationError()` accepts `details: unknown` — it passes through whatever it receives. All 14 route-level call sites call `.flatten()` independently.
- **Problem**: The migration should not be a 16-site find-and-replace. The correct approach is to introduce a `zodValidationError(err: ZodError): NextResponse` helper that calls `z.treeifyError(err)` internally, and update callers to pass `parsed.error` directly.
- **Impact**: Without centralization, new routes will continue using the deprecated pattern. Migration scope becomes fragile.
- **Recommended action**: Add `zodValidationError(err: ZodError)` to `src/lib/api-response.ts`. Update `parseBody()` to use it. Keep `validationError(details: unknown)` for non-Zod custom error shapes (e.g., breakglass `targetUserId`).

### F-03 [Major] Category B: 6 routes bypass both parseBody and validationError

- **File**: `travel-mode/disable/route.ts:50`, `vault/recovery-key/generate/route.ts:69`, `vault/recovery-key/recover/route.ts:107,158`, `directory-sync/[id]/run/route.ts:88`, `tenant/breakglass/route.ts:64`
- **Evidence**: These construct `NextResponse.json({ error: API_ERROR.VALIDATION_ERROR, details: parsed.error.flatten() })` inline, bypassing both helpers.
- **Problem**: Inconsistent error format across routes. Migration scope is wider than helper-only changes.
- **Impact**: If only helpers are updated, these 6 routes will continue using deprecated `.flatten()`.
- **Recommended action**: Migrate to `parseBody()` or the new `zodValidationError()` helper. Note: `breakglass/route.ts:73` uses a custom `{ targetUserId: [...] }` shape consumed by `breakglass-dialog.tsx:92` — this must remain as `validationError()` with manual details.

### F-04 [Minor] JSDoc documents deprecated pattern

- **File**: `src/lib/api-error-codes.ts:9`
- **Problem**: Comment says `details: parsed.error.flatten()`. New developers will copy this deprecated pattern.
- **Recommended action**: Update to reference the new centralized helper.

## Security Findings

### S-01 [Major] rotate-key large error response amplification (~1.5x)

- **File**: `src/app/api/vault/rotate-key/route.ts:97`
- **Evidence**: Route accepts `entries` (max 5,000) + `historyEntries` (max 10,000). With all entries invalid, `flatten()` produces ~2.26 MB; `treeifyError()` produces ~3.45 MB due to recursive tree structure.
- **Problem**: Authenticated user can repeatedly submit 5,000 malformed entries to trigger large validation error generation. `rotateLimiter` is `max: 3 / 15min` but validation runs before rate limiting response.
- **Impact**: CPU and memory consumption on each request for error serialization.
- **Recommended action**: For bulk validation routes (`rotate-key`, `bulk-import`, `bulk-*`), truncate error details to first N entries (e.g., 10) or omit `details` entirely.

### S-02 [Minor] vault field name leakage (no change)

- **File**: All vault routes
- **Problem**: Both `flatten()` and `treeifyError()` expose schema field names (`authHash`, `verifierHash`, etc.). No change in risk.
- **Recommended action**: No action needed. Field names are coupled with client-side crypto implementation.

### S-03 [Minor] delegation route JSON parse uncaught

- **File**: `src/app/api/vault/delegation/route.ts:80`
- **Problem**: `await request.json()` without try/catch. If JSON parse fails, handler returns 500 instead of 400.
- **Recommended action**: Wrap in try/catch or migrate to `parseBody()`.

## Testing Findings

### T-01 [Critical] api-response.test.ts hardcodes flatten() shape

- **File**: `src/lib/api-response.test.ts:19-26, 80-87`
- **Evidence**: `{ fieldErrors: { title: ["required"] } }` and `{ fieldErrors: { email: ["invalid"] } }` in test assertions.
- **Problem**: Tests will break after migration. These are "true failures" that correctly detect the shape change.
- **Recommended fix**: Update test assertions to use `treeifyError()` shape.

### T-02 [Critical] parse-body.test.ts hardcodes fieldErrors

- **File**: `src/lib/parse-body.test.ts:60`
- **Evidence**: `expect(json.details.fieldErrors).toBeDefined()`
- **Problem**: `parseBody()` is used by 60+ routes. This central utility's test will fail immediately.
- **Recommended fix**: Change to `expect(json.details.properties).toBeDefined()` or `expect(json.details.errors).toBeDefined()`.

### T-03 [Critical] RT1: webhook-card test mock diverges from reality

- **File**: `src/components/__tests__/webhook-card-test-factory.tsx:575`
- **Evidence**: Mock returns `{ details: { fieldErrors: { url: ["invalid"] } } }` (flatten shape).
- **Problem**: After API migration, mock still uses old shape → test passes, but production UI breaks. Classic mock-reality divergence.
- **Recommended fix**: Update mock to `treeifyError()` shape and update component implementation simultaneously.

### T-04 [Major] audit-logs tests may need update

- **File**: `src/__tests__/api/audit-logs.test.ts:304`, `src/__tests__/api/teams/audit-logs.test.ts:279`
- **Evidence**: `expect(json.details).toEqual({ actions: ["NOPE"] })` — full equality assertion.
- **Problem**: If these routes use `flatten()`, the assertion will break. Needs verification.
- **Recommended fix**: Confirm whether these routes use `flatten()`. If not, no change needed.

### T-05 [Major] 12 of 14 route tests lack details structure assertions

- **File**: Multiple route test files
- **Problem**: Only 2 of 14 route tests assert on `details` structure. The rest only check `json.error === "VALIDATION_ERROR"`. Migration can silently change response shape without test detection.
- **Recommended fix**: Add `details` structure assertions to validation error test cases, particularly for routes whose responses are consumed by frontend components.

## Adjacent Findings

- T-03/F-01 overlap: Webhook card test mock and production component both depend on `fieldErrors` shape — must be updated together.
- S-03 is adjacent to F-03: delegation route's missing JSON parse handling is part of the Category B consolidation.

## Quality Warnings

None — all findings include evidence and specific file/line references.

## Affected Files Inventory

### Must change (API response shape)
| # | File | Category | Current pattern |
|---|------|----------|-----------------|
| 1 | `src/lib/parse-body.ts:46` | C (shared) | `parsed.error.flatten()` |
| 2 | `src/lib/api-response.ts:34` | Helper | Add `zodValidationError()` |
| 3 | `src/app/api/vault/unlock/route.ts:70` | A | `validationError(parsed.error.flatten())` |
| 4 | `src/app/api/sends/file/route.ts:71` | A | same |
| 5 | `src/app/api/vault/delegation/route.ts:83` | A | same |
| 6 | `src/app/api/vault/rotate-key/route.ts:97` | A | same |
| 7 | `src/app/api/vault/change-passphrase/route.ts:65` | A | same |
| 8 | `src/app/api/vault/setup/route.ts:109` | A | same |
| 9 | `src/app/api/tenant/mcp-clients/route.ts:125` | A | same |
| 10 | `src/app/api/tenant/mcp-clients/[id]/route.ts:103` | A | same |
| 11 | `src/app/api/travel-mode/disable/route.ts:50` | B | inline `NextResponse.json` |
| 12 | `src/app/api/vault/recovery-key/generate/route.ts:69` | B | same |
| 13 | `src/app/api/vault/recovery-key/recover/route.ts:107,158` | B | same (x2) |
| 14 | `src/app/api/directory-sync/[id]/run/route.ts:88` | B | same |
| 15 | `src/app/api/tenant/breakglass/route.ts:64` | B | same |
| 16 | `src/lib/api-error-codes.ts:9` | D | JSDoc comment |

### Must change (frontend consumers)
| # | File | Accesses |
|---|------|----------|
| 17 | `src/components/settings/base-webhook-card.tsx:146` | `details?.fieldErrors?.url?.length` |
| 18 | `src/components/team/team-create-dialog.tsx:186` | `details?.fieldErrors?.slug?.length` |

### Must change (tests)
| # | File | Issue |
|---|------|-------|
| 19 | `src/lib/api-response.test.ts:21,26,81,86` | Hardcoded `fieldErrors` assertions |
| 20 | `src/lib/parse-body.test.ts:60` | `details.fieldErrors` existence check |
| 21 | `src/components/__tests__/webhook-card-test-factory.tsx:575` | Mock uses flatten shape |

### Should verify (may need change)
| # | File | Reason |
|---|------|--------|
| 22 | `src/__tests__/api/audit-logs.test.ts:304` | `details.actions` equality assertion |
| 23 | `src/__tests__/api/teams/audit-logs.test.ts:279` | `details` full equality assertion |

## Resolution Status

### F-01 [Critical] Breaking API response shape for frontend consumers
- Action: Updated `fieldErrors` → `properties.*.errors` in both components
- Modified: `base-webhook-card.tsx:146`, `team-create-dialog.tsx:186`

### F-02 [Major] Centralize treeifyError in helper
- Action: Added `zodValidationError(error: ZodError)` to `api-response.ts`; updated `parseBody()` to use `z.treeifyError()` internally
- Modified: `api-response.ts`, `parse-body.ts`

### F-03 [Major] Category B routes bypass helpers
- Action: All 6 routes migrated to `zodValidationError()`. `breakglass/route.ts:73` custom shape preserved via `errorResponse()`.
- Modified: `travel-mode/disable`, `vault/recovery-key/generate`, `vault/recovery-key/recover`, `directory-sync/[id]/run`, `tenant/breakglass`

### F-04 [Minor] JSDoc documents deprecated pattern
- Action: Updated comment to reference `zodValidationError(parsed.error)`
- Modified: `api-error-codes.ts:9`

### S-01 [Major] rotate-key large error response amplification
- Action: Added issue count cap (>10 issues → return `{ errorCount }` only)
- Modified: `vault/rotate-key/route.ts:95-99`

### S-02 [Minor] vault field name leakage
- Action: No action needed — risk unchanged by migration

### S-03 [Minor] delegation route JSON parse uncaught
- Action: Added try/catch for `request.json()` returning `INVALID_JSON` on failure
- Modified: `vault/delegation/route.ts:80-84`

### T-01 [Critical] api-response.test.ts hardcodes flatten() shape
- Action: Updated assertions from `fieldErrors` to `properties.*.errors`
- Modified: `api-response.test.ts:21,26,81`

### T-02 [Critical] parse-body.test.ts hardcodes fieldErrors
- Action: Changed `details.fieldErrors` → `details.properties`
- Modified: `parse-body.test.ts:60`

### T-03 [Critical] webhook-card test mock diverges from reality
- Action: Updated mock from `{ fieldErrors: { url: [...] } }` to `{ properties: { url: { errors: [...] } } }`
- Modified: `webhook-card-test-factory.tsx:575`

### T-04 [Major] audit-logs tests may need update
- Action: Verified no impact — audit-logs routes use custom `validationError({ actions: [...] })`, not `flatten()`
- Modified: none

### T-05 [Major] 12 of 14 route tests lack details structure assertions
- Action: Added `toHaveProperty("properties")` assertions to 6 route tests
- Modified: `change-passphrase/route.test.ts`, `delegation/route.test.ts`, `recovery-key/generate/route.test.ts`, `directory-sync/[id]/run/route.test.ts`, `tenant/breakglass/route.test.ts` (3 assertions)

## Code Review Round 2 Findings & Resolution

### CR-01 [Critical] breakglass self-access test never reaches self-access guard
- Action: Used valid UUID session override in test to pass Zod schema validation
- Modified: `tenant/breakglass/route.test.ts`

### CR-02 [Major] zodValidationError() has no direct unit test
- Action: Added test with real ZodError verifying treeifyError shape (errors + properties)
- Modified: `api-response.test.ts`

### CR-03 [Major] rotate-key >10 issues truncation has no test
- Action: Added test sending empty body (>10 required field issues) verifying truncated response
- Modified: `vault/rotate-key/route.test.ts`

### CR-04 [Major] breakglass self-access error shape inconsistent
- Action: Changed from `{ targetUserId: [...] }` to `{ properties: { targetUserId: { errors: [...] } } }` via `validationError()`
- Modified: `tenant/breakglass/route.ts`

### CR-05 [Minor] rotate-key errorCount unused by clients
- Action: Simplified to `{ errors: ["Validation failed with N errors"] }` for consistency
- Modified: `vault/rotate-key/route.ts`

### CR-06 [Minor] delegation POST malformed JSON test missing
- Action: Added INVALID_JSON test case
- Modified: `vault/delegation/route.test.ts`
