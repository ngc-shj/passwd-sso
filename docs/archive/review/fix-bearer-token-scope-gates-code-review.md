# Code Review: fix-bearer-token-scope-gates
Date: 2026-05-16
Review round: 1
Commit reviewed: `b3bcde22` on branch `fix/bearer-token-scope-gates`

## Changes from Previous Round
Initial review of Phase 2 implementation. Phase 2 did not run a self-R-check, so this is the primary R-check pass. Plan was reviewed for 2 rounds in Phase 1 (all 19 + 12 = 31 findings resolved before implementation).

## Functionality Findings

**[F-1] [Major]: SCIM routes return non-SCIM error format for body parse/validation failures**
- Files: `src/app/api/scim/v2/Users/route.ts:142`, `Users/[id]/route.ts:57,118`, `Groups/route.ts:142`, `Groups/[id]/route.ts:48,100`
- Evidence: 6 SCIM handlers migrated from `scimError(400, "...")` to `parseBody()` which returns `errorResponse(API_ERROR.INVALID_JSON)` / `PAYLOAD_TOO_LARGE` — standard JSON envelope, NOT SCIM format.
- Problem: RFC 7644 §3.12 requires SCIM error format `{schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], status, detail}`. SCIM clients (Azure AD, Okta, directory sync) will fail to parse.
- Same class of issue as mcp/register (RFC 7591) that we caught in Phase 1 Round 2 — but missed for SCIM.
- Fix: Create `scimParseBody` wrapper that uses `readJsonWithCap` internally + maps failures to `scimError(400/413, ...)`.

**[F-2] [Minor]: Dead `api_key` branch in delegation/check access restriction**
- File: `src/app/api/vault/delegation/check/route.ts:50`
- Evidence: `if (authResult.type === "api_key" || authResult.type === "mcp_token")` for `tenantIdOverride`. After scope gate, `api_key` cannot reach this line (no `delegation:check` scope).
- Fix: Simplify to `authResult.type === "mcp_token" ? authResult.tenantId : undefined` with explanatory comment.

**[F-3] [Minor]: SA scope double-check in access-requests POST**
- File: `src/app/api/tenant/access-requests/route.ts:135`
- Evidence: Line 114 calls `authOrToken(req, SA_TOKEN_SCOPE.ACCESS_REQUEST_CREATE)` (already validates scope); line 135 redundantly checks `authResult.scopes.includes(...)`.
- Fix: Remove the dead check.

**[F-4] [Minor (Adjacent — Security)]: readJsonWithCap fallback bypasses byte cap when `req.body` is null**
- File: `src/lib/http/parse-body.ts:62-70`
- Evidence: When `req.body?.getReader()` returns null, code falls back to `req.json()` (no cap).
- Fix: Add explanatory comment about null-body fallback being for test env / GET/HEAD only; optionally add content-length hard limit in the null-body path.

## Security Findings

**[S-1] [Minor]: CREATE schemas missing `.max()` Zod bounds — inconsistent RS3 fix**
- File: `src/lib/validations/team.ts:70-72`, `src/lib/validations/entry.ts:45`
- Evidence: UPDATE schemas got the bounds; CREATE schemas (`createTeamE2EPasswordSchema`, `createE2EPasswordSchema`) did not. `keyVersion=2147483648` causes PostgreSQL INTEGER overflow → 500.
- Fix: Add `.max(TEAM_KEY_VERSION_MAX)` to `keyVersion`, `teamKeyVersion`, `itemKeyVersion` on CREATE schemas; `.max(1)` to `aadVersion` on CREATE schemas.

**[S-2] [Minor]: Breakglass POST — rate limiter runs after body parse (pre-existing, in-scope per `feedback_no_skip_existing_code.md`)**
- File: `src/app/api/tenant/breakglass/route.ts:49-62`
- Evidence: `parseBody(req, schema)` at line 49 precedes rate-limit check at line 61.
- Per `feedback_no_skip_existing_code.md`: pre-existing findings in files already touched by this PR (breakglass was C8-migrated) are IN SCOPE.
- Fix: Reorder to auth → permission → rate limit → body parse.

## Testing Findings

