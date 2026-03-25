# Coding Deviation Log: harden-rate-limit
Created: 2026-03-26T01:00:00+09:00

## Deviations from Plan

### D1: Step 8a — Duplicate test file not deleted

- **Plan description**: Delete `src/__tests__/api/share-links/verify-access.test.ts` as a duplicate of `src/app/api/share-links/verify-access/route.test.ts`.
- **Actual implementation**: The file still exists at `src/__tests__/api/share-links/verify-access.test.ts`. No deletion was performed.
- **Reason**: Not implemented.
- **Impact scope**: Test suite contains a duplicate test file. Both test files cover the same route, which may cause false confidence in coverage and adds noise to the test run.

---

### D2: Step 8b — `instrumentation.test.ts` not created

- **Plan description**: Create `src/__tests__/instrumentation.test.ts` with two test cases verifying that `register()` calls `validateRedisConfig()` when `NEXT_RUNTIME === "nodejs"` and does not call it when `NEXT_RUNTIME === "edge"`.
- **Actual implementation**: The file does not exist. The `validateRedisConfig()` call was moved to `instrumentation.ts` (Step 1a) correctly, but no test was written to cover it.
- **Reason**: Not implemented.
- **Impact scope**: The early-startup Redis config validation path has zero test coverage. A regression that silently removes the call would go undetected.

---

### D3: Step 8c — Existing 429 tests not updated with `Retry-After` header assertions

- **Plan description**: For all existing route test files that already have a 429 test case, update the rate-limit mock return value to include `retryAfterMs: 30_000` and add an assertion `expect(res.headers.get("Retry-After")).toBe("30")`. Over 20 test files were listed as targets (e.g., `vault/unlock/route.test.ts`, `emergency-access/route.test.ts`, `share-links/route.test.ts`, `sessions/sessions-list.test.ts`, `watchtower/alert/route.test.ts`, etc.).
- **Actual implementation**: None of the existing 429 test files were updated. Only the newly added test files (for the 8 new endpoints from Step 5) received mock setup, and even those did not receive a 429 test case (see D4). The `v1/passwords/route.test.ts` and related v1 tests were not updated either.
- **Reason**: Not implemented.
- **Impact scope**: The `Retry-After` header emitted by `rateLimited()` is not verified by any test. A regression removing the header would not be caught.

---

### D4: Step 8d — `rate-limit-eviction.test.ts` not created

- **Plan description**: Create `src/__tests__/lib/rate-limit-eviction.test.ts` as a separate file (to isolate `vi.mock` scope) with tests for the in-memory eviction logic: "evicts expired entries when map is full" and "clears all entries when map is full and none expired". `RATE_LIMIT_MAP_MAX_SIZE` was to be overridden via `vi.mock("@/lib/validations/common.server")`.
- **Actual implementation**: The file does not exist.
- **Reason**: Not implemented.
- **Impact scope**: The in-memory eviction code path (fallback during Redis outage) has no dedicated unit test coverage.

---

### D5: Step 8e — `vitest.config.ts` coverage thresholds not added

- **Plan description**: Add `"src/lib/rate-limit.ts"` and `"src/lib/redis.ts"` to `coverage.include`, and add a file-level threshold `"src/lib/rate-limit.ts": { lines: 80 }` to `coverage.thresholds`.
- **Actual implementation**: `vitest.config.ts` was not modified.
- **Reason**: Not implemented.
- **Impact scope**: Coverage regressions on the core rate-limit library will not be automatically enforced by CI.

---

### D6: Step 8f — `verify-access` mock pattern not updated

- **Plan description**: Rewrite the `createRateLimiter` mock in `src/app/api/share-links/verify-access/route.test.ts` from a `callCount`-closure pattern to a `mockReturnValueOnce` chain that independently controls the IP limiter and the token limiter. This enables testing scenarios like "IP limiter passes, token limiter blocks".
- **Actual implementation**: `src/app/api/share-links/verify-access/route.test.ts` has no changes in `git diff main`.
- **Reason**: Not implemented.
- **Impact scope**: The verify-access route has two rate limiters but the test does not verify independent behavior of each. The old `callCount` mock pattern remains in place.

---

### D7: Step 8g — 429 test cases not added for the 8 new rate-limited endpoints

- **Plan description**: For each of the 8 endpoints newly protected in Step 5, add a `429` test case with a `Retry-After` header assertion alongside the rate-limit mock setup.
- **Actual implementation**: Rate-limit mocks (`vi.mock("@/lib/rate-limit", ...)`) were added to 4 of the 8 test files that exist in the `src/app/api/` tree:
  - `src/app/api/directory-sync/[id]/run/route.test.ts` — mock added, no 429 test case
  - `src/app/api/teams/[teamId]/rotate-key/route.test.ts` — mock added, no 429 test case
  - `src/app/api/tenant/scim-tokens/route.test.ts` — mock added, no 429 test case
  - `src/app/api/vault/admin-reset/route.test.ts` — mock added, no 429 test case

  The other 4 endpoints from Step 5 (`vault/unlock/data`, `api-keys`, `passwords/[id]/attachments`, `teams/[teamId]/passwords/[id]/attachments`) had **no test file changes at all** — neither mock setup nor 429 test case. The plan also required updating corresponding `src/__tests__/api/` side test files; none of those were touched.
- **Reason**: Partially implemented (mock setup only) for 4 of 8 endpoints; completely skipped for the remaining 4.
- **Impact scope**: The new rate-limit code paths for all 8 endpoints are not verified by any test. A mock-less test environment will fall through to real in-memory limiter behavior, making those tests inadvertently test the limiter rather than the route logic.

