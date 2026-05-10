# Plan Review: unify-new-creation-ui

Date: 2026-05-09
Review round: 2 (incremental — C6 only)

## Changes from Previous Round

Added new contract C6 (Generic API error toast contract) covering broader mutation/create error-toast routing
through `apiErrorToI18nKey` SSoT. C1-C5 unchanged. C6 went from `pending` → `locked` after this round resolved
the Major findings below.

## Functionality Findings

### F1 [Minor] Forbidden-pattern regex requires multi-line grep flag
Multi-line `[\s\S]{0,80}` patterns only match with `grep -znP` / `rg -U`, not plain line-based grep.
Resolution: noted invocation requirement inline in the Forbidden patterns section.

### F2 [Minor] Forbidden-pattern key list omitted accountLocked / serviceUnavailable
The acceptance criteria cite ACCOUNT_LOCKED for passkey, but the regex didn't enumerate `accountLocked`.
Resolution: extended the enumeration to include `accountLocked|serviceUnavailable|forbiddenInsufficientRole`.

### F3 [Minor] Walkthrough did not distinguish C5-already-migrated vs C6-new components
Four of seven listed components were already migrated by C5 (commit e022057d); the walkthrough read as if all seven were pending.
Resolution: each walkthrough bullet now ends with `Status: already migrated by C5; C6 ratifies.` or `Status: NEW migration in C6.`

### F4 [Major] mcp-client-card walkthrough only covered create, missed update path
The actual file has both `toastCreateApiError` AND `toastUpdateApiError`, both with hardcoded `tApi("sessionStepUpRequired")`.
The contract scope (mutation/create) covers PUT/PATCH update too; missing the update path would leave a half-migration.
Resolution: walkthrough now explicitly names BOTH paths.

### F5 [Minor] toastApiError helper shape gap
The existing `toastApiError(res, tApi, fallbackErrorCode?)` cannot express "fallback to a domain i18n key" — only
"fallback to an ApiError code routed through ApiErrors namespace". The seven listed components all want a domain
fallback (`createError`, `networkError`, etc.).
Resolution: added a "Helper compatibility note" clarifying that adoption is not required and explaining why.

### F6 [Minor] Out-of-scope clause should carve out SESSION_STEP_UP_REQUIRED for delete/revoke
The mcp-client delete handler is `requireRecentSession`-guarded but the broad delete/revoke exemption would have
left it incoherent with C5's create-side unification.
Resolution: added a carve-out — `SESSION_STEP_UP_REQUIRED` MUST be surfaced specifically on delete/revoke routes
that use `requireRecentSession`; other codes may remain in the generic fallback.

### F7 [Minor] passkey walkthrough cited ACCOUNT_LOCKED speculatively
The walkthrough listed `RATE_LIMIT_EXCEEDED, ACCOUNT_LOCKED, UNAUTHORIZED` without grounding in the actual
`/api/webauthn/register/{options,verify}` route returns.
Resolution: rephrased to "recognized codes returned by the WebAuthn register routes (verify each route's actual
error-code returns before locking the test cases)".

## Security Findings

### S1 [Minor] Auth-state oracle from differentiated UNAUTHORIZED / SESSION_STEP_UP_REQUIRED / FORBIDDEN_INSUFFICIENT_ROLE
**Not exploitable** in the documented threat model — these toasts only fire for authenticated same-tenant settings
users, who can already learn their own role/scope from `/api/tenant/role` and the gated-UI surface.
Resolution: added an informative threat-model assumption section to C6 documenting this.

### S2 [Minor] SCIM token-state codes do not apply to C6's surface
SCIM_TOKEN_INVALID/EXPIRED/REVOKED are returned by `/api/scim/v2/*`, not the token-mint UI.
Resolution: noted dormancy in the threat-model assumption.

### S3 [Minor] MCP_CLIENT_NAME_CONFLICT enumeration concern is server-side parity
A flag for a downstream check (does `POST /api/tenant/mcp-clients` share its authorization predicate with `GET`?),
not a C6 blocker.
Resolution: noted; not actionable in this contract.

### S4 [Major] body.details (Zod field paths) raw exposure not addressed
C6 originally said nothing about whether components may render `body.details` payload text. base-webhook /
mcp-client today read `details.properties` to drive WHICH inline field to flag, but a future refactor could
echo `details.properties.url.errors[0]` (raw Zod text), leaking schema strings.
Resolution: added an invariant forbidding direct rendering of `body.details` text and a forbidden-pattern regex
matching `t(details.properties...)` style usage.

### S5 [Minor] Forbidden regex bypassable via template literals
`tApi(\`sessionStepUpRequired\`)` would slip past the original regex.
Resolution: extended the regex to match both `"..."` and template-literal forms.

### S6 [Major] unknownError ambiguity with malformed responses
Original C6 collapsed `JSON parse failure` and `unrecognized code` into the same domain-generic toast — no
telemetry distinction between "server crash dumping HTML" and "unknown but well-formed code".
Resolution: added an invariant that `res.json()` rejection emits a `console.warn("[<component>] non-JSON error
response", { status })` (no body content) — distinguishes upstream/proxy issues from missing-code-on-good-body.

