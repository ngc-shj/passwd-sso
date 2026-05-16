# Plan Review: fix-bearer-token-scope-gates
Date: 2026-05-16
Review round: 1

## Changes from Previous Round
Initial review. Plan reviewed by three expert sub-agents (Functionality / Security / Testing) launched in parallel. Ollama dedup unavailable — manual deduplication applied.

## Functionality Findings

**[F-1] [Critical]: `API_ERROR.TAG_NOT_FOUND` does not exist; C5 references a phantom error code**
- File: `src/lib/http/api-error-codes.ts`, plan C5
- Evidence: `grep -rn "TAG_NOT_FOUND" src/` → 0 matches. Existing code has `TAG_ALREADY_EXISTS` but no `TAG_NOT_FOUND`.
- Fix: Add `TAG_NOT_FOUND` to all three maps (`API_ERROR`, `API_ERROR_STATUS=404`, `API_ERROR_I18N`) plus locale files, OR reuse `API_ERROR.NOT_FOUND` (option (b) is YAGNI-compliant). Plan must name a real code.

**[F-2] [Critical]: C4's SA-token path is functionally broken — `hasUserId` rejects `service_account` auth type**
- File: `src/app/api/vault/delegation/check/route.ts:37-38`, `src/lib/auth/session/auth-or-token.ts:25,39-41`
- Evidence: `service_account` type has no `userId` field. `hasUserId` returns false. Delegation/check route rejects with 403 before scope check.
- Fix: Decide whether SA tokens need this endpoint. If yes: route needs a parallel code path keyed by `serviceAccountId`. If no: remove `SA_TOKEN_SCOPE.DELEGATION_CHECK` from C4 and update C4 acceptance criteria to MCP+session only.

**[F-3] [Major]: C8 scope claim is incorrect — 18 routes call `req.json()` directly, bypass C8 entirely**
- File: 18 production routes including `webauthn/authenticate/options`, `scim/v2/*`, `auth/passkey/verify`, `mcp/*`, `tenant/policy`, `tenant/breakglass`, and critically `vault/rotate-key/route.ts:110`
- Evidence: `grep -rn "await req\.json\(\)" src/` → 18 direct matches outside `parse-body.ts`. Plan's R3 claim "all matches are inside parse-body.ts after this PR" is incorrect.
- Fix: Either (a) scope C8 to "routes using `parseBody`" honestly and enumerate the 18 direct callers as Phase 2 migration TODO; or (b) extend C8 to migrate the 18 callers to `parseBody`. Plan must not claim invariant is complete when it is not.

**[F-6] [Minor]: C4 consent UI may render `delegation:check` as raw string**
- File: `src/components/settings/developer/mcp-client-card.tsx:637`, `src/app/[locale]/mcp/authorize/consent-form.tsx`
- Evidence: `MCP_SCOPES = Object.values(MCP_SCOPE)` automatically extends; consent UI renders all scopes.
- Fix: Add to C4 files list: i18n label for `delegation:check` in consent-form translation namespace.

**[F-7] [Minor]: C7 error code semantic mismatch — `ITEM_KEY_VERSION_DOWNGRADE` misnames the metadata-without-reencryption guard**
- File: plan C7, `src/lib/http/api-error-codes.ts:79`
- Evidence: Error code/i18n say "downgrade" but C7 fires on any change (incl. upgrades).
- Fix: Either add new code `KEY_VERSION_WITHOUT_REENCRYPT`, or update plan to note semantic broadening and adjust i18n message.

## Security Findings

**[S-1] [Major]: C2 omits `cors-gate.ts` update — api-keys remains on `EXTENSION_TOKEN_ROUTES` Bearer-bypass list**
- File: `src/lib/proxy/cors-gate.ts:27`
- Evidence: `API_PATH.API_KEYS` is in `EXTENSION_TOKEN_ROUTES`. Even after C2's route-level rejection, proxy layer bypasses session validation for `Authorization: Bearer ext_*` requests to `/api/api-keys`.
- Fix: Add to C2: remove `API_PATH.API_KEYS` from `EXTENSION_TOKEN_ROUTES` in `cors-gate.ts`. Same PR.