---

### D8: Step 8h — Recovery key independence test cases not added

- **Plan description**: Add three specific test cases to `src/app/api/vault/recovery-key/recover/route.test.ts`: "blocks verify independently from reset", "blocks reset independently from verify", and "calls resetLimiter.clear() on successful reset". The existing single-mock pattern was to be replaced with `mockReturnValueOnce` chaining for `verifyLimiter` and `resetLimiter`.
- **Actual implementation**: The mock structure was correctly updated to use `mockReturnValueOnce` chaining (verifyLimiter / resetLimiter separation), and `beforeEach` was updated to reset both mocks. The existing `"returns 429 when rate limited"` test was updated to use `mockVerifyCheck`. However, none of the three new test cases specified in 8h were added.
- **Reason**: Partially implemented (mock refactoring done, but new test cases omitted).
- **Impact scope**: The independent rate-limiting behavior and the `resetLimiter.clear()` on success are not verified. A bug that clears the wrong limiter or skips the clear would not be caught.

---

### D9: Step 8i — CSP report test was rewritten but `mockWarn` assertion gap remains

- **Plan description**: Replace the loop-based rate limit test with a `createRateLimiter` mock pattern and verify that the CSP report route returns 204 (not 429) when rate-limited. The loop-based test was to be deleted.
- **Actual implementation**: Implemented correctly. `vi.mock("@/lib/rate-limit")` was added, the loop-based test was replaced with a mock-driven `"returns 204 silently when rate limited (no 429)"` test, and `expect(mockWarn).not.toHaveBeenCalled()` was included. **No deviation.**
- **Reason**: N/A.
- **Impact scope**: N/A.

---

### D10: Import statement ordering — module-scope call interleaved with `import` statements

- **Plan description**: The plan does not specify import ordering but states that all `createRateLimiter()` calls must be in **module scope** (outside handler functions), following the existing pattern.
- **Actual implementation**: In 3 files, the `createRateLimiter()` module-scope call was inserted between `import` statements rather than after all imports:
  - `src/app/api/api-keys/route.ts` — `const apiKeyCreateLimiter = createRateLimiter(...)` appears at line 13, with `import { withRequestLog }` and `import { withUserTenantRls }` on lines 14–15.
  - `src/app/api/teams/[teamId]/rotate-key/route.ts` — `const teamRotateKeyLimiter = createRateLimiter(...)` at line 17, with `import { encryptedFieldSchema, ... }` on line 18.
  - `src/app/api/tenant/scim-tokens/route.ts` — `const scimTokenCreateLimiter = createRateLimiter(...)` at line 20, with `import { SCIM_TOKEN_EXPIRY_MIN_DAYS, ... }` on line 21.

  JavaScript/TypeScript hoists `import` declarations, so there is no runtime error, but the style is inconsistent with every other file in the project and may confuse static analysis tools or linters.
- **Reason**: The `import` + module-scope limiter constant were added as a block and the trailing `import` was not moved above the constant.
- **Impact scope**: Cosmetic/style inconsistency in 3 files. No runtime impact.

---

### D11: `rateLimited()` helper unit test not added

- **Plan description**: The Testing Strategy section lists `"rateLimited() ヘルパーの単体テスト（Retry-After ヘッダー有無）"` as a new test to add.
- **Actual implementation**: No unit test for `rateLimited()` exists in `src/__tests__/lib/api-response.test.ts` or any other file.
- **Reason**: Not implemented.
- **Impact scope**: The `rateLimited()` function (which is now the unified 429 response helper across ~50 route files) has no dedicated unit test. The `Retry-After` rounding logic (`Math.ceil(retryAfterMs / 1000)`) and the conditional header inclusion (`retryAfterMs != null && retryAfterMs > 0`) are untested.

---

## Summary

| Step | Status |
|------|--------|
| Step 1a: `validateRedisConfig()` moved to `instrumentation.ts` | Complete |
| Step 1b: Redis error logging with throttle | Complete |
| Step 1c: `rateLimited()` helper + `errorResponse()` `headers` param | Complete |
| Step 2: All 429 responses unified to `rateLimited()` | Complete |
| Step 3: Key prefix unified to `rl:` | Complete |
| Step 4: CSP report refactored to `createRateLimiter()` | Complete |
| Step 5: 8 unprotected endpoints rate-limited | Complete |
| Step 6: Recovery key verify/reset limiters separated | Complete |
| Step 7: Magic link rate-limit warning log added | Complete |
| Step 8a: Duplicate test file deleted | **Missing** |
| Step 8b: `instrumentation.test.ts` created | **Missing** |
| Step 8c: Existing 429 tests updated with `Retry-After` assertions | **Missing** |
| Step 8d: `rate-limit-eviction.test.ts` created | **Missing** |
| Step 8e: `vitest.config.ts` coverage thresholds added | **Missing** |
| Step 8f: `verify-access` mock pattern updated | **Missing** |
| Step 8g: 429 test cases for 8 new endpoints | **Partial** (mocks added for 4/8; no 429 assertions for any) |
| Step 8h: Recovery key independence test cases | **Partial** (mock refactored; 3 new test cases not added) |
| Step 8i: CSP report test mock-ified | Complete |
| `rateLimited()` unit test | **Missing** |
| Import ordering in 3 new-limiter files | **Style issue** (D10) |