**[T-1] [Major]: C5 cross-team tag rejection has no explicit route-level negative test**
- Files: `src/app/api/teams/[teamId]/passwords/route.test.ts`, `src/app/api/teams/[teamId]/passwords/[id]/route.test.ts`
- Evidence: Service-layer tests cover cross-team rejection. Route-level tests have positive (count=1) but NO negative (count=0 → 404).
- Problem: If route handler swallows service `NOT_FOUND` (try/catch bug), no test catches it.
- Fix: Add `returns 404 when tagIds belong to another team` test to both POST (create) and PUT (update).

**[T-2] [Minor]: C7 tests use raw string `"KEY_VERSION_WITHOUT_REENCRYPT"` instead of `API_ERROR` constant (RT3)**
- Files: `src/lib/services/team-password-service.test.ts:643,657,671`; `src/app/api/passwords/[id]/route.test.ts:665,680`
- Per `feedback_const_object_for_string_literals.md` — should use constant.
- Fix: Import `API_ERROR` and replace 5 raw strings with `API_ERROR.KEY_VERSION_WITHOUT_REENCRYPT`.

**[T-3] [Minor]: C3 admin-path rejection tests have misleading mockAuthOrToken setup**
- File: `src/app/api/tenant/access-requests/route.test.ts:300-366`
- Evidence: Tests configure `mockAuthOrToken` but the tested code path calls `auth()` directly (non-`sa_` bearer → admin branch). The `authOrToken` mock has no effect.
- Fix: Either rename to `"returns 401 for non-SA bearer tokens (admin path is session-only)"` or remove the irrelevant `mockAuthOrToken` setup.

## Adjacent Findings
None other than F-4 (already noted).

## Quality Warnings
None — all findings include file:line evidence and concrete fix proposals.

## Recurring Issue Check
### Functionality expert
All R1-R37 reviewed. Findings: R36 (SCIM compliance) FAIL → F-1.

### Security expert
All R1-R37 + RS1-RS4 reviewed. Findings: RS3 (input validation max bounds) PARTIAL → S-1. R7 (auth before rate limit) → S-2.

### Testing expert
All R1-R37 + RT1-RT5 reviewed. Findings: RT3 (shared constants in tests) FAIL → T-2. RT5 (production primitive in call path) PARTIAL → T-1. R18 (test naming) MINOR → T-3.

## Resolution Status

### F-1 — RESOLVED
- Created `src/lib/scim/parse-body.ts`: `scimParseBody` wrapper using `readJsonWithCap` internally; maps `tooLarge` → `scimError(413, "Request body too large")`, `invalidJson` → `scimError(400, "Invalid JSON")`, Zod failure → `scimError(400, <formatted issues>)`.
- Migrated 6 handlers from `parseBody` to `scimParseBody`:
  - `src/app/api/scim/v2/Users/route.ts` — POST
  - `src/app/api/scim/v2/Users/[id]/route.ts` — PUT, PATCH
  - `src/app/api/scim/v2/Groups/route.ts` — POST
  - `src/app/api/scim/v2/Groups/[id]/route.ts` — PUT, PATCH
- `npx vitest run src/app/api/scim/` → 114 tests PASS, 0 FAIL.

### F-2 — RESOLVED
- `src/app/api/vault/delegation/check/route.ts:50` simplified to `authResult.type === "mcp_token" ? authResult.tenantId : undefined`. Added comment explaining the scope gate (C4) excludes api_key / extension_token upstream.

### F-3 — RESOLVED
- `src/app/api/tenant/access-requests/route.ts:135` removed the redundant `authResult.scopes.includes(SA_TOKEN_SCOPE.ACCESS_REQUEST_CREATE)` check. Added comment noting scope is already validated by `authOrToken(req, ...)` at line 114.

### F-4 — RESOLVED
- `src/lib/http/parse-body.ts:62-70` added explanatory comment documenting that the null-body fallback is only reachable in test environments mocking `req.body=null` or GET/HEAD requests. Content-length pre-check (line 56-59) still caps any body whose content-length header is set, so a mocked-large body with a content-length header cannot bypass the cap.

### S-1 — RESOLVED
- `src/lib/validations/team.ts` `createTeamE2EPasswordSchema`: added `.max(1)` to `aadVersion`, `.max(TEAM_KEY_VERSION_MAX)` to `teamKeyVersion` and `itemKeyVersion`.
- `src/lib/validations/entry.ts` `createE2EPasswordSchema`: added `.max(TEAM_KEY_VERSION_MAX)` to `keyVersion`.

