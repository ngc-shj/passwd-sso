# Code Review: unify-new-creation-ui

Date: 2026-05-10
Review round: 1

## Changes from Previous Round

Initial code review of branch `refactor/unify-new-creation-ui` (5 commits ahead of main, 38 files, +1818/-527).

## Functionality Findings

Reviewed: helper, 7 token-mint cards, contracts C1-C6 conformance.

**No real defects found.** All identified items are verifications (contract conformance confirmed) or minor polish.

### F1 [Minor] cli-token-card duplicates rate-limit phrasing
**File:** `src/components/settings/developer/cli-token-card.tsx:30-36`
The card short-circuits `res.status === 429` to `t("rateLimited")` (CliToken namespace) BEFORE consulting `tokenMintApiErrorKey`. The helper would otherwise route RATE_LIMIT_EXCEEDED through `tApi("rateLimitExceeded")` (ApiErrors namespace, different message). Two distinct user-facing strings cover the same wire condition.
**Disposition**: leave as-is unless user wants unification — CLI may want CLI-specific phrasing. If unifying, drop the local 429 branch.

### F2 [Minor] operator-token alias currently a no-op
**File:** `src/lib/http/token-mint-error.ts:28-30`
Both `operatorTokenStaleSession` and `sessionStepUpRequired` i18n keys currently resolve to the same message. The alias is defensive (would matter if messages diverge) but is a no-op today.
**Disposition**: leave as-is, defense-in-depth.

### F3 [Minor] access-request handleApprove 400 fallthrough is narrow
**File:** `src/components/settings/developer/access-request-card.tsx:196-201`
Only handles `INVALID_SCOPE` for status 400. Other 400 codes (e.g. `VALIDATION_ERROR`) fall to the helper which returns null → `arApproveFailed` toast. Pre-existing behavior, not introduced by this PR.

### F4 [Minor] operator-token DialogDescription reuses card description
**File:** `src/components/settings/developer/operator-token-card.tsx:334`
Reuses the section header copy as the dialog description. UX polish only.

## Security Findings

**No findings.**

The C6 narrowing is a strict security improvement: the previous `apiErrorToI18nKey(...) !== "unknownError"` pattern surfaced ~100 codes (including `UNAUTHORIZED`, `FORBIDDEN_INSUFFICIENT_ROLE`, `EXTENSION_TOKEN_SCOPE_INSUFFICIENT`) to all token-mint UI surfaces. The new allow-list (`SESSION_STEP_UP_REQUIRED`, `RATE_LIMIT_EXCEEDED` + alias) follows least-disclosure.

Verified:
- Auth/scope code suppression is safe — surfaces sit behind session middleware; suppressed codes do not mask attacks.
- `OPERATOR_TOKEN_STALE_SESSION → sessionStepUpRequired` alias is operationally correct (route renames same `requireRecentSession` failure).
- Passkey auto-name (C4) has no XSS surface — `generateDefaultNickname` emits hard-coded literals only; user-supplied transports inspected via `.includes()`, not interpolated.
- Server-side validation enforced for nickname (verify + PATCH routes use Zod with WEBAUTHN_NICKNAME_MAX_LENGTH cap).
- `tokenMintApiErrorKey` input narrowing is correct (`typeof error !== "string"` guard before lookup).
- No `dangerouslySetInnerHTML` introduced; nickname/scope rendering uses text children (auto-escaped).

## Testing Findings

### T1 [Major] 6 of 7 components lack the C6-required (b) unrecognized-code fallback test
**Files:** `api-key-manager.test.tsx`, `team-scim-token-manager.test.tsx`, `mcp-client-card.test.tsx`, `operator-token-card.test.tsx`, `service-account-card.test.tsx`, `access-request-card.test.tsx`
The plan's Testing Strategy mandates per-component tests for both:
  (a) recognized code → ApiErrors translation, AND
  (b) unrecognized code → component-local fallback
All 7 files have (a) (mostly via SESSION_STEP_UP_REQUIRED). Only `cli-token-card.test.tsx` has (b). Without (b), a future helper change that incorrectly broadened the allow-list (or returned a wrong i18n key) would not be caught — the (a)-only test passes silently.
**Recommended fix:** For each of the 6 components, add a test that returns `{ error: "BOGUS_CODE" }` and asserts the local-namespace fallback toast (e.g. `expect(mockToast.error).toHaveBeenCalledWith("createError")`).

