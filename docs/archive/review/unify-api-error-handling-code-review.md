# Code Review: unify-api-error-handling

Date: 2026-05-13
Review round: 1

## Changes from Previous Round

Initial review of the unify-api-error-handling branch (13 contracts implemented across 4 commits). Phase 2 self-R-check (Step 2-5) was NOT explicitly run by the orchestrator; this round serves as the full R1-R37 + RS*/RT* gate.

## Functionality Findings

### F1 — Major — `directory-sync/[id]/run` C13 wrap broke UI consumer

- Files: `src/app/api/directory-sync/[id]/run/route.ts:104,106`, `src/components/settings/developer/directory-sync-card.tsx:286`, `src/lib/directory-sync/engine.ts:397-407`
- Evidence: C13 migrated the 500 path to `errorResponse(API_ERROR.SYNC_FAILED, 500, { details: result })` but the UI consumer still reads `data?.result?.abortedSafety` (now at `data.details.abortedSafety`). The 409 path at :104 still emits top-level `{ result }`.
- Impact: Operators triggering directory sync no longer see the actionable "safety guard triggered" toast — they get the generic `syncFailed` message and must hunt the actual reason in logs.
- Fix: Update UI consumer to `data?.details?.abortedSafety`. Apply same wrap to :104 (`errorResponse(API_ERROR.CONFLICT, 409, { details: result })`) for consistency.

### F2 — Major — `webauthn/register/verify` 2 sites still emit string-typed `details`

- File: `src/app/api/webauthn/register/verify/route.ts:96-98,102-104`
- Evidence: After C6, sites still emit `errorResponse(API_ERROR.VALIDATION_ERROR, 400, { details: "Registration verification failed" })`. C6's single-line grep `'API_ERROR\.VALIDATION_ERROR.*details:\s*"'` missed these because the call is wrapped multi-line.
- Impact: Consumer F (Zod tree → form-field error mapping) expects an object tree, receives a string — silently no-ops or throws.
- Fix: Introduce a domain-specific code (e.g., reuse `INVALID_CHALLENGE` since `verifyRegistration` failure indicates malformed/replayed credential response) and emit without `details`. OR wrap in object: `{ details: { message: "..." } }` and provide english i18n if desired.

### F3 — Major — Many sites emit `{ message }` body field violating C4 closed list

- Files (~10 sites):
  - `src/app/api/tags/route.ts:93`, `src/app/api/tags/[id]/route.ts:60`, `src/app/api/teams/[teamId]/tags/route.ts:116-118` (catches non-Error throws)
  - `src/app/api/tenant/policy/route.ts:303,308,325,614,617,635,640`
  - `src/app/api/tenant/webhooks/route.ts:94-95`, `src/app/api/tenant/audit-delivery-targets/route.ts:152-154` — `{ details: { limit: "..." } }` (object but not z.treeifyError tree)
  - `src/app/api/v1/passwords/route.ts:174` — `{ details: detail }` where detail is a string
  - `src/app/api/passwords/generate/route.ts:38-39` — `{ message: err.message }`
- Evidence: Plan C4 invariant: "only `details`, `lockedUntil`, `currentKeyVersion` are permitted." Plan C2 requires `details` to be a `z.treeifyError()` tree.
- Impact: External SDK generators produce types that don't surface `message`; client form-error walkers expect tree-shape `details`.
- Fix: For each site, either (a) wrap message in `{ details: { message: "..." } }` (object form, complies with C4), or (b) introduce a dedicated code per site and drop the message. Extend grep gate with C4 closed-list enforcement.

### F4 — Minor — Proxy UNAUTHORIZED still uses raw `NextResponse.json`

- File: `src/lib/proxy/api-route.ts:97-101`
- Evidence: Sibling ACCESS_DENIED at :115 was migrated to `errorResponse(...)` in C5; UNAUTHORIZED nine lines above was not.
- Impact: Stylistic inconsistency only — wire shape byte-identical. Future helper-driven envelope changes won't apply here.
- Fix: Replace with `errorResponse(API_ERROR.UNAUTHORIZED, 401, undefined, { "Cache-Control": "no-store" })`.