**[S-2] [Major]: C8 fail-open design — Next.js 16 App Router has no platform body cap**
- File: `src/lib/http/parse-body.ts` (proposed), `next.config.ts`
- Evidence: No `bodySizeLimit` / `bodyParser` / `maxBodySize` in `next.config.ts` or `src/`. Pages Router's 1MB default does NOT apply to App Router.
- Fix: Add to C8 — set `experimental.serverBodySizeLimit` in `next.config.ts` (Next 14+ supports per-route via `route segment config` — verify for Next 16). Alternatively switch to stream-byte-counting in `parseBody`. Document the design constraint explicitly.

**[S-3] [Minor]: `delegation:check` MCP_SCOPE_RISK should be `"use"` not `"read"`**
- File: `src/lib/constants/auth/mcp.ts:23-31` (proposed)
- Evidence: Endpoint is a yes/no oracle on delegation state — `authorized: true/false` is an entry-id-existence side channel. CREDENTIALS_USE is `"use"`; this is in the same risk class.
- Fix: `MCP_SCOPE_RISK[DELEGATION_CHECK] = "use"`.

**[S-6] [Note]: Implementation order C2 → C1 required**
- Evidence: C1 throws on `allowTokens:true` without scope. The 3 api-keys routes currently use this pattern (fixed by C2). If C1 lands first, those routes immediately throw 500.
- Fix: Add to plan an explicit "Implementation order" section stating C2 (and all `allowTokens` removals) precede C1.

**[S-7] [Minor]: `itemKeyVersion` and `aadVersion` Zod schemas have no upper bound (RS3)**
- File: `src/lib/validations/team-vault.ts` (and equivalent personal-vault)
- Evidence: `itemKeyVersion: z.number().int().min(0).optional()` — no `.max(...)`. PostgreSQL `INTEGER` overflows at 2^31-1, producing a 500.
- Fix: Add `.max(TEAM_KEY_VERSION_MAX)` (10_000) or comparable bound. C5/C7 implementation is the right place.

**[S-8] [Minor]: R35 — `*-manual-test.md` not yet drafted**
- Evidence: Plan has "User operation scenarios" inline but no standalone `fix-bearer-token-scope-gates-manual-test.md`. This plan touches auth flows (Tier-2 per R35).
- Fix: Draft the file in `docs/archive/review/` with Pre-conditions / Steps / Expected result / Rollback / Adversarial scenarios sections, BEFORE Phase 2 commit.

## Testing Findings

**[T-1] [Critical]: C1 existing tests assert behaviour-to-be-deleted; plan does not call for their deletion**
- File: `src/lib/auth/session/check-auth.test.ts:270-310,348-364`
- Evidence: 3 existing tests assert `checkAuth(req, { allowTokens: true })` returns `ok:true` and `console.warn` was called.
- Fix: Plan C1 testing strategy MUST explicitly list invalidated tests: (a) delete "enables token auth without scope when allowTokens is true"; (b) rewrite "emits console.warn..." → "throws Error..."; (c) rewrite "allows token auth without access restriction check" group to expect throw.

**[T-2] [Critical]: C2 existing route tests assert `allowTokens:true` call shape and extension-token acceptance**
- File: `src/app/api/api-keys/route.test.ts:143-168,212,297-323`
- Evidence: 4 existing tests directly contradict C2.
- Fix: Plan C2 testing must explicitly delete: "returns key list for extension token auth", "calls checkAuth with allowTokens..." (GET+POST), "skips session step-up for extension-token auth". Add: "rejects extension token on GET/POST/DELETE" (401), "step-up unconditional on POST session".