### T2 [Minor] Helper test edge cases
**File:** `src/lib/http/token-mint-error.test.ts`
Edge cases not pinned down: empty string `""`, leading/trailing whitespace, shared-prefix codes like `"RATE_LIMIT_EXCEEDED_X"`. Future refactor switching from `Set.has` to `startsWith` would silently regress.
**Recommended fix:** Add 2-3 edge-case assertions.

### T3 [Minor] webhook-card-test-factory Dialog mock semantic divergence
**File:** `src/components/__tests__/webhook-card-test-factory.tsx:217-228`
Factory's Dialog mock unconditionally renders children; individual test files (`base-webhook-card.test.tsx`, `audit-delivery-target-card.test.tsx`) use `open ?` gating. Two parallel mock styles for the same UI primitive — RT2 (mocked-vs-integration) drift.
**Recommended fix:** Document the divergence in a comment, OR align the factory to `open ?` gating (would require clicking trigger first in factory tests).

### T4 [Minor] `[length-1]` ordering fragility
**File:** `src/components/__tests__/webhook-card-test-factory.tsx` (11 sites)
The `createButtons[createButtons.length - 1]` pattern relies on JSX render order. A refactor that swaps trigger/Dialog order would silently break (or vacuously pass) the disabled-state assertion.
**Recommended fix:** Use `getByRole("button", { name: /addWebhook/, disabled: true })` Testing Library filter, OR scope query to `within(screen.getByTestId("dialog-content"))`.

### T5 [Minor] passkey test no-PRF body shape not pinned
**File:** `src/components/settings/security/passkey-credentials-card.test.tsx:207-238`
The new "registers with auto-generated nickname" test uses `prfOutput: null` (unhappy path) but doesn't assert the verify body lacks `wrappedSecretKey`/`prfEncryptedSecretKey` fields.

## Adjacent Findings

None.

## Quality Warnings

None — all findings cite specific files and line numbers.

## Recurring Issue Check

### Functionality expert
- R3 (codebase awareness): checked — `tokenMintApiErrorKey` adopted by all 7 cards; no reinvention.
- R6 (consumer flow walkthrough): checked — mcp-client update path verified reachable; operator-token open→submit→display flow consistent.
- R23 (numeric input clamp): N/A.
- R26 (disabled state visual cue): checked — Loader2 + disabled prop present on all create buttons.

### Security expert
- RS1 (auth oracle): checked — C6 narrowing reduces auth-state oracle (UNAUTHORIZED/FORBIDDEN no longer leaked as distinct UI strings).
- RS2 (info disclosure): checked — narrowing is a strict reduction (~100 codes → 3).
- RS3 (input validation at boundary): checked — server-side Zod schemas for nickname (verify + PATCH); helper input type-guarded.
- RS4 (XSS/injection): checked — `generateDefaultNickname` uses fixed literals; nickname rendered as text node.

### Testing expert
- RT1 (test isolation): checked — `vi.clearAllMocks()` in `beforeEach` consistently.
- RT2 (mocked-vs-integration consistency): found at webhook-card-test-factory:217-228 — Dialog mock divergence (T3).
- RT3 (CI lint enforcement): N/A — no test files touched lint config.
- RT4 (test naming): checked — descriptive behavior-stating names.
- RT5 (assertion vacuousness): T4 flags potential fragility from `[length-1]` ordering.

## Resolution Status

