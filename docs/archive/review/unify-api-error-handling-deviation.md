# Coding Deviation Log: unify-api-error-handling

## Phase 2 deviations (Sub-agent A — foundational schema)

### D1 — Pre-existing org→team key drift in ApiErrors.json

The new i18n-coverage test (C5 Testing strategy) surfaced two stale keys in
`messages/{en,ja}/ApiErrors.json` that referenced the pre-rename "org" naming
even though the corresponding `API_ERROR_I18N` map entries had already been
renamed to "team":

- `orgNotFound` → renamed to `teamNotFound` (matches `TEAM_NOT_FOUND`)
- `orgKeyVersionMismatch` → renamed to `teamKeyVersionMismatch` (matches
  `TEAM_KEY_VERSION_MISMATCH`)

**Why side-fixed**: the i18n-coverage test that C5 introduces would have failed
on these pre-existing drifts. Renaming to the canonical name is the simplest
fix; the wire string value of the corresponding API_ERROR code was already
`TEAM_*`, so this is a docs/JSON drift, not a behavior change.

**How to apply going forward**: the new coverage test prevents recurrence.

### D2 — `grantRevoked` missing from ApiErrors.json

`API_ERROR_I18N` mapped `GRANT_REVOKED` → `"grantRevoked"` but the key was
present only in `EmergencyAccess.json`, missing from `ApiErrors.json`. Added
to both en/ja `ApiErrors.json`.

**Why side-fixed**: same as D1 — the coverage test surfaced it.

### D3 — `INVALID_CHALLENGE` placed in a new `// ── WebAuthn / Passkey ──` section

`API_ERROR` did not have a pre-existing webauthn/passkey grouping. Sub-agent A
introduced one as a new section break for `INVALID_CHALLENGE`. Style consistent
with the other section comments.

### D4 — i18n-coverage test uses public `apiErrorToI18nKey()` instead of direct map import

The plan suggested asserting against the internal `API_ERROR_I18N` map
directly, but that map is not exported. The new test
`src/__tests__/api-errors-i18n-coverage.test.ts` enumerates all `API_ERROR`
values and calls the public `apiErrorToI18nKey(code)` to derive the i18n key
for each, then asserts the result is present in both en/ja JSON. Equivalent
semantics — every code reachable through the public function has en/ja
translations.

## Phase 2 deviations (Sub-agent C — C11 rename propagation)

### D5 — IV/AuthTag merge: two branches preserved, both emit `INVALID_ENCRYPTION_FORMAT`

The plan permitted either collapsing to a single branch or keeping two branches
that each emit the merged code. Sub-agent C kept the two branches in
`src/app/api/{passwords,teams/[teamId]/passwords}/[id]/attachments/route.ts`
because the underlying validation logic for IV format vs auth-tag format is
distinct; collapsing would have required restructuring the surrounding
parse/validate flow. Both branches now emit `INVALID_ENCRYPTION_FORMAT`.
Test assertions updated to match.

### D6 — Error class `super()` message strings updated in `rotate-key-server.ts`

Three custom Error class constructors in `src/lib/vault/rotate-key-server.ts`
passed the old code names to `super()`. These were updated to the new names for
internal consistency, even though the production `instanceof` checks do not
depend on the message string. Low-risk side-fix.

## Phase 2 orchestrator action (post sub-agents)

### D7 — Implemented `scripts/checks/check-api-error-codes.sh` grep gate

The plan's C10 §9 committed to a grep gate wired into `pre-pr.sh` as the CI
enforcement layer (Non-functional req #2 in the plan). Sub-agent D's docs
referenced this script but neither sub-agent built it (out of their scopes).
The orchestrator implemented the 4-pattern grep gate:

1. C5 — `{ error: "ACCESS_DENIED" }` string literal in production code
2. C2 — English-prose `error` value in non-OAuth/SCIM routes
3. C2 — lowercase-leading `error` value in main API envelope (catches OAuth-style leakage)
4. C11 — retired internal-jargon code names anywhere in `src/`

Wired into `scripts/pre-pr.sh` as `Static: api-error-codes`. The gate runs
green against the post-Phase-2 codebase.

## Phase 2 verification

All 17 `pre-pr.sh` checks passed:
- e2e-selectors, security-doc-exists, test-hygiene, settings-card-layout
- **api-error-codes (new)**
- Lint, env drift check, team-auth-rls, bypass-rls, crypto-domains, migration-drift
- no-deprecated-logAudit, fetch basePath compliance
- Secret scan (gitleaks)
- Test (10237 passed / 1 skipped)
- Build (production next build succeeded)

No new findings outside the deviations above.