### S-2 — RESOLVED
- `src/app/api/tenant/breakglass/route.ts` reordered: auth → permission → rate limit → body parse. Per `feedback_no_skip_existing_code.md`, this pre-existing pattern was in scope (file was C8-migrated).

### T-1 — RESOLVED
- Added `returns 404 when tagIds belong to another team in same tenant (C5 negative)` test to both `src/app/api/teams/[teamId]/passwords/route.test.ts` (POST) and `[id]/route.test.ts` (PUT). Tests assert: 404 status, `error: "NOT_FOUND"`, and that the create/update mutation is NOT called.

### T-2 — RESOLVED
- Imported `API_ERROR` in `src/lib/services/team-password-service.test.ts` and `src/app/api/passwords/[id]/route.test.ts`. Replaced all 5 raw `"KEY_VERSION_WITHOUT_REENCRYPT"` strings with `API_ERROR.KEY_VERSION_WITHOUT_REENCRYPT`.

### T-3 — RESOLVED
- Consolidated 3 separate admin-path rejection tests (`api_key`, `extension_token`, `mcp_token`) into a single `it.each([...])` parameterized test. Removed misleading `mockAuthOrToken` setup. New test name: `returns 401 for non-SA bearer ($label) on admin path`. Comment clarifies that admin path is session-only and `authOrToken` is unreachable for non-SA bearer prefixes.

---

All 8 findings (1 Major-F + 1 Major-T + 4 Minor-FS + 2 Minor-T) resolved.
- Full vitest: 10353 tests pass, 1 skipped.
- `npx next build`: succeeds.
- `scripts/pre-pr.sh`: 18/18 checks pass.
- R3 forbidden-pattern sweep: clean (verified end of Phase 2).

---

# Round 2 — Incremental Verification
Date: 2026-05-16
Review round: 2

## Changes from Previous Round
Phase 3 Round 1 fixes (commit `c4adcd45`) reviewed by 3 expert sub-agents in incremental mode. All 8 R1 findings verified as correctly resolved with no regressions. Round 2 surfaced 1 Major + 5 Minor new findings (1 dedupe: T-N1 ≡ T-7).

## New Round 2 Findings

**[T-5] [Major]: `scimParseBody` helper has no unit tests — RFC 7644 compliance paths untested**
- File: `src/lib/scim/parse-body.ts` (no test file)
- 4 branches (success, 413, 400-invalid-JSON, 400-Zod) untested. A future refactor breaking SCIM format would not be caught.
- Fix: created `src/lib/scim/parse-body.test.ts` with 5 tests covering all branches + maxBytes override.

**[S-N1] [Minor]: RS3 sweep incomplete — 3 more write-path schemas missing `.max()`/`.int()` bounds**
- Files: `src/lib/validations/team.ts:56` (`teamMemberKeySchema.keyVersion`), `src/lib/validations/entry.ts:90` (`historyReencryptSchema.keyVersion`), `:98-99` (`teamHistoryReencryptSchema.teamKeyVersion`/`itemKeyVersion`)
- Pre-existing schemas not addressed by S-1 fix scope. Same RS3 vulnerability class.
- Fix: added `.max(TEAM_KEY_VERSION_MAX)` to all 3 schemas + `.int()` to `teamHistoryReencryptSchema` fields.