### T1 [Major] 6 components lack the (b) unrecognized-code fallback test — Resolved
- Action: Added one fallback test per component asserting `mockToast.error` is called with the local-namespace fallback when the response carries `error: "BOGUS_NOT_IN_ALLOWLIST"` (a code outside the helper's allow-list).
- Modified files:
  - `src/components/settings/developer/api-key-manager.test.tsx`
  - `src/components/team/security/team-scim-token-manager.test.tsx`
  - `src/components/settings/developer/mcp-client-card.test.tsx`
  - `src/components/settings/developer/operator-token-card.test.tsx`
  - `src/components/settings/developer/service-account-card.test.tsx`
  - `src/components/settings/developer/access-request-card.test.tsx`

### T2 [Minor] Helper test edge cases — Resolved
- Action: Added a single test case pinning `Set.has` equality semantics for empty string, leading/trailing whitespace, lowercase variant, and shared-prefix code (`RATE_LIMIT_EXCEEDED_FOO`).
- Modified file: `src/lib/http/token-mint-error.test.ts`

### T3 [Minor] Factory Dialog mock semantic divergence — Resolved
- Action: Added a comment block above the Dialog mock noting that it unconditionally renders children (mirroring AlertDialog) while individual test files use `open ?` gating.
- Modified file: `src/components/__tests__/webhook-card-test-factory.tsx`

### T4 [Minor] `[length-1]` ordering fragility — Resolved
- Action: Introduced `getDialogSubmitButton(text)` helper that uses `within(screen.getByTestId("dialog-content"))` to scope the query inside the dialog, eliminating dependence on JSX render order. Replaced 11 sites of `createButtons[createButtons.length - 1]` with `submitBtn`.
- Modified file: `src/components/__tests__/webhook-card-test-factory.tsx`

### T5 [Minor] passkey no-PRF body shape not pinned — Resolved
- Action: Added assertions that the verify request body does NOT contain `prfEncryptedSecretKey`, `prfSecretKeyIv`, `prfSecretKeyAuthTag` when the registration runs without PRF.
- Modified file: `src/components/settings/security/passkey-credentials-card.test.tsx`

### F1 [Minor] cli-token-card duplicate rate-limit phrasing — Resolved
- Action: Removed the local 429 short-circuit branch; RATE_LIMIT_EXCEEDED now flows through the helper to `tApi("rateLimitExceeded")` consistently with the other 6 token-mint cards. Removed the now-unused `rateLimited` key from `messages/{en,ja}/CliToken.json`. Updated existing test to reflect the new namespace.
- Modified files:
  - `src/components/settings/developer/cli-token-card.tsx`
  - `src/components/settings/developer/cli-token-card.test.tsx`
  - `messages/en/CliToken.json`
  - `messages/ja/CliToken.json`

### F3 [Minor] access-request handleApprove 400 fallthrough is narrow — Resolved
- Action: Added an explicit `else if (res.status === 400)` branch that surfaces `arApproveFailed`. Codes outside `INVALID_SCOPE` no longer fall through to `tokenMintApiErrorKey` (which would return null for a 400-only domain code anyway, but the explicit branch is clearer and avoids the helper round-trip).
- Modified file: `src/components/settings/developer/access-request-card.tsx`

### F4 [Minor] operator-token DialogDescription reuses card description — Resolved
- Action: Added new i18n key `createTokenDescription` (en + ja) describing the dialog action specifically. Replaced `t("description")` with `t("createTokenDescription")` in the dialog header.
- Modified files:
  - `src/components/settings/developer/operator-token-card.tsx`
  - `messages/en/OperatorToken.json`
  - `messages/ja/OperatorToken.json`

### F2 [Minor] operator-token alias currently a no-op — Accepted (no action)
- Reason: defense-in-depth pattern. Both `operatorTokenStaleSession` and `sessionStepUpRequired` i18n keys currently resolve to the same message; the alias matters only if the messages diverge in the future. No code change needed.

### Verification
- `npx vitest run` — 10154 passed / 1 skipped / 0 failed
- `npx next build` — succeeded

## Round 2 — not run (finalized at user's request)

Round 1 fixes (commit `7063273f`) applied all Round 1 findings and were verified by full vitest + production build. The Round 1 commit's scope:
- Test additions only for T1 (no production behavior change).
- Helper test edge cases for T2 (test-only).
- Test factory refactor for T3, T4 (test-only).
- One assertion added for T5 (test-only).
- F1: dropped a duplicate code path on cli-token-card (404 / 429 / other behavior unified through the helper); paired test updated.
- F3: added explicit `else if (status === 400)` branch in access-request handleApprove; unrelated 400 codes now surface `arApproveFailed` instead of round-tripping through the helper.
- F4: i18n key swap on operator-token DialogDescription (text-only).

None of these changes touch a security boundary as defined by the skill (auth / authz / cryptography / session / federation / key custody / signing / rate-limit gate / audit logging / input validation). The branch already passed Round 1 review by all three experts. The user authorized finalization without Round 2.