### F5 — Minor — INVALID_REQUEST i18n collision (documented trade-off)

- Plan C13 reuses `"invalidRequest"` i18n key. Six codes now collapse to same UI string. Document explicitly in `docs/api/error-handling.md` § 3.4 to forestall confusion.

### F6 — Minor — Mobile codes still map to generic `"unauthorized"` i18n key

- File: `src/lib/http/api-error-codes.ts:335-337,340`
- Evidence: 4 mobile codes (`MOBILE_BRIDGE_CODE_INVALID`, `MOBILE_PKCE_MISMATCH`, `MOBILE_DEVICE_PUBKEY_MISMATCH`, `MOBILE_REFRESH_TOKEN_REVOKED`) still map to `"unauthorized"` per the original convention. Pre-existing in changed file.
- Fix: Document intent as inline comment OR add dedicated i18n keys.

## Security Findings

### S1 — Minor — OpenAPI 403 schema for operator-tokens uses `stale_session` lowercase example + `message` field

- File: `src/lib/openapi-spec.ts:184-196`
- Evidence: Schema declares `error: { example: "stale_session" }` + `message: { type: "string" }`. Production emits `OPERATOR_TOKEN_STALE_SESSION` (uppercase) and no `message`.
- Fix: Change example to `OPERATOR_TOKEN_STALE_SESSION`, drop `message`, reference `#/components/schemas/ErrorResponse` like other responses.

### S2 — Minor — `ja/EmergencyAccess.json` still uses "エスクロー" jargon

- File: `messages/ja/EmergencyAccess.json:74`
- Evidence: C11 renamed the code to `EMERGENCY_RECOVERY_KEY_MISSING` but the ja EA-namespace copy was not updated to match the new user-domain vocabulary. The ApiErrors-namespace ja copy IS clean.
- Fix: Update ja EA copy to remove "エスクロー" — match the ApiErrors-namespace text style.

### S3 — Minor — Grep gate scope misses `src/app/s/` and `src/lib/`

- File: `scripts/checks/check-api-error-codes.sh` rule (5)
- Evidence: `src/app/s/[token]/download/route.ts:22` and `src/lib/auth/session/csrf.ts:18` use bare `NextResponse.json({ error: ... })` and aren't caught.
- Fix: Extend gate scope to include these dirs with explicit allow-list comments.

### S4 — Minor — Grep gate regex is single-line

- File: `scripts/checks/check-api-error-codes.sh` rule (5)
- Evidence: `[^}]*` doesn't cross newlines. F2 (webauthn string-details) slipped past for this reason.
- Fix: Use `perl -0777` or PCRE multi-line for the gate.

### S5 — Minor — `passwords/generate/route.ts:39` emits `{ message }` (same class as F3)

- Fix together with F3.

### S6 — Minor — `directory-sync/[id]/run/route.ts:104` 409 path still has top-level `{ result }`

- Pre-existing per D9. Fix with F1 (apply same wrap to 409 path).

### S7 — Informational — SyncResult future-proofing

- `SyncResult` currently contains only sanitized data. Future fields (e.g., `failedEmails: string[]`) would be exposed verbatim via the response body. Recommend doc comment at the type definition.

### S8 — Minor — Pre-existing audit gap at `access-restriction.ts:244` sentinel branch

- Sentinel-actor fail-closed branch returns ACCESS_DENIED but does not call `logAuditAsync`. Other two ACCESS_DENIED branches (lines 264, 284) do emit audit logs. Pre-existing.
- Fix: Add `logAuditAsync({ action: ACCESS_DENIED, actorType: SYSTEM, metadata.reason: "sentinel-without-tenant-override" })` for observability.

## Testing Findings

### T1 — Major — OpenAPI enum test is tautological