**[T-4] [Minor]: RT3 incomplete — 8 raw `"FOLDER_NOT_FOUND"` strings remain in files that now import `API_ERROR`**
- Files: `src/app/api/teams/[teamId]/passwords/route.test.ts` (2), `[id]/route.test.ts` (2), `src/lib/services/team-password-service.test.ts` (4)
- Inconsistency introduced by T-2 (KEY_VERSION fix imported API_ERROR but didn't migrate FOLDER_NOT_FOUND).
- Fix: added `API_ERROR` imports where missing; replaced 8 raw strings with `API_ERROR.FOLDER_NOT_FOUND`.

**[T-6] [Minor]: S-1 CREATE schema upper-bound enforcement is untested**
- Files: `src/lib/validations/entry.test.ts`, `src/lib/validations/team.test.ts`
- The Zod `.max()` bounds added by S-1 had no test asserting they actually fire.
- Fix: added Zod-level tests (`rejects keyVersion above TEAM_KEY_VERSION_MAX`, `rejects teamKeyVersion above ...`, `rejects itemKeyVersion above ...`, `rejects aadVersion above 1`).

**[F-N1] [Minor]: delegation/check comment omits `service_account` exclusion mechanism**
- File: `src/app/api/vault/delegation/check/route.ts:45-49`
- Comment named api_key / extension_token exclusion (via scope gate) but didn't mention SA tokens (rejected by `hasUserId` gate).
- Fix: extended the comment to name the SA exclusion path.

**[T-7] (≡ T-N1) [Minor]: T-1 PUT test comment claims "default mock returns 0" but `vi.resetAllMocks` clears defaults**
- Files: both `route.test.ts` and `[id]/route.test.ts` C5 negative tests
- Comment was inaccurate: the explicit `mockResolvedValueOnce(0)` is load-bearing, not redundant.
- Fix: rewrote the comments to make load-bearing role explicit.

## Adjacent Findings
None.

## Quality Warnings
None.

## Recurring Issue Check (Round 2)
- **R36 (SCIM compliance)**: F-1 resolved. R2 verified no regression.
- **RS3 (input validation max bounds)**: PARTIAL → resolved with S-N1 fix (3 more schemas bounded).
- **RT3 (shared constants in tests)**: PARTIAL → resolved with T-4 fix (FOLDER_NOT_FOUND migration).
- **RT1, RT2, RT4, RT5**: clean.
- All other R1-R37 + RS1-RS4 + RT1-RT5: clean.

## Resolution Status (Round 2)

### T-5 — RESOLVED
- Created `src/lib/scim/parse-body.test.ts` with 5 tests: success path, 400 invalid JSON, 400 Zod failure, 413 over-cap, maxBytes override accepts larger body. Assertions verify SCIM Error envelope shape (`schemas`, `status`, `detail`).
- All 5 tests pass.

### S-N1 — RESOLVED
- `src/lib/validations/team.ts:56` `teamMemberKeySchema.keyVersion`: added `.max(TEAM_KEY_VERSION_MAX)`.
- `src/lib/validations/entry.ts:90` `historyReencryptSchema.keyVersion`: added `.min(1).max(TEAM_KEY_VERSION_MAX)`.
- `src/lib/validations/entry.ts:98-99` `teamHistoryReencryptSchema`: added `.int().min(1).max(TEAM_KEY_VERSION_MAX)` to `teamKeyVersion`, `.int().min(0).max(TEAM_KEY_VERSION_MAX)` to `itemKeyVersion`.

### T-4 — RESOLVED
- Added `import { API_ERROR } from "@/lib/http/api-error-codes"` to `src/app/api/teams/[teamId]/passwords/route.test.ts` and `[id]/route.test.ts` (were missing).
- Replaced all 8 raw `"FOLDER_NOT_FOUND"` strings with `API_ERROR.FOLDER_NOT_FOUND` across 3 files.

### T-6 — RESOLVED
- `src/lib/validations/entry.test.ts`: added `rejects keyVersion above TEAM_KEY_VERSION_MAX` to `createE2EPasswordSchema` group.
- `src/lib/validations/team.test.ts`: added 3 tests to `createTeamE2EPasswordSchema` group — `rejects teamKeyVersion above max`, `rejects itemKeyVersion above max`, `rejects aadVersion above 1`.

### F-N1 — RESOLVED
- Extended the comment at `src/app/api/vault/delegation/check/route.ts:45-49` to note that `service_account` tokens are excluded earlier by the `hasUserId` gate (line 37-39) because SA tokens carry `serviceAccountId` not `userId`.

### T-7 — RESOLVED
- Updated comments in both C5 negative tests to: `// Explicit mock: teamTag.count returns 0 (count < tagIds.length → NOT_FOUND).` + `// vi.resetAllMocks() in beforeEach clears the hoisted default, so mockResolvedValueOnce(0) is load-bearing.`

---

All 6 Round 2 findings resolved.
- Full vitest: 10362 tests pass, 1 skipped (+9 from Round 2 additions).
- `npx next build`: succeeds.
- `scripts/pre-pr.sh`: 18/18 checks pass.

Plan + Phase 2 + Phase 3 Round 1 + Round 2 — all findings closed.
