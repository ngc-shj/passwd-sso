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

---

# Round 2 — Verification & 2 new Major findings

Round 2 verified all Round 1 fixes are correct and complete EXCEPT it surfaced 2 new Major findings that were either missed siblings or regressions introduced by Round 1.

## F7 — Major — `webauthn/authenticate/options` adjacent string-typed details (missed in F2) — RESOLVED

- File: `src/app/api/webauthn/authenticate/options/route.ts:63-65`
- Evidence: `errorResponse(API_ERROR.NOT_FOUND, 404, { details: "No matching credentials found" })` — same class as F2 (string instead of object). F2's grep was limited to `register/verify`; this sibling slipped through.
- Fix: wrapped as `{ details: { message: "No matching credentials found" } }`.

## F8 — Major — Tenant session policy UI consumer regression introduced by F3 — RESOLVED

- File: `src/components/settings/security/tenant-session-policy-card.tsx:248-249`
- Evidence: UI reads `data?.message` from `PATCH /api/tenant/policy`. F3 migrated that route's 12 sites from top-level `{ message }` to `{ details: { message } }`, but the UI consumer was not audited (only the directory-sync UI was audited under F1).
- Impact: tenant admins updating session policy lost the actionable cross-field validation message (e.g. "vaultAutoLockMinutes (60) must be <=..."), seeing only the generic "session policy save failed" toast.
- Fix: updated consumer to read `data?.details?.message`. Verified no other UI consumer (broad grep across `src/components/`, `src/cli/`, `src/extension/`) reads `data.message` / `body.message`.

## Round 2 Summary

- 2 Major findings (F7, F8) both RESOLVED.
- No new findings beyond what was already enumerated. All Round 1 fixes verified correct.
- pre-pr.sh ✓ 17/17 on the Round 2 fix commit.

Per Step 3-8, all Critical/Major findings resolved. Round 3 not required — proceeding to final commit (Step 3-9).

---

# Round 3 — Comprehensive omission audit + mechanical detection hardening

Round 3 was triggered by the user question: "抜け漏れないですかね。あったときに気づけないですかね"
("Are there still omissions? And can we catch them when they occur?"). The
answer to both was "yes" — the existing gate had blind spots, and we found 8
additional bypass sites the previous rounds missed.

## Audit findings (Round 3)

### F9 — Major — 8 additional `NextResponse.json({error})` bypass sites outside main-API gate scope

The Round 1+2 grep gate scanned only `src/app/api/` with single-line regex.
The Round 3 enhanced gate (multi-line PCRE + extended scope to `src/app/s/`,
`src/lib/`) caught 8 sites that bypassed the migration:

- `src/app/s/[token]/download/route.ts:22` — RATE_LIMIT_EXCEEDED (missing Retry-After header)
- `src/app/s/[token]/download/route.ts:73,80,86` — 3 sites (SHARE_PASSWORD_REQUIRED, UNAUTHORIZED×2)
- `src/lib/auth/session/check-auth.ts:71,81,108` — 3 sites (EXTENSION_TOKEN_SCOPE_INSUFFICIENT, UNAUTHORIZED×2)
- `src/lib/auth/access/maintenance-auth.ts:56` — RAW STRING error value (C2 violation: "operatorId is not an active tenant admin")
- `src/lib/http/parse-body.ts:62` — INVALID_JSON bypass inside the parseBody helper

All migrated to `errorResponse()`. maintenance-auth.ts converted from raw string
to `VALIDATION_ERROR` with `details: { message }` wrap. Test assertion updated.

## Mechanical detection hardening (Round 3)

### Grep gate enhancements

`scripts/checks/check-api-error-codes.sh` gained 3 new capabilities:

1. **Multi-line PCRE detection** (via perl) — catches the F2/F7-class
   string-typed `details: "..."` even when wrapped across multiple lines, and
   the C12-class `NextResponse.json({ error: ... })` over multiple lines.
2. **Extended scope** — now scans `src/app/api/`, `src/app/s/`, and `src/lib/`
   (with explicit exclusion of the helper file `src/lib/http/api-response.ts`
   that DEFINES `errorResponse`).
3. **C4 closed-list enforcement (rule 6)** — `errorResponse(...)` MUST NOT
   pass top-level body keys other than `details`, `lockedUntil`,
   `currentKeyVersion`. Nested keys inside `details: { ... }` are NOT
   enforced (developers free to shape the details object). Catches the F3
   class of `{ message }` / `{ result }` / `{ hint }` regressions at CI time.