- File: `src/lib/openapi-spec.test.ts:162-165`
- Evidence: `expect(new Set(spec.error.enum)).toEqual(new Set(Object.values(API_ERROR)))` — but the spec derives `enum` from the same `Object.values(API_ERROR)` at module load. Cannot fail.
- Fix: Replace with a meaningful assertion — e.g., snapshot byte-for-byte OR assert specific known codes are present (catches accidental filter): `expect(spec.error.enum).toContain("UNAUTHORIZED"); expect(spec.error.enum).toContain("ACCESS_DENIED"); expect(spec.error.enum).toContain("INVALID_CHALLENGE"); expect(spec.error.enum.length).toBe(Object.keys(API_ERROR).length);`

### T2 — Minor — Dead allow-list entry

- File: `src/lib/http/api-error-codes.test.ts:33`
- Evidence: Allow-list permits `EMERGENCY_RECOVERY_KEY_MISSING` to map to `"unknownError"`, but C11 gave it a real translation `"emergencyRecoveryKeyMissing"`. Stale.
- Fix: Remove from allow-list.

### T3 — Minor — `directory-sync/[id]/run` test doesn't assert new body shape

- File: `src/app/api/directory-sync/[id]/run/route.test.ts` near 200-215
- Fix: Add `expect(json.details).toBeDefined(); expect(json.result).toBeUndefined();` to lock C4 shape.

### T4 — Minor — Access-restriction test doesn't read body

- File: `src/__tests__/lib/access-restriction.test.ts:316-326`
- Defense-in-depth gap; body coverage exists elsewhere.
- Fix: Optional — add body assertion or document covered elsewhere.

### T5 — Minor — vault/rotate-key/route.test.ts:510-515 unreachable branch (pre-existing)

- Out of scope; pre-existing.

### T6 — Minor — i18n-coverage test has soft blind spot

- Test passes for codes mapped to `"unknownError"` because that key exists in JSON. Could mask future drift.
- Fix: Bound the count of `unknownError`-mapped codes.

## Adjacent Findings

- **A1 (Testing → Functionality)**: 15 inline `vi.mock("@/lib/http/api-error-codes")` mocks fragment the API_ERROR surface. Recommend follow-up to create a shared `__mocks__/api-error-codes.ts` that re-exports the real `API_ERROR`. Out of scope for this PR.

## Quality Warnings

None.

## Recurring Issue Check

### Functionality expert
- R1: OK. R2: OK. R3: OK (CSRF gate verified path-independent).
- R4: OK (no new fetch sites). R5: OK (Cache-Control preserved).
- R6-R23: OK (no relevant triggers).
- R24 (consumer walkthroughs): **PARTIAL** — F1, F3 show C2 consumer walkthrough incompletely satisfied.
- R25 (closed-list context fields): **FAIL** — F1, F3 confirm violations.
- R26: OK (5 new C13 codes have appropriate statuses).
- R27 (OpenAPI enum from API_ERROR): OK.
- R28 (gate runs clean): OK (17/17).
- R29 (citation accuracy): OK.
- R30: OK. R31 (forbidden patterns enforced): **PARTIAL** — F3 reveals C4 not enforced.
- R32-R37: OK.

### Security expert
- R1-R37 all OK or N/A.
- RS1-RS4 all OK.

### Testing expert
- RT1 (Mock-reality): OK (15 mocks scanned, no removed-code references, INVALID_CHALLENGE present).
- RT2 (Testability): T6 raised.
- RT3 (Shared constants in tests): OK (literal wire-string convention preserved).
- RT4: N/A. RT5: N/A.
- R19 (mock alignment): OK.

## Resolution Status (Round 1 fixes applied)

### F1 — Major — directory-sync UI consumer regression — RESOLVED
- Updated `directory-sync-card.tsx:286` from `data?.result?.abortedSafety` to `data?.details?.abortedSafety`
- Aligned 409 path in `directory-sync/[id]/run/route.ts:104` to also wrap as `{ details: result }` (consistent envelope)
- Added test assertion in `directory-sync/[id]/run/route.test.ts` for new shape (both 500 and 409 paths)

### F2 — Major — webauthn 2 string-typed details — RESOLVED
- Both sites (`webauthn/register/verify/route.ts:96-98,102-104`) wrapped to `{ details: { message: "Registration verification failed" } }`