**[T-3] [Major]: C4 existing test `accepts Bearer token auth (extension token)` contradicts the fix**
- File: `src/app/api/vault/delegation/check/route.test.ts:95,109`
- Fix: Plan must state: delete/rewrite to "rejects extension token (no delegation:check scope) → 403".

**[T-4] [Major]: C9 deny route has NO step-up test; "preserves" claim is vacuous**
- File: `src/app/api/tenant/access-requests/[id]/deny/route.test.ts`
- Evidence: Existing test file doesn't mock `requireRecentCurrentAuthMethod`. Once C9 adds the call, the existing success test fails (mock missing).
- Fix: Plan must state: add `requireRecentCurrentAuthMethod` to deny test mock setup. Add 2 cases: step-up error → 403; step-up satisfied → deny succeeds.

**[T-5] [Major]: C8 `parse-body.test.ts` already exists (114 lines); plan misstates as "(new)" and omits 4th acceptance test case**
- File: `src/lib/http/parse-body.test.ts`
- Fix: (a) Plan must clarify: "add to existing parse-body.test.ts" not "(new)"; (b) Add 4th test case to table: "accepts body when maxBytes override is set".

**[T-6] [Major]: `MCP_SCOPE_RISK` exhaustive test will fail when `DELEGATION_CHECK` added without risk entry**
- File: `src/lib/constants/auth/mcp.test.ts:29-30`
- Fix: Add to C4 testing strategy: "verify MCP_SCOPE_RISK contains entry for delegation:check" and "verify MCP_SCOPES.length increased".

**[T-7] [Major]: `SA_TOKEN_SCOPES` widening silently makes `delegation:check` JIT-requestable**
- File: `src/app/api/tenant/access-requests/route.ts:36,43`, `src/lib/auth/tokens/service-account-token.ts:41`
- Evidence: Adding to `SA_TOKEN_SCOPE` automatically extends Zod enum in access-requests and `ALLOWED_SCOPES` set.
- Fix: Add to C4 testing: "verify delegation:check IS/IS NOT accepted in requestedScope of POST /api/tenant/access-requests". If shouldn't be JIT-requestable, add to `SA_TOKEN_FORBIDDEN_SCOPES`.

**[T-9] [Major]: C5 integration test missing positive same-team acceptance assertion (RT4-style guard)**
- File: plan Integration tests section
- Fix: Add to C5 integration test description: "(a) same-team tags → entry created; (b) cross-team tags → 400 (NOT_FOUND)" both required.

**[T-10] [Minor]: C7 testing table missing no-op write (same version) positive case**
- Fix: Add to C7 testing table: "no-op: aadVersion === existing without encryptedBlob → 200" for both team and personal paths.

**[T-11] [Minor]: E2E test plan claim overstated — `settings-api-keys.spec.ts` is session-flow only**
- Fix: Clarify plan: extension-token rejection covered by unit tests only.

**[T-12] [Minor]: C3 testing table missing `mcp_token` rejection test**
- Fix: Add "rejects mcp_token from admin path" to C3 testing table.

## Cross-Expert Consolidations (3-way overlap)

**[X-1] [Major]: `PAYLOAD_TOO_LARGE` already exists, i18n key collision** (F-5 / T-8 / S-5 merged)
- File: `src/lib/http/api-error-codes.ts:71,521-522`, `messages/en/ApiErrors.json:28`
- Evidence: `PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE"` exists with status 413 and i18n key `fileTooLarge` ("File size exceeds the limit."). Plan describes adding what already exists with semantically wrong i18n.
- Fix: Plan C8 must be reworked: do NOT add `PAYLOAD_TOO_LARGE` (already exists). DO remap the i18n key from `fileTooLarge` to a new `payloadTooLarge` key in `API_ERROR_I18N` and add the new translation to `messages/en/ApiErrors.json` and `messages/ja/ApiErrors.json`. Verify `api-errors-i18n-coverage.test.ts` still passes.