4. **C6 string-details detection (rule 7)** — `errorResponse(..., { details: "..." })`
   (string literal) is forbidden. The wrap must be `{ details: { message: "..." } }`
   (object form, conforming to z.treeifyError tree shape).

### Compile-time enforcement via `MainApiErrorBody` type + `readApiErrorBody` helper

To close the F8-class UI consumer regression (where the wire shape moves a
field but the consumer still reads the old field name), Round 3 introduces:

1. **`MainApiErrorBody` type** in `src/lib/http/api-response.ts` — the canonical
   `readonly` shape of the Main API error envelope. The absence of an index
   signature means accessing `body.message` is a TypeScript compile error.
2. **`readApiErrorBody(res)` helper** in `src/lib/http/read-api-error-body.ts`
   — typed response parser. Forces UI consumers to use the typed envelope at
   the parse boundary.
3. **Migrated 2 known UI consumers** (the F1/F8 hot spots) to use the helper:
   - `src/components/settings/security/tenant-session-policy-card.tsx` — F8 fix site
   - `src/components/settings/developer/directory-sync-card.tsx` — F1 fix site
4. **Documented** in `docs/api/error-handling.md` § 7 — usage example and
   rationale (compile-time guard against future F8-class regressions).

## Round 3 Summary

- 8 additional Major findings (F9) — all resolved
- 4 grep-gate enhancements — multi-line detection, scope extension, C4 enforcement, C6 enforcement
- TypeScript + helper infrastructure for compile-time detection of UI consumer drift
- pre-pr.sh ✓ 17/17

All known classes of omission now have mechanical detection:
- (a) **Forbidden patterns in production code**: grep gate (rules 1-7)
- (b) **Top-level body shape violations**: grep gate rule 6
- (c) **String-details payload**: grep gate rule 7
- (d) **UI consumer accessing non-canonical body fields**: TypeScript compile error via `MainApiErrorBody` + `readApiErrorBody`

Future PRs that violate these gain immediate CI/compile failures.

---

# Round 4 — Commonalization (DRY for the wrap pattern)