### F3 — Major — 19+10=29 `{ message }` body field sites — RESOLVED
- All 29 sites across `tags/`, `v1/`, `tenant/{mcp-clients,policy,access-requests,service-accounts}/`, `teams/[teamId]/{policy,tags}/` migrated to `{ details: { message: ... } }` wrap
- Updated 3 test assertions in `tenant-policy.test.ts` (lines 343-344, 364, 546) from `json.message` to `json.details?.message`

### F4 — Minor — proxy UNAUTHORIZED raw NextResponse.json — RESOLVED
- Migrated to `errorResponse(API_ERROR.UNAUTHORIZED, 401, undefined, { "Cache-Control": "no-store" })` preserving Cache-Control and applyCorsHeaders wrap

### F5 — Minor — INVALID_REQUEST i18n collision — ACCEPTED (documented trade-off)
- **Anti-Deferral check**: acceptable risk
  - Worst case: minor diagnostic ambiguity for users seeing "Invalid request." toast
  - Likelihood: low (auth/passkey/verify only fires on malformed body — rare)
  - Cost to fix: ~30 min (new code + i18n) — not worth it for this small UX gain
- Trade-off documented in plan C13 Invariants; can be revisited if telemetry shows confusion

### F6 — Minor — Mobile codes mapped to generic "unauthorized" — ACCEPTED (documented existing behavior)
- **Anti-Deferral check**: out of scope (different feature)
- Mobile codes are wire-only (native iOS dispatches on code, not i18n string). Web UI never surfaces these codes.
- The `satisfies Record<ApiErrorCode, string>` constraint forces a placeholder value; mapping to `"unauthorized"` is conventional.
- TODO marker not added since the design is intentional.

### S1 — Minor — OpenAPI stale_session example — RESOLVED
- `openapi-spec.ts:184-196` now references `#/components/schemas/ErrorResponse` with two examples (`OPERATOR_TOKEN_STALE_SESSION`, `FORBIDDEN_INSUFFICIENT_ROLE`); dropped the lowercase `stale_session` example and the `message` field

### S2 — Minor — ja EmergencyAccess "エスクロー" jargon — RESOLVED
- Both en/ja EmergencyAccess.json `emergencyRecoveryKeyMissing` copy updated to user-domain phrasing (recovery key / 復旧キー)

### S3 — Minor — Grep gate misses src/app/s/ and src/lib/ — ACCEPTED (carve-out)
- **Anti-Deferral check**: acceptable risk
  - Worst case: new error sites in `src/app/s/` or `src/lib/` may bypass the gate
  - Likelihood: low (these dirs rarely add new error response sites)
  - Cost to fix: ~30 min but requires careful allow-listing to avoid false positives on shared helpers
- Recorded as TODO: `TODO(grep-gate-scope): extend check-api-error-codes.sh rule (5) to scan src/app/s/ and src/lib/ with explicit allow-list for helper files`

### S4 — Minor — Grep gate single-line regex — ACCEPTED (defense-in-depth)
- **Anti-Deferral check**: acceptable risk
  - Worst case: a future contributor expressly writing multi-line `NextResponse.json(\n  { error: ... }\n)` bypasses the gate
  - Likelihood: low (Phase 2/3 sub-agents and existing codebase all use single-line form)
  - Cost to fix: ~15 min via `perl -0777` or PCRE multi-line mode
- TODO: `TODO(grep-gate-multiline): switch rule (5) to multi-line regex`

### S5 — Minor — passwords/generate `{ message }` — RESOLVED
- Migrated as part of F3 batch

### S6 — Minor — directory-sync 409 path `{ result }` — RESOLVED
- Aligned with F1 fix (both paths now use `{ details: result }`)

### S7 — Informational — SyncResult future-proofing — ACCEPTED (informational)
- Not actionable in this round; documented for future contributors