### S7 [Minor] Sentry breadcrumb implication
No Sentry/breadcrumb call sites today in any in-scope component. C6 expands the variety of strings flowing
through `toast.error()`; a future breadcrumb add could capture user-facing copy that contains state descriptors
("scimTokenExpired", etc.) without actually leaking secrets.
Resolution: added an invariant that future Sentry breadcrumbs for toast errors must route through sentry-scrub
with explicit field naming.

## Testing Findings

### T1 [Major] SSoT invariant not testable per-component runtime
A component could call `tApi("rateLimitExceeded")` directly and the per-component toast assertion would still
pass — runtime tests cannot detect SSoT bypass.
Resolution: contract now explicitly states the static forbidden-pattern grep is load-bearing for the SSoT
invariant; runtime tests assert behavior but do not detect bypass.

### T2 [Major] Recognized-code coverage absent for several components
Existing tests cover `SESSION_STEP_UP_REQUIRED` (C5) but `RATE_LIMIT_EXCEEDED`, `FORBIDDEN_INSUFFICIENT_ROLE`,
`CONFLICT`, `ACCOUNT_LOCKED` are NOT asserted anywhere. base-webhook-card.test.tsx and audit-delivery-target-
card.test.tsx have NO failed-create toast assertions at all.
Resolution: Testing Strategy now mandates a per-component test matrix (recognized recoverable / recognized
auth-role / unrecognized / preserved domain-specific) for all seven components, with explicit note that the
two cards above need new tests built from scratch.

### T3 [Minor] No CI enforcement of forbidden-pattern grep
`scripts/pre-pr.sh` has other static-grep gates but none for C6 patterns.
Resolution: noted but not made a C6 blocker — same gap exists for C1-C5; flag as a follow-up.

### T4 [Major] No runtime test asserts every API_ERROR code resolves to a real i18n string in JSON files
TypeScript `satisfies` proves map completeness but cannot reach into JSON. A missing JSON key would surface
the literal key string ("rateLimitExceeded") to the user.
Resolution: Testing Strategy now requires a new runtime test (mirroring `admin-i18n-key-coverage.test.ts` and
`audit-i18n-coverage.test.ts`) that asserts every `Object.values(API_ERROR)` resolves to a key present in both
`messages/en/ApiErrors.json` and `messages/ja/ApiErrors.json`.

### T5 [Minor] C6 lacked a "Test pattern" subsection
Mock granularity varies across existing test files (some mock fetchApi, some mock global.fetch).
Resolution: added an explicit Test pattern subsection to Testing Strategy with the canonical mocking shape.

### T6 [Minor] passkey test:319 needs one assertion update
Test at line 319 currently asserts `registerError` for `error: "BAD_REQUEST"`; under C6, `BAD_REQUEST` is not
in `API_ERROR` so falls back to local `registerError` — likely no functional change, but document the expected
outcome so reviewers don't flag it as drift.
Resolution: documented in Testing Strategy.

## Adjacent Findings

None this round.

## Quality Warnings

None this round — all findings provided concrete file/line references.

## Recurring Issue Check

### Functionality expert
- R3 (codebase awareness — utilities used vs reinvented): **HIT** — Finding F5 surfaces the toastApiError helper shape gap that the original C6 glossed over. Resolved by explicit helper-compatibility note.
- R6 (consumer-flow walkthrough completeness): **HIT** — Findings F3, F4, F7 all flag walkthrough shape-incompleteness. Resolved.
- R29 (external citation accuracy): N/A.

### Security expert
- R12 (audit/logging label coverage): N/A (UI toast text, not audit payload).
- RS1 (auth oracle): Findings S1, S3 — both judged non-exploitable with documented assumption.
- RS2 (info disclosure via error messages): Findings S4, S6, S7 — invariants added.

### Testing expert
- RT1 (test isolation): OK across all listed test files.
- RT2 (mocked vs integration coverage gap): **HIT** — Finding T4 is the canonical write-read consistency gap; resolved with new runtime test requirement.
- RT3 (forbidden-pattern CI enforcement): **HIT** — Finding T3, deferred as a follow-up consistent with repo posture.
- RT4 (test naming): OK.

## Round 2 Closing — Essence Trim

After incorporating all 5 Major and most Minor findings, the user pushed back: "本質。" The orchestrator had reflexively merged speculative defensive scaffolding (Sentry breadcrumb invariant, body.details exposure regex, console.warn for non-JSON, threat-model assumption section, helper compatibility note, multi-category test pattern subsection) that did not match concrete problems in the actual diff. C6 was trimmed back to its essence:

- Route through `apiErrorToI18nKey` (or domain-specific early return BEFORE the SSoT call)
- Don't hardcode ApiErrors keys for known codes
- Don't drop `body.error`

**Findings retained in C6 (essence):** F4 (mcp-client update path), F3 (status annotation per component, condensed), F6 (mcp-client delete carve-out), T2 (minimum: 1 recognized + 1 unrecognized test per component), and the two main forbidden patterns.

**Findings dropped from C6 (over-engineering):** S4 (body.details regex — speculative), S6 (console.warn — speculative), S7 (Sentry — no call sites today), S1/S2/S3 (threat-model section — defensive footnote), F5 (helper compatibility note — internal apology), S5 (template-literal regex variant — edge case), T5 (test pattern subsection — implementation detail), T4 (i18n coverage runtime test — useful but separate from C6).

**Findings dropped from Testing Strategy:** the multi-category test matrix collapsed to "1 recognized + 1 unrecognized per component"; the runtime i18n coverage test removed (track separately if desired).