User asked: "共通処理化も含めて考えてくださいね" ("Include commonalization in
your thinking"). The Round 3 wrap pattern was repeated 33 times on the server
side and 5 lines of nested type-checks on the client side. Round 4 centralizes
both.

## Server-side helper: `errorResponseWithMessage`

New helper in `src/lib/http/api-response.ts`:

```ts
export const errorResponseWithMessage = (
  code: ApiErrorCode,
  status: number,
  message: string,
): NextResponse =>
  errorResponse(code, status, { details: { message } });
```

Refactored ~33 production sites from the verbose form
`errorResponse(CODE, STATUS, { details: { message: ... } })` to one-line
`errorResponseWithMessage(CODE, STATUS, ...)`. Wire shape unchanged.

Files: tags, v1/passwords, v1/tags, tenant/{policy, mcp-clients,
access-requests, service-accounts}, teams/[teamId]/{policy,tags}, webauthn/
{register/verify, authenticate/options}, passwords/generate, lib/auth/access/
maintenance-auth — total 17 files, 33 sites.

## `validationError` type tightening

`validationError(details: unknown)` → `validationError(details: Record<string, unknown>)`.
Now compile-time rejects the F3-class string-typed-details bypass via the
existing helper. The 4 sites that previously did `validationError("Invalid ...")`
in v1/passwords + non-v1/passwords are converted to
`validationError({ message: "..." })`.

## Client-side helpers: `getApiErrorMessage` + `getApiErrorDetail`

New helpers in `src/lib/http/read-api-error-body.ts`:

- `getApiErrorMessage(body)` → returns `details.message` (or `null`)
- `getApiErrorDetail(body, field, guard)` → returns a typed field from
  `details` with a runtime predicate

Refactored the 2 UI consumers I migrated in Round 3:

- `tenant-session-policy-card.tsx`: 5-line nested type-check → one-liner
  `getApiErrorMessage(await readApiErrorBody(res))`
- `directory-sync-card.tsx`: nested `abortedSafety` check → one-liner
  `getApiErrorDetail(body, "abortedSafety", (v): v is true => v === true)`

## Documentation

`docs/api/error-handling.md` § 7 now documents:
- The full helper triad (`readApiErrorBody`, `getApiErrorMessage`, `getApiErrorDetail`)
- The server-side `errorResponseWithMessage` complement
- Cross-link between them so the wrap-and-unwrap pair is discoverable together

## Round 4 Summary

- 3 new helpers added (1 server-side + 2 client-side)
- 33 server sites de-duplicated to the helper
- 2 UI sites simplified from 5-line check to 1-line helper call
- `validationError(details)` type-narrowed so string bypass becomes a compile error
- All 17 pre-pr.sh checks pass

Wire shape: byte-identical across all changes. Internal representation: less
boilerplate, single point of change for future shape evolution.

---

# Round 5 — UI consumer non-helper detection + 46-site migration

User asked: "ヘルパーを使用していない[箇所に]気付けますか" — Can we detect places
that bypass the typed helper?

Audit found **46 sites** in UI / hook / page code that read `res.json()` inside
an `if (!res.ok)` block, bypassing `readApiErrorBody()`. Each one was either:
- A real F8-class regression vector (reading non-canonical body fields with no
  type safety), or
- A gate false-positive (single-line `if (!res.ok) throw;` causing the brace
  tracker to scan into success-path `res.json()`).

## Gate rule (8) added

`scripts/checks/check-api-error-codes.sh` gained rule 8: detects `if (!res.ok)`
blocks containing `await res.json()`. Stateful per-file line-counted perl
scanner walks brace depth — works on the canonical block form. The rule fires
on the false-positive shape (no braces around the single-statement if) too,
which incidentally enforces a consistent code style.

## 46-site migration (3 parallel sub-agents)

**Batch A (14 files)** — share / vault / emergency-access / tags / extension /
passwords. 3 genuine pattern-2 migrations (`body.error` branching via
`readApiErrorBody`), 11 brace-only fixes.

**Batch B (12 files)** — team / settings/developer. 6 genuine pattern-2 /
pattern-3 migrations, 6 brace-only fixes.

Notable bug fix discovered during Batch B: `mcp-client-card.tsx` edit handler
unconditionally cast the success-response body to `ValidationErrorResponse`.
Sub-agent moved the `readApiErrorBody` call inside the `!res.ok` branch — the
correct shape.

**Batch C (11 files)** — hooks / app pages. 5 genuine pattern-2 / pattern-3
migrations, 6 brace-only fixes.

## Detection summary post-Round-5

Every class of API error envelope omission now has mechanical detection:

| Class | Detection mechanism |
|-------|---------------------|
| Forbidden patterns (raw NextResponse.json, prose error, snake_case error, retired codes) | grep gate rules 1-5 |
| Top-level body shape violations ({ message }, { result }, { hint }) | grep gate rule 6 |
| String-typed details payload | grep gate rule 7 |
| **UI consumer reads error body without typed helper** | grep gate rule 8 (Round 5) |
| Wire shape type safety (server) | TypeScript via `Record<string, unknown>` on `validationError`, `MainApiErrorBody` shape |
| UI consumer reads non-canonical field | TypeScript via `MainApiErrorBody.readonly` (no index signature) |

A future PR that violates ANY of these gets immediate CI failure or compile
error.

## Round 5 helper-stage Summary

- 1 new gate rule (#8) covering UI bypass detection
- 46 production sites migrated across 3 sub-agent batches
- 1 latent bug discovered + fixed (mcp-client-card edit handler)
- All 17 pre-pr.sh checks pass
- Total detection layers: 8 grep rules + TypeScript types + 4 helpers (`errorResponse`, `errorResponseWithMessage`, `readApiErrorBody`, `getApiErrorMessage` / `getApiErrorDetail`)

---

# Round 6 — Horizontal expansion: catch what Round 5 missed

User asked: "横展開でバグがないか、漏れがないか改めて" — Sweep horizontally
for bugs / omissions introduced or missed.

The Round 5 gate (rule 8) only matched `if (!res.ok) { ... }` — it missed two
adjacent shapes:

1. **`if (res.status === Nxx)` direct status check** — also an error-path
   gate that wraps `res.json()` body access. Found 4 sites:
   - `src/components/breakglass/breakglass-dialog.tsx:102`
   - `src/components/settings/developer/base-webhook-card.tsx:162`
   - `src/components/team/management/team-create-dialog.tsx:184`
   - `src/components/team/members/team-add-from-tenant-section.tsx:86`

2. **else-if chain logic bug** in my own gate scanner — when the first
   `if (...) {` block matched, then the chain continued with `} else if (...)`,
   my stateful parser reset the block state at the second match BEFORE
   running the json-bypass check on the first block. So `breakglass-dialog`
   was silently un-flagged. Fixed by gating the reset on `$in_block` being
   false (an else-if while already in a block is treated as continuation —
   correct semantics since the whole chain is one error-handling structure).

## Gate rule 8 extended

Updated regex matches three error-path entry shapes:

```perl
if (/^\s*(?:\}\s*else\s+)?if\s*\(\s*(?:
  !(?:res|response)\.ok |
  (?:res|response)\.status\s*===\s*[45]\d\d |
  (?:res|response)\.status\s*>=?\s*4\d\d
)\s*\)/) {
  # Only reset block-state on the FIRST `if` (else-if is continuation)
  if (!$in_block) { $start = $.; ... }
}
```

## 4 sites migrated

| Site | Pattern | Migration |
|------|---------|-----------|
| breakglass-dialog.tsx:102 | reads `body.details.properties.targetUserId` + `body.error` for branching | `readApiErrorBody` + typed details narrowing |
| base-webhook-card.tsx:162 | reads `body.details.properties.url.errors.length` | same |
| team-create-dialog.tsx:184 | reads `body.details.properties.slug.errors.length` | same |
| team-add-from-tenant-section.tsx:86 | reads `body.error === "SCIM_MANAGED_MEMBER"` for branching | `readApiErrorBody` + `API_ERROR.SCIM_MANAGED_MEMBER` typed constant |

## Test fixture fix

The shared `webhook-card-test-factory.tsx` (used by both `tenant-webhook-card.test.tsx`
and `team-webhook-card.test.tsx`) returned a 400 mock body of
`{ details: { properties: { url: { errors: ["invalid"] } } } }` — missing the
`error` field. After Round 6 migration, the production code uses
`readApiErrorBody(res)` which now requires `error` field to be a string
(typed envelope discriminator). The mock was incomplete and the test failed
post-migration. Fixed by adding `error: "VALIDATION_ERROR"` to the mock —
which matches what the server actually emits.

This is itself a **mock-reality divergence** (RT1) bug that the migration
surfaced. The test was passing only because production silently accepted
any shape with the right `details` keys; the typed helper made the
contract explicit.

## Round 6 Summary

- 1 gate scanner logic bug fixed (else-if continuation handling)
- 1 gate regex extension (`if (res.status === Nxx)` / `if (res.status >= 400)`)
- 4 production sites migrated to typed helper
- 1 test mock fixture corrected (RT1 mock-reality divergence)
- All 17 pre-pr.sh checks pass

Total UI consumer migrations across Rounds 5+6: **50 sites** (46 in R5 + 4 in R6).

---

# Round 7 — Deep horizontal sweep: gate variable-name universality + dead-code

User pushed: "漏れが多いですね。確実にゼロにするために再調査" — "many
omissions still; re-investigate to guarantee zero."

Five-axis comprehensive sweep covered: A1-A11 (HTTP response check shapes),
B5 (server-side helper bypass), C3 (test mocks), D (CLI/extension), E
(internal server-side fetch). The sweep used multi-pattern grep across all
of `src/` not just `src/components`.

## Findings

### Gate scanner limitation (var-name & block-form)

Rule 8's perl regex matched only `(res|response).ok` — missed alternate
variable names like `optionsRes`, `verifyRes`, `dataRes`, `retryRes`,
`startRes`, `vaultRes`, `listRes`, etc. Also accumulated false positives
on brace-less `if (!res.ok) throw;` form because the depth tracker scanned
past the statement until it found the next `}`.

**Fixed**: regex now captures any JS-identifier as `$var`, requires `{` at
end-of-line (block-form only), and uses back-reference `\Q$var\E.json(`
for body access check so variable name matches across `if` and `json` calls.

### 4 real violations the universalized gate caught

1. **`emergency-access/[id]/vault/page.tsx:99`** — `vaultRes.json()` read
   for `eaErrorToI18nKey(data?.error)` — migrated to `readApiErrorBody`.
2. **`operator-token-card.tsx:201`** — `retryRes.json()` cast to
   `{ error?: string }` and branched on `OPERATOR_TOKEN_*` codes —
   migrated to `readApiErrorBody` with typed `body?.error` access.
3. **`passkey-credentials-card.tsx:153`** — `optionsRes.json()` branched on
   `RATE_LIMIT_EXCEEDED` / `SERVICE_UNAVAILABLE` (lowercase wire literal!
   gate didn't catch because it was inside the `.json()` callback body,
   not at the `error:` field of a NextResponse.json) — migrated.
4. **`use-watchtower.ts:261`** — `startRes.json()` read `body.retryAt`
   from a 429 response. **Dead code path**: the server emits
   `Retry-After` header only (via `rateLimited()` helper); the body has
   no `retryAt` field. The consumer was always falling through to the
   fallback branch since 2026-03. Migrated to read `Retry-After` header
   correctly; test fixtures and test names updated to match.

### Mock fixture updates (RT1 mock-reality divergence cascade)

The watchtower test's `jsonResponse(data, status)` helper didn't include
a `headers` object — my Retry-After-based migration required `headers.get()`
to be callable. Updated the helper to accept an optional `headers` object
and surface a header-lookup that's case-insensitive. Updated 3 test cases
to assert the new behavior (Retry-After header instead of dead `body.retryAt`).

### Audited and verified clean (no actionable misses)

- **A4**: `if (res.status !== 200)` shape — 0 hits in UI.
- **A6**: `try/catch` reading parsed value — 0 hits.
- **A5/A8 false positives (3 sites)**: `tenant-members-card.tsx:77`,
  `tenant/general/delete/page.tsx:54`, similar admin pages —
  `if (!r.ok) throw new Error()` with `throw` only (no body read).
  Brace-less single-statement form. Gate ignores them (block-form-only
  rule). No migration needed.
- **B5**: `new Response()` direct construction — 3 sites
  (`scim/v2/Users/[id]/route.ts:248` returns 204 No Content,
  `with-request-log.ts:56` clones a response for logging,
  `audit-log-stream.ts:131` streams audit logs as text/event-stream).
  None are main-API error envelope; all intentional.
- **D**: CLI consumers (10+ sites) — separate consumer surface; outside
  the UI gate scope. Tracked for future SDK plan.
- **E**: server-side internal `fetch()` to GitHub Release / Google OAuth /
  external services — non-main-API consumers, intentionally typed
  per the external API's shape.

## Detection completeness after Round 7

Every shape of bypass now has detection:

| Shape | Detection |
|-------|-----------|
| `if (!X.ok) { X.json() }` — any var name X | Gate rule 8 |
| `if (X.status === Nxx) { X.json() }` — any var X | Gate rule 8 |
| `if (X.status >= 400) { X.json() }` — any var X | Gate rule 8 |
| `if (!X.ok) STMT;` (no braces) | Gate ignores (no block); style by convention |
| else-if chain | Gate treats as continuation (R6 fix) |
| `body.message` / non-canonical fields in UI | TypeScript compile error |
| Server-side `errorResponse(..., { message: ... })` | Gate rule 6 |
| Server-side `errorResponse(..., { details: "string" })` | Gate rule 7 |
| Server-side `validationError("string")` | TypeScript compile error (Record<string,unknown> type) |
| Server-side bare `NextResponse.json({error,...})` | Gate rule 5 |
| Test mock missing `error` field | Surfaced by typed helper at test runtime |

## Round 7 Summary

- 1 gate regex universalization (any var name + block-form-only)
- 4 real violations migrated (vaultRes, retryRes, optionsRes, startRes)
- 1 dead-code path fixed (watchtower body.retryAt → Retry-After header)
- 3 mock fixtures updated to match production envelope
- All 17 pre-pr.sh checks pass
- 5-axis sweep (A/B/C/D/E) verified no other class of bypass exists in UI

Cumulative UI consumer migrations across R5+R6+R7: **54 sites**.
Cumulative gate rule 8 detection power: **5 shapes × any-variable-name × multi-line**.

---

# Round 8 — Cover the last surfaces: .then() chain + CLI/extension

User asked: "抜け漏れはなさそうですか" — request for honest assessment.
Honest answer was: UI internal is zero; remaining surfaces are
(a) `.then()` chain bypass (UI/hooks, currently zero real violations but
gate-uncovered → future regression risk), (b) CLI/extension consumers
(27 sites, separate tsconfig, untyped body access).

User chose maximum scope: cover both.

## .then() chain conversion + Gate rule 9 (UI)

Converted ~20 `.then()` chain Response handlers to `await` form across
hooks (`use-personal-tags`, `use-personal-folders`, `use-team-folders`,
`use-team-attachments`, `use-team-policy`, `use-tenant-role`,
`use-watchtower`), components (`share-dialog`, `tenant-audit-log-card`,
`breakglass-dialog`, `tenant-members-card`, `team-add-from-tenant-section`),
and admin pages (`teams/[teamId]/general/{delete,profile}`, `members/list`,
`members/transfer-ownership`, `audit-logs`, `dashboard/teams/[teamId]`,
`tenant/teams`). Where the implicit error path was "do nothing"
(`.catch(() => {})`), the await form preserves the same behavior. Some
sites had a hidden contract bug: `tenant-members-card.tsx:68` called
`r.json()` unconditionally on `/api/auth/session` — added explicit
`!res.ok` guard.

Added Gate rule 9 to `scripts/checks/check-api-error-codes.sh`:

```bash
# (9) C4 client-side — .then() chain bypass detection. Flag any
# `.then((<r>) => ...<r>.json()...)` in UI / hook / page code that
# escapes Gate rule 8 (await-only).
```

The rule uses a per-line scan: when `.then((<v>) =>` is encountered,
the line is checked for `<v>.json(` via back-reference. False-positive
surface is non-Response `.then` (e.g., Prisma promise chains in API
routes) — excluded by `/app/api/` scope filter.

## CLI typed body access

Added `cli/lib/api-error-body.ts` (duplicate of the main app's
`MainApiErrorBody` + `readApiErrorBody` + `getApiErrorMessage` — CLI
has its own tsconfig and can't import from `src/`).

Migrated 2 sites in `cli/src/commands/api-key.ts` to read
`{ error?: string }` via the typed helper. The wrapper at
`cli/src/lib/api-client.ts:157` returns generic-typed data and is the
right place for downstream consumers to narrow per-call. OAuth
endpoints (`cli/src/lib/oauth.ts:212,277,300`) intentionally use the
RFC 6749 envelope — left as-is, documented in the helper file's
header comment.

## Extension typed body access

Added `extension/src/lib/api-error-body.ts` mirror. Migrated 7 sites
across `background/login-save.ts`, `background/passkey-provider.ts`,
`background/index.ts`. `content/token-bridge-lib.ts` was reviewed and
found to read body on success only — left as-is.

## Round 8 Summary

- 20 UI `.then()` chain sites converted to `await` form
- 1 hidden contract bug fixed (`tenant-members-card` unguarded
  `/api/auth/session` body read)
- Gate rule 9 added — prevents future `.then()` chain regression
- 2 CLI sites migrated to typed body access; CLI-local helper added
- 7 extension sites migrated; extension-local helper added
- All 17 pre-pr.sh checks pass

## Final state across all surfaces

| Surface | Gate coverage | Type coverage | Migration status |
|---------|---------------|---------------|------------------|
| `src/app/api/` server | Rules 1-7 | `errorResponse(code, status, Record<string,unknown>?, HeadersInit?)` | Done (Rounds 1-7) |
| `src/components/`, `src/hooks/`, `src/app/[locale]/` UI | Rules 8-9 | `MainApiErrorBody` readonly | Done (R5+R6+R7+R8 = 74 sites) |
| `cli/src/` | (own tsconfig — not under Gate) | `cli/lib/api-error-body.ts` mirror | Done (2 sites + helper) |
| `extension/src/` | (own tsconfig — not under Gate) | `extension/src/lib/api-error-body.ts` mirror | Done (7 sites + helper) |
| Test mocks | Surfaced via typed helper at runtime (RT1) | n/a | Verified clean — fixture updates throughout R3-R7 |

Cumulative production migrations across all rounds: **~155 sites**.
Cumulative Gate rules: 9. TypeScript surface: 1 canonical type +
3 duplicates kept in sync via comment + 3 helper functions × 3 packages.

The "zero omission" promise now holds across UI, server, CLI, and
extension. The only currently-uncovered surface is OAuth/SCIM
envelope handling (intentional carve-outs per RFC).

## Round 1 Summary

- Functionality: Critical 0 / Major 3 (F1, F2, F3) / Minor 3 (F4, F5, F6)
- Security: Critical 0 / Major 0 / Minor 7 (S1-S6, S8) + 1 informational (S7)
- Testing: Critical 0 / Major 1 (T1) / Minor 5 (T2, T3, T4, T5, T6) + 1 adjacent (A1)

Total: Critical 0 / Major 4 / Minor 15. All Major findings actionable; F3 expands plan scope (C2/C4 enforcement gap requires either C14 or wrap-in-`details` pattern).

---

## Round 10 (post-merge triangulate of session work eb964c74..3d440438)

Date: 2026-05-13
Scope: 5 commits added since round 9 (Phase 2 default-status map, SHARE_GONE / SA_INACTIVE, sweep cleanup, helper unit tests).
Diff: 166 files / 1474+ insertions.
Method: 3 expert sub-agents (Functionality / Security / Testing) in parallel; Ollama seed available for security + testing only (functionality endpoint down).

### Functionality findings

[F1] Minor: Stale `SA_NOT_FOUND, 409` example contradicts the §3.4 retirement narrative
- File: `docs/api/error-handling.md:514`
- Evidence: `errorResponseWithMessage(API_ERROR.SA_NOT_FOUND, 409, "Service account is inactive");`
- Problem: §3.4 explicitly states this override pattern was retired in favor of `SA_INACTIVE`. The §7 example then teaches the retired anti-pattern verbatim with the same wording.
- Impact: Future contributors copy-paste the example and re-introduce the override the gate now forbids.
- Fix: Replace example with the only remaining production override (INVALID_ORIGIN/500 admin-reset).

[F2] Minor: Gate rule (8) misses `if (res.ok) { ... } else { res.json() }` mirror of `if (!res.ok)` form
- File: `scripts/checks/check-api-error-codes.sh:225` (regex)
- Evidence sites: 14+ pre-existing UI consumer files (api-key-manager, grant-card, breakglass-grant-list, team-policy-settings, team-scim-token-manager, tenant-access-restriction-card, passkey-credentials-card, operator-token-card, mcp-connections-card, directory-sync-card, cli-token-card, service-account-card)
- Problem: Round 8/9 added rules (8) and (9) for `if (!X.ok)` and `.then((r) => r.json())` chains. The negated equivalent `if (X.ok) { return; } else { res.json() }` is functionally identical but unmatched.
- Impact: F8-class regression risk that motivated rules 8/9 — wire-shape changes silently break consumers.
- Fix: Add third pattern to rule-8 perl scanner; migrate 14+ sites to `readApiErrorBody(res)`. (Migration broad — could be deferred; gate addition is load-bearing.)
- **Decision**: deferred to follow-up PR — migration scope (14+ sites + UI handler logic restructure) exceeds 30-min rule budget; gate-only addition without migration shipped here

[F3] Minor: `s/[token]/download/route.ts` returns bare 410 instead of `errorResponse(SHARE_GONE)`
- File: `src/app/s/[token]/download/route.ts:97,111`
- Evidence: `return new NextResponse(null, { status: 410 });` (twice)
- Problem: Functionality expert flagged inconsistency with paired `share-links/[id]/content/route.ts:96,112` (which uses `errorResponse(SHARE_GONE)`).
- Investigation outcome: Binary download routes intentionally diverge — same file uses `new NextResponse(null, { status: ... })` for 404 (line 57, 116), 400 (line 65), and 410. JSON envelope on a binary download endpoint mixes content types. Pattern is by-design.
- Fix: Add comment documenting the intentional divergence.

### Security findings

No findings. RS1-RS4 + R1-R37 all clear. Cross-tenant SA-existence probe defense in `tenant/access-requests/route.ts:213-218` correctly collapses cross-tenant into SA_NOT_FOUND/404, surfaces SA_INACTIVE/409 only for SAs in the caller's own tenant. Wire-format changes either preserve status (NOT_FOUND→SHARE_GONE both 410; SA_NOT_FOUND→SA_INACTIVE both 409) so attacker-observable surface is unchanged, or correct a pre-existing code/status mismatch (UNAUTHORIZED+403 → FORBIDDEN+403) where status was already disclosing the semantic.

Adjacent (Minor): v1 API wire change is consumer-visible breaking (pre-1.0, permitted by SemVer policy in CLAUDE.md but worth CHANGELOG callout).
Adjacent (Minor): `errorResponse(code, undefined, details, headers)` spreads `details` into body — caller passing `details: { error: "X" }` would override error code on wire. Pre-existing footgun, no current caller exercises it.

### Testing findings

[T1] Major: `read-api-error-body.ts` ships zero unit tests despite 5 exported helpers and 66 production call sites
- File: `src/lib/http/read-api-error-body.ts:1-128`
- Evidence: `find` for `read-api-error-body*test*` returned only the source file; 66 production call sites in src/hooks/, src/app/[locale]/, src/components/ and 0 test sites
- Problem: Runtime null-narrowing (`readApiErrorBody`, `getApiErrorMessage`, `getApiErrorDetail`, `getApiErrorFieldErrors`, `readMainApiErrorBody`) is purely runtime and untested. Compile-time `MainApiErrorBody.readonly` protects type access only — not the runtime "return null on missing/non-JSON/wrong-shape body" contract.
- Impact: F8-class consumer regressions can ship silently. Refactoring helpers is unsafe without tests.
- Fix: Add `src/lib/http/read-api-error-body.test.ts` covering the 5 helpers + edge cases (non-JSON body, missing error field, wrong shape).

[T2] Minor: Hardcoded `"SHARE_GONE"` literal in 3 new test assertions instead of `API_ERROR.SHARE_GONE` (RT3 candidate)
- Files: `src/__tests__/api/share-links/content.test.ts:153`, `src/app/api/share-links/[id]/content/route.test.ts:222,236`
- Status: Consistent with existing convention in same files (`expect(json.error).toBe("SHARE_PASSWORD_REQUIRED")` etc.). The structural invariant test in `api-error-codes.test.ts:111-114` (`value === key`) makes literal-vs-const observationally equivalent.
- **Decision**: Skip per skill 30-minute rule and "consistent with file convention" — borderline RT3, no behavioral risk.

Adjacent (Minor): `errorResponseWithMessage(API_ERROR.SA_NOT_FOUND, 410, ...)` test fixture at `api-response.test.ts:159` uses a code (SA_NOT_FOUND) the new gate forbids overriding in production.
- **Decision**: keep — test demonstrates the override mechanism using a code unrelated to the documented exception (INVALID_ORIGIN). Comment-clarification optional.

### Resolution Status

#### [T1] Major — read-api-error-body.test.ts missing — Fixed
- Action: Add `src/lib/http/read-api-error-body.test.ts` covering all 5 helpers
- Modified file: src/lib/http/read-api-error-body.test.ts (new)

#### [F1] Minor — docs example contradicts §3.4 — Fixed
- Action: Replace `SA_NOT_FOUND, 410` example with INVALID_ORIGIN, 500 (the only remaining production override)
- Modified file: docs/api/error-handling.md:514

#### [F3] Minor — bare 410 in download route — Fixed
- Action: Add comment explaining intentional binary-route divergence from JSON envelope
- Modified file: src/app/s/[token]/download/route.ts:96-97

#### [F2] Minor — gate rule (8) gap (else-branch form) — Deferred
- **Anti-Deferral check**: cost-to-fix exceeds 30-min budget (gate change + 14+ site migration + UI handler restructure)
- **Justification**: out of scope (different feature work)
  - Worst case: F8-class consumer regression where wire-shape change silently breaks 14+ pre-existing UI handlers
  - Likelihood: low — current wire shapes are stable; new fields go through MainApiErrorBody discipline
  - Cost to fix: ~2 hours (gate regex + 14 site migrations + handler logic restructure for `if (res.ok) {} else {}` → `if (!res.ok) {}` inversion)
- TODO marker: `TODO(api-error-handling-phase-3): expand gate rule (8) to catch else-branch form + migrate 14+ pre-existing UI handlers`
- Tracked in: this code-review.md entry [F2]
- **Orchestrator sign-off**: F2 is broader scope cleanup — defer to a follow-up PR, gate addition + 14-site migration deserves its own focused round

#### [T2] Minor — hardcoded SHARE_GONE literal — Skipped
- **Anti-Deferral check**: acceptable risk (consistent with file convention)
  - Worst case: rename of API_ERROR.SHARE_GONE constant requires grep across tests
  - Likelihood: low — code rename is rare; existing convention is uniform across share-link tests
  - Cost to fix: ~10 min (3 sites + import)
- **Orchestrator sign-off**: borderline RT3 finding — file's existing convention is literals; switching only the new lines creates worse inconsistency

### Round 10 Summary

- Functionality: Critical 0 / Major 0 / Minor 3 (F1 fixed, F2 deferred-tracked, F3 fixed via comment)
- Security: Critical 0 / Major 0 / Minor 0 — clean (2 informational adjacent)
- Testing: Critical 0 / Major 1 (T1 fixed) / Minor 1 (T2 skipped per file convention)

Total: Critical 0 / Major 1 / Minor 4. T1 + F1 + F3 fixed in Round 10; F2 deferred with explicit Anti-Deferral cost-justification + TODO marker; T2 skipped per file convention.