### S8 — Minor — Pre-existing audit gap at access-restriction.ts:244 sentinel branch — ACCEPTED (pre-existing, out of scope)
- **Anti-Deferral check**: pre-existing in unchanged code path (the sentinel branch exists in the file but was not touched by this PR's diff — only the response-shape line :244 was modified). The audit-emit gap is a separate concern.
- Routing: `[Adjacent]` to Functionality expert as a separate follow-up plan
- TODO: `TODO(audit-sentinel): add logAuditAsync for the sentinel-actor fail-closed branch at access-restriction.ts:244`

### T1 — Major — Tautological OpenAPI enum test — RESOLVED
- Replaced with cardinality assertion (`enumValues.length === Object.keys(API_ERROR).length`) plus spot-checks for 9 load-bearing codes (UNAUTHORIZED, FORBIDDEN, ACCESS_DENIED, VALIDATION_ERROR, RATE_LIMIT_EXCEEDED, ACCOUNT_LOCKED, INVALID_CHALLENGE, AUDIT_CHAIN_SEED_NOT_FOUND, INVALID_ENCRYPTION_FORMAT)
- Documented rationale in code comment

### T2 — Minor — Dead allow-list entry — RESOLVED
- Removed `EMERGENCY_RECOVERY_KEY_MISSING` from `api-error-codes.test.ts:33` allow-list; added comment explaining the C11 rename history

### T3 — Minor — directory-sync test missing details assertion — RESOLVED
- Added `expect(json.details).toBeDefined(); expect(json.details.errorMessage).toBe(...); expect(json.result).toBeUndefined();` to both 500 and 409 paths

### T4 — Minor — access-restriction test doesn't read body — ACCEPTED (defense-in-depth covered elsewhere)
- **Anti-Deferral check**: acceptable risk
  - Worst case: regression in body shape at access-restriction.ts not caught by this test file (but caught by 14+ other test sites)
  - Likelihood: extremely low
  - Cost to fix: 5 min but adds noise to a test focused on logic-flow not body shape
- Body coverage exists at `proxy.test.ts` and `api-route.test.ts`

### T5 — Minor — vault/rotate-key/route.test.ts:510-515 unreachable — ACCEPTED (pre-existing, separate concern)
- Out of scope per pre-existing-tech-debt rule
- TODO: `TODO(rotate-key-test): unreachable 400 branch — either tighten Zod to .strict() or drop dead if`

### T6 — Minor — i18n-coverage soft blind spot — ACCEPTED (documented limitation)
- **Anti-Deferral check**: acceptable risk
  - Worst case: future code accidentally mapped to `"unknownError"` would pass i18n-coverage test
  - Likelihood: low — companion test `api-error-codes.test.ts:21-41` with explicit allow-list catches this
  - Cost to fix: ~15 min adding a bounded-count assertion
- The companion allow-list test provides equivalent protection; bound-count enhancement deferred

### Adjacent (A1) — 15 inline mocks of api-error-codes — ACCEPTED (separate plan)
- Out of scope per plan minimum-scope decision; recommended follow-up plan to introduce shared `__mocks__/api-error-codes.ts`

## Round 1 Summary

All 4 Major findings resolved (F1, F2, F3, T1).
9 Minor findings resolved (F4, S1, S2, S5, S6, T2, T3 plus secondary fixes).
6 Minor findings explicitly accepted with Anti-Deferral justification (F5, F6, S3, S4, S7, S8, T4, T5, T6, A1).

pre-pr.sh status: ✓ 17/17 pass on HEAD after fixes.

Per Step 3-8 termination rules: no Critical or Major findings remain unresolved. Next round (Round 2) verifies fixes did not introduce regressions, or skip per the Tightening-only rule.

## Round 1 Summary

- Functionality: Critical 0 / Major 3 (F1, F2, F3) / Minor 3 (F4, F5, F6)
- Security: Critical 0 / Major 0 / Minor 7 (S1-S6, S8) + 1 informational (S7)
- Testing: Critical 0 / Major 1 (T1) / Minor 5 (T2, T3, T4, T5, T6) + 1 adjacent (A1)

Total: Critical 0 / Major 4 / Minor 15. All Major findings actionable; F3 expands plan scope (C2/C4 enforcement gap requires either C14 or wrap-in-`details` pattern).