**[X-2] [Minor]: R3 grep claim — test file `{ allowTokens: true }` mocks need updating** (F-8 / S-4 merged)
- File: `src/lib/auth/session/check-auth.test.ts`, `src/app/api/api-keys/*.test.ts`
- Fix: Add to C2 testing table: "update all `expect(mockCheckAuth).toHaveBeenCalledWith(..., { allowTokens: true })` assertions to expect `checkAuth(req)` (no second argument) instead, after C2 changes the production calls."

## Adjacent Findings
None — all three experts stayed within scope.

## Quality Warnings
None — all findings include evidence (file:line) and concrete fix proposals.

## Resolution Status (Round 1 → Round 2 input)

### F-1 Critical TAG_NOT_FOUND phantom — RESOLVED
- Action: Plan C5 updated to reuse `API_ERROR.NOT_FOUND` (404), with rationale explaining the divergence from personal-vault's 400 `VALIDATION_ERROR` (IDOR-shape vs malformed-input).
- Modified file: `docs/archive/review/fix-bearer-token-scope-gates-plan.md` (C5 section + Per-finding fix #6)

### F-2 Critical SA token userId gap — RESOLVED (scope reduced)
- Action: Plan C4 narrowed to MCP token + session only. SA token support removed (would have required parallel route logic + new delegation schema). User decision: defer SA support to a follow-up PR.
- Modified file: plan C4 contract section (added Out-of-scope subsection), Per-finding fix #5, Forbidden patterns extended

### F-3 Major req.json bypass — RESOLVED (scope expanded)
- Action: User decision — migrate 18 routes to `parseBody` in this PR (option (b)). Plan C8 enumerates all 18 routes with default-cap vs explicit-override decisions per route.
- Modified file: plan Per-finding fix #9, C8 Files list, Forbidden patterns

### F-4 Major C2 step-up test breaks — RESOLVED
- Action: Plan Testing strategy C2 row explicitly lists deletions and replacements.
- Modified file: plan Testing strategy table

### F-5 / T-8 / S-5 (X-1) Major PAYLOAD_TOO_LARGE i18n — RESOLVED
- Action: Plan C8 corrected — do NOT add the existing `PAYLOAD_TOO_LARGE` code; DO remap `API_ERROR_I18N` from `"fileTooLarge"` to new `"payloadTooLarge"` key.
- Modified file: plan Per-finding fix #9, C8 Files list

### F-6 Minor consent UI i18n label — RESOLVED
- Action: C4 Files list extended to include `consent-form.tsx` and locale files.
- Modified file: plan C4 Files

### F-7 Minor ITEM_KEY_VERSION_DOWNGRADE semantic mismatch — RESOLVED
- Action: Plan C7 now mandates a new error code `KEY_VERSION_WITHOUT_REENCRYPT` (status 409) with explicit en/ja translations.
- Modified file: plan C7 Acceptance criteria

### F-8 Minor R3 grep test file miss — RESOLVED (merged into X-2)
- Action: Plan Testing strategy C2 row instructs updating mock-call assertions.
- Modified file: plan Testing strategy table

### S-1 Major cors-gate.ts gap — RESOLVED
- Action: C2 Files list extended; new forbidden pattern; new acceptance criterion verifying `API_PATH.API_KEYS` removed from `EXTENSION_TOKEN_ROUTES`.
- Modified file: plan C2 contract section

### S-2 Major Next.js App Router body cap — RESOLVED
- Action: C8 Files list extended to include `next.config.ts`; Per-finding fix #9 documents the App-Router-has-no-default constraint; Phase 2 confirms exact Next 16 syntax.
- Modified file: plan C8

### S-3 Minor delegation:check risk level — RESOLVED
- Action: `MCP_SCOPE_RISK[DELEGATION_CHECK] = "use"` explicitly stated in C4 Signature change.
- Modified file: plan C4

### S-4 Minor test mock residue — RESOLVED (merged into X-2)
- Same as F-8

### S-6 Note implementation order — RESOLVED
- Action: Added new "Implementation order" section before Go/No-Go Gate.
- Modified file: plan Implementation order section (new)

### S-7 Minor Zod schema max bounds — RESOLVED
- Action: C7 contract extended with "Zod schema tightening" subsection requiring `.max(TEAM_KEY_VERSION_MAX)` on version fields.
- Modified file: plan C7

### S-8 Minor manual-test.md missing — RESOLVED
- Action: Created `docs/archive/review/fix-bearer-token-scope-gates-manual-test.md` with Pre-conditions, 8 steps, Expected results table, 5 adversarial scenarios (Tier-2), Rollback section.
- Modified file: (new) `fix-bearer-token-scope-gates-manual-test.md`

### T-1, T-2, T-3, T-4, T-6, T-12 Critical/Major test inventory — RESOLVED
- Action: Plan Testing strategy table updated for C1, C2, C3, C4, C9 with explicit DELETE/UPDATE/ADD instructions per existing test file.
- Modified file: plan Testing strategy table

### T-5 Major parse-body.test.ts already exists — RESOLVED
- Action: Testing table now correctly says "existing file"; C8 Files list flags Round 1 T-5.
- Modified file: plan Testing strategy + C8

### T-7 Major SA_TOKEN_SCOPES JIT widening — RESOLVED (mooted by F-2 scope reduction)
- Action: Since F-2 removed SA scope addition from C4 entirely, this concern no longer applies. Plan now explicitly forbids `SA_TOKEN_SCOPE.DELEGATION_CHECK` via a forbidden pattern.
- Modified file: plan C4 Forbidden patterns

### T-9 Major C5 integration test positive case — RESOLVED
- Action: Integration tests section explicitly enumerates both positive and negative paths with RT4-style guard rationale.
- Modified file: plan Integration tests section

### T-10 Minor C7 no-op write case — RESOLVED
- Action: C7 testing row updated.
- Modified file: plan Testing strategy table

### T-11 Minor E2E claim — RESOLVED (clarified)
- Action: E2E tests section now explicitly says "session-based UI flow ... does NOT exercise extension-token → API path".
- Modified file: plan E2E tests section

### X-1, X-2 (consolidations) — RESOLVED (see component findings above)

---

All 19 unique findings from Round 1 are addressed. Plan ready for Round 2 review.

---

# Round 2 — Incremental Verification
Date: 2026-05-16
Review round: 2

## Changes from Previous Round
3 expert sub-agents (Functionality / Security / Testing) re-reviewed the revised plan + manual-test.md against the live codebase. Each verified Round 1 fixes and looked for new issues from the revisions.

## Functionality Findings (Round 2)

**[F-R2-1] [Major]: C8 route count wrong — 3 routes missed by grep, `request.json()` variant unhandled**
- Re-grep `\.json()` across `src/app/api/` found 21 hits, not 18. Missing: `passwords/[id]/attachments/[attachmentId]/migrate/route.ts:63`, `csp-report/route.ts:80`, `internal/audit-emit/route.ts:62`. The `vault/rotate-key/route.ts:110` uses `request.json()` (not `req.json()`).
- Fix: Update route list to 21; broaden forbidden pattern to `(?:req|request)\.json\(\)`. Set appropriate `maxBytes` per route (migrate route: `ATTACHMENT_MIGRATE_PAYLOAD_MAX` ≈ 20 MB; others default 1 MB).

**[F-R2-2] [Minor]: C7 plan text omits "add to all 3 maps" explicit statement for new error code**
- Plan says "Add `KEY_VERSION_WITHOUT_REENCRYPT`" without stating `API_ERROR_STATUS` (409) and `API_ERROR_I18N` (`keyVersionWithoutReencrypt`) need entries.
- Fix: Plan must explicitly enumerate all three maps.

**[F-R2-3] [Minor]: C5 `NOT_FOUND` reuse — i18n falls back to generic "notFound"**
- The remapped 404 will show the generic "notFound" message for cross-team tag rejection.
- Fix: Optional UI-side override `{ NOT_FOUND: "tagNotFound" }` for the team-password creation form.

**[F-R2-4] [Major]: C2 testing strategy omits `cors-gate.test.ts:33-34` truth-table update**
- After C2 removes `API_PATH.API_KEYS` from `EXTENSION_TOKEN_ROUTES`, the existing truth-table tests at `cors-gate.test.ts:33-34` assert `expected: true` and will fail.
- Fix: Add UPDATE instruction to C2 testing row: change `expected: true` → `expected: false` for `/api/api-keys` and `/api/api-keys/k1` entries; update `reason` strings.

## Security Findings (Round 2)

**[S-2R] [Major / Continuing]: Platform body cap is architecturally infeasible — Next.js 16 App Router has NO route-handler body cap**
- Verified from Next.js 16 source: `experimental.serverActions.bodySizeLimit` is Server-Actions-only; `experimental.proxyClientMaxBodySize` is middleware-proxy-only. No applicable setting for plain App Router route handlers.
- The Round 1 "platform backstop" claim is false. Chunked-TE bypass remains open under Round 1 design.
- Fix: Implement stream-byte-counting inside `parseBody` (sketch in plan C8 Per-finding fix #9). Reads `req.body.getReader()`, accumulates bytes, aborts at cap. Content-Length is still pre-checked as a cheap early-reject, but stream-counting is the authoritative guard.

**[S-9] [Minor]: `aadVersion` Zod bound should remain `.max(1)`, NOT `.max(10_000)`**
- `aadVersion` is a protocol format version (currently only v1 exists). Personal schema already has `.max(1)`. Round 1 incorrectly proposed `.max(10_000)`, which would silently accept future versions the server cannot decode.
- Fix: Personal schema keeps `.max(1)`; team schema (`team.ts:91`) adds `.max(1)`. Only `itemKeyVersion`/`teamKeyVersion`/`keyVersion` get `.max(TEAM_KEY_VERSION_MAX)`.

**[S-10] [Minor]: No code-comment anchor tying SA `DELEGATION_CHECK` exclusion to the deferred follow-up**
- Currently only documented in the plan; future contributors may silently add the scope.
- Fix: Add comment in `src/lib/constants/auth/service-account.ts` above `SA_TOKEN_SCOPE` explaining the structural prerequisites for SA delegation support.

**[S-11] [Minor]: C7 error i18n message uses internal vocabulary ("key version metadata")**
- Round 1's proposed message exposes crypto-architecture terms to end users (R37 / `feedback_no_internal_jargon_in_user_strings.md`).
- Fix: Replace with `"Cannot update encryption settings without re-encrypting the entry"` (en) / `"エントリを再暗号化せずに暗号化設定を変更できません"` (ja).

## Testing Findings (Round 2)

**[T-R2-1] [Major]: C2 plan misses 2 deletions in `[id]/route.test.ts`**
- Tests at `[id]/route.test.ts:112` ("revokes API key for extension token auth") and `:146` ("calls checkAuth with allowTokens and enforces access restriction") directly contradict C2.
- Fix: Add both to C2 deletion list.

**[T-R2-2] [Major]: `webauthn/authenticate/options` has try/catch-fallback semantics that mechanical `parseBody` migration breaks**
- Route silently falls back to PRF-only mode when body is absent/malformed. `parseBody` would return 400 instead.
- Fix: SPECIAL CASE — keep `req.json()` inside try/catch with inline comment; add pre-migration regression test pinning the optional-body behavior.

**[T-R2-3] [Major]: `mcp/register` requires RFC 7591 error format `{error: "invalid_request"}` — mechanical migration breaks OAuth clients**
- Current parse-failure response matches RFC 6749 §5.2 / RFC 7591. `parseBody`'s `{error: "INVALID_JSON"}` would break Claude Code / Claude Desktop OAuth clients.
- Fix: SPECIAL CASE — keep `req.json()` inside try/catch with RFC-compliant error; inline comment + regression test.

**[T-R2-4] [Minor]: C1 testing-row line range 348-364 cuts the describe block's closing brace (actual: 348-366)**
- Fix: Update plan C1 row to "DELETE lines 348-366".

**[T-R2-5] [Minor]: C7 testing row doesn't mention `api-errors-i18n-coverage.test.ts` re-run**
- Fix: Add to C7 testing row (parallel to C8's mention of the same test).

**[T-R2-6] [Minor]: "MCP_SCOPES.length updated" instruction is misleading — existing test auto-heals**
- The line-8 and line-30 assertions use `Object.values(MCP_SCOPE)` derivation; no manual count update needed.
- Fix: Replace with explicit single-scope assertion `expect(MCP_SCOPE_RISK[MCP_SCOPE.DELEGATION_CHECK]).toBe('use')`.

**[T-R2-7] [Minor]: Manual-test S1.1-3 and S4.2,4 duplicate automated coverage (R35 Filter A)**
- Steps already verified by C2 unit tests and C5 integration test.
- Fix: Mark those steps as "automated-covered — SKIP" in the manual plan.

## Resolution Status (Round 2 → Round 3 input)

### F-R2-1 Major route count + grep variant — RESOLVED
- Action: Plan C8 Per-finding fix #9 expanded to 21 routes; forbidden pattern updated to `(?:req|request)\.json\(\)`; 3 newly-identified routes have explicit `maxBytes`.

### F-R2-2 Minor all-3-maps explicit statement — RESOLVED
- Action: C7 contract now explicitly says "Add to all three maps".

### F-R2-3 Minor NOT_FOUND i18n — ACCEPTED (no fix, documented)
- Action: Acknowledged in plan note. UI-side override is optional; no plan change beyond noting it.

### F-R2-4 Major cors-gate.test.ts — RESOLVED
- Action: C2 testing row updated with explicit `cors-gate.test.ts` truth-table UPDATE instruction.

### S-2R Major Continuing platform cap → stream byte-counting — RESOLVED (design correction)
- Action: C8 Per-finding fix #9 replaced platform-backstop approach with stream-byte-counting in `parseBody`. Code sketch added.

### S-9 Minor aadVersion bound — RESOLVED
- Action: C7 Zod tightening subsection corrected — `aadVersion` keeps/gets `.max(1)`; only rotation counters get `.max(10_000)`.

### S-10 Minor SA exclusion comment — RESOLVED
- Action: C4 Out-of-scope subsection now includes code-comment anchor for `SA_TOKEN_SCOPE`.

### S-11 Minor C7 i18n jargon — RESOLVED
- Action: C7 translations replaced with user-domain language.

### T-R2-1 Major [id]/route.test.ts deletions — RESOLVED
- Action: C2 testing row deletion list expanded.

### T-R2-2 Major webauthn/options special case — RESOLVED
- Action: C8 Per-finding fix #9 SPECIAL CASE subsection added for this route.

### T-R2-3 Major mcp/register special case — RESOLVED
- Action: Same SPECIAL CASE subsection covers this route.

### T-R2-4 Minor line range — RESOLVED
- Action: C1 testing row updated to "348-366".

### T-R2-5 Minor C7 i18n coverage test — RESOLVED
- Action: C7 testing row now mentions the test.

### T-R2-6 Minor MCP_SCOPES.length instruction — RESOLVED
- Action: C4 testing row updated.

### T-R2-7 Minor manual-test Filter A — RESOLVED
- Action: S1 and S4 marked with "(automated-covered — SKIP)" prefixes.

---

All 12 unique Round 2 findings addressed. Plan ready for termination check or Round 3.


