# Code Review: security-network-gates

Date: 2026-05-05
Branch: fix/security-network-gates
Review round: 1

## Changes from Previous Round
Initial review.

## Audit Baseline (External)

The branch fixes 4 findings from an external static-review audit:

1. **High** — Tenant network restrictions bypassable for `/api/mcp/*` and `/api/mobile/*` because proxy enforces `checkAccessRestrictionWithAudit` only for `API_SESSION_REQUIRED` paths, but these routes were `API_DEFAULT`.
2. **Medium-High** — Stale web sessions can mint long-lived MCP/mobile credentials without step-up reauth.
3. **Medium** — SSRF via hex-form IPv4-mapped IPv6 (`::ffff:7f00:1`) bypassing private-IP checks.
4. **Low-Medium** — CSRF `assertOrigin` falls back to Host header when `APP_URL`/`AUTH_URL` unset.

This review verifies the fixes are correct AND propagation-complete.

## Functionality Findings

### F1 [Major] SESSION_STEP_UP_REQUIRED renders user-facing string mentioning "operator token" for non-operator flows
- File: `src/lib/http/api-error-codes.ts:371`; `messages/en/ApiErrors.json:114`; `messages/ja/ApiErrors.json:114`
- Evidence: `SESSION_STEP_UP_REQUIRED → "operatorTokenStaleSession"` → `"Re-authenticate within the last 15 minutes to issue an operator token."` 6 routes (mcp/authorize, mcp/authorize/consent, mobile/authorize, extension/bridge-code, extension/token, scim-tokens, sa-tokens) emit this generic code via the helper default.
- Problem: Generic step-up error mapped to operator-token-specific i18n key. Misleading UX in non-operator flows.
- Impact: User confusion on stale-session step-up failures across 6 routes (R37 / `feedback_no_internal_jargon_in_user_strings`).
- Fix: Add new i18n key `sessionStepUpRequired` ("Re-authenticate within the last 15 minutes to perform this action.") in en + ja `ApiErrors.json`; map `SESSION_STEP_UP_REQUIRED → sessionStepUpRequired`. Keep `OPERATOR_TOKEN_STALE_SESSION → operatorTokenStaleSession`.

### F2 [Major] Long-lived API keys minted from session without step-up
- File: `src/app/api/api-keys/route.ts:67-143`
- Evidence: `handlePOST` uses `checkAuth()`, `randomBytes(48)` → `api_*` token, `expiresAt` from request body. No `requireRecentSession` call.
- Problem: Same threat shape as audit finding #2 — stale session can mint long-lived bearer credential.
- Impact: Bypass of step-up control's stated goal; path of least resistance shifts here.
- Fix: Insert `const stepUpError = await requireRecentSession(req); if (stepUpError) return stepUpError;` after `checkAuth` in `handlePOST`.

### F3 [Major] MCP client (long-lived clientSecret) created from session without step-up
- File: `src/app/api/tenant/mcp-clients/route.ts:101-160`
- Evidence: `handlePOST` → `auth()` → `randomBytes(32) → clientSecret` stored as `clientSecretHash`. No `requireRecentSession`.
- Problem: `clientSecret` is the long-lived OAuth confidential-client credential. Issuing from stale session is the threat closed by this PR.
- Impact: Stolen stale session can register attacker-controlled MCP client + secret + redirect_uri.
- Fix: Add `requireRecentSession` after `requireTenantPermission`.

### F4 [Minor] JIT SA token mint via approve has no step-up
- File: `src/app/api/tenant/access-requests/[id]/approve/route.ts:30-145`
- Evidence: `auth()` → `randomBytes(32)` → `sa_*` token. `ttlSec` capped by `jitTokenMaxTtlSec`.
- Problem: Admin-side approval mints credential without step-up. Lower severity due to TTL cap.
- Fix: Add `requireRecentSession` after `requireTenantPermission`, OR document exemption.

### F5 [Minor] vault/admin-reset comment is now stale
- File: `src/app/api/vault/admin-reset/route.ts:36-37`
- Evidence: Comment says "Intentionally stricter than proxy CSRF gate (which skips when unset for dev convenience)". After this branch the proxy CSRF gate also fails closed.
- Fix: Update comment — proxy gate now matches; the inline check is defense-in-depth and the 500 (vs 403) is intentional.

### F6 [Minor] STEP_UP_WINDOW_MS not env-overridable
- File: `src/lib/auth/session/step-up.ts:9`
- Note: 15 min hardcoded. Optional improvement, skip per YAGNI unless requested.

## Security Findings

### S1 [Major] Step-up i18n message hardcodes "operator token", misleads every other site
*Same root cause as F1.* See Finding F1.

### S2 [Major] R3 propagation gap — long-lived credential issuance routes still without step-up
*Same root cause as F2/F3/F4 combined.* `feedback_user_bound_token_enumeration.md` applies — when adding security-tightening to a token class, ALL siblings of that token class must be enumerated. Three siblings (api_*, MCP clientSecret, SA JIT token) are missing the gate.

### S3 [Minor] Step-up denial emits no audit signal
- File: `src/lib/auth/session/step-up.ts:43-49`
- Evidence: 401/403 paths return without `logAuditAsync`.
- Problem: Stale-session-attempt-to-mint-credential is a high-value SOC signal but currently invisible.
- Fix: Optional follow-up. Add `SESSION_STEP_UP_DENIED` audit action; emit from helper or have callers wrap.

### S4 [Minor] R35 — manual-test artifact missing for Tier-2 security change
- File: `docs/archive/review/security-network-gates-manual-test.md` (does not exist)
- Evidence: PR modifies `route-policy.ts` (proxy classifier), `csrf.ts` (auth fail-closed), adds `step-up.ts` (credential-issuance gate). All R35 Tier-2 (auth flow / authorization changes).
- Fix: Add `docs/archive/review/security-network-gates-manual-test.md` with Pre-conditions / Steps / Expected result / Rollback / Adversarial scenarios.

### S5 [Minor] APP_URL/AUTH_URL must now be set; existing deployments may 403 silently
- File: `src/lib/auth/session/csrf.ts:36-37`; `src/lib/env-schema.ts:159,186`
- Evidence: Both env vars are `.optional()`; `getAppOrigin()` returns `undefined` when both unset; `assertOrigin` returns 403.
- Problem: Production deployments that relied on Host-fallback start 403'ing all cookie-bearing mutating requests after upgrade.
- Fix: Optional. Add Zod `superRefine` to require `APP_URL || AUTH_URL` when `NODE_ENV === "production"`, OR emit startup warning, OR add explicit upgrade note in CHANGELOG.

## Testing Findings

### T1 [Major] GET /api/tenant/service-accounts/[id]/tokens has no step-up test
- File: `src/app/api/tenant/service-accounts/[id]/tokens/route.test.ts`
- Evidence: `route.ts handleGET` calls `requireRecentSession` (line 46-47); test file's GET describe block has no step-up case (only POST).
- Fix: Add a GET test mocking `requireRecentSession` to return 403; assert 403 + the route does NOT proceed to `mockServiceAccountTokenFindMany`.

### T2 [Major] Step-up tests do not assert credential-mint path was NOT taken (vacuous-pass risk)
- Files: `mcp/authorize/consent/route.test.ts:185-200`; `tenant/scim-tokens/route.test.ts:169-182`; `tenant/service-accounts/[id]/tokens/route.test.ts:237-261`; `mcp/authorize/route.test.ts:91-105`
- Evidence: 4 of 6 step-up tests assert only `res.status === 403`; do not assert mint side effect was skipped. (bridge-code + mobile/authorize tests DO assert — inconsistent.)
- Problem: If step-up gate is moved AFTER mint, mock returns 403 by coincidence; mint runs; test still passes (RT5 vacuous-pass).
- Fix: Add `expect(<MintFn>).not.toHaveBeenCalled()` in each missing test.

### T3 [Minor] No coverage for hex-form IPv4-mapped IPv6 mixed-case nor bracketed-hex
- File: `src/lib/auth/policy/ip-access.test.ts`
- Fix: Add cases for `::FFFF:7F00:1` (uppercase), `[::ffff:7f00:1]` (bracketed-hex), `::ffff:c0a8:0001` (zero-padded).

### T4 [Minor] external-http.test.ts does not cover uppercase DNS resolution
- File: `src/lib/http/external-http.test.ts`
- Fix: Add `it("hostname resolving to uppercase hex-form IPv4-mapped IPv6 loopback throws", ...)`.

### T5 [Major] api-route.test.ts step-up tests do not assert mockCheckAccessWithAudit was actually invoked
- File: `src/lib/proxy/api-route.test.ts:214-261`
- Fix: Add `expect(mockCheckAccessWithAudit).toHaveBeenCalledOnce()`.

### T6 [Major] No integration test for step-up window against real Postgres Session.createdAt
- Evidence: No integration test exercises step-up.
- Problem: Auth.js v5 `createdAt` semantics are undocumented; mock-only tests miss library upgrade drift (`project_integration_test_gap.md`).
- Fix: Add 1 integration test creating a real `Session` row with stale and fresh `createdAt`; assert helper response in both modes.

### T7 [Minor] Hardcoded `16 * 60 * 1000` in operator-tokens test instead of importing STEP_UP_WINDOW_MS
- File: `src/app/api/tenant/operator-tokens/route.test.ts:92-94`
- Fix: Import `STEP_UP_WINDOW_MS`; compute FRESH/STALE values from it.

### T8 [Minor] csrf.test.ts does not explicitly assert removal of `x-forwarded-proto` trust
- Fix: Add negative test asserting 403 even when `x-forwarded-proto` + `Host` could synthesize matching origin.

### T9 [Minor] extension/token POST signature change — req-required contract not pinned
- Negligible. No fix recommended.

### T10 [Minor] Step-up test name could disambiguate gate
- Cosmetic. Optional.

## Adjacent Findings
- [Adjacent] `tenant/members/[userId]/reset-vault` POST issues reset token from session without step-up (admin-side, same threat shape).
- [Adjacent] `extension/token/refresh` extends Bearer-authenticated session indefinitely without fresh human session.
- [Adjacent] SA token POST has no rate-limiter (pre-existing).
- [Adjacent] `mcp/authorize/consent` and `mobile/authorize` lack rate-limiting (pre-existing).
- [Adjacent] NAT64 (`64:ff9b::/96`) and 6to4 (`2002::/16`) not in `BLOCKED_CIDRS` (pre-existing, defense-in-depth).
- [Adjacent] Bearer-authenticated MCP/mobile routes (`/api/mcp`, `/api/mcp/token`, `/api/mobile/token`) not gated by `enforceAccessRestriction` in handler (pre-existing inconsistency).
- [Adjacent] api-route.test.ts other describe blocks may need APP_URL stub parity after fail-closed CSRF.
- [Adjacent] No unit-test file for `step-up.ts` itself; helper has 4 distinct modes none of which are unit-tested at helper level.

## Recurring Issue Check
### Functionality expert
- R3 (propagation): Findings F2/F3/F4
- R17 (helper adoption — inverted perspective): Findings F2/F3/F4
- R37 (jargon to user): Finding F1
- Other R-rules: Checked or N/A

### Security expert
- R3 (propagation): FAIL — see S2
- R31 (audit/observability): partial FAIL — see S3
- R34 (adjacent enumeration): see S2
- R35 (manual-test artifact): FAIL — see S4
- R37 (jargon to user): FAIL — see S1
- RS1-RS4: Checked or N/A
- Other R-rules: Checked or N/A

### Testing expert
- RT3 (shared constants in tests): T7
- RT5 (test call-path includes production primitive): T2, T5
- Other RT/R rules: Checked or N/A

## Resolution Status

Round 1 findings were addressed by the user before Round 2. Verification reflects the actual diff in the working tree (un-committed) at the time of this update.

### F1 / S1 [Major] Generic SESSION_STEP_UP_REQUIRED i18n key — Resolved
- Action: Added `sessionStepUpRequired` key to `messages/en/ApiErrors.json:115` and `messages/ja/ApiErrors.json:115`. Re-mapped `SESSION_STEP_UP_REQUIRED → sessionStepUpRequired` in `src/lib/http/api-error-codes.ts:371`. `OPERATOR_TOKEN_STALE_SESSION` continues to map to `operatorTokenStaleSession`.
- Verification: en string "Re-authenticate within the last 15 minutes to continue this sensitive action."; ja string「この重要な操作を続行するには、過去 15 分以内に再認証してください。」 — domain-neutral, covers all 6+ call sites.

### F2 [Major] api-keys step-up — Resolved (session-only gating)
- Action: `src/app/api/api-keys/route.ts:76-79` adds `if (authed.auth.type === "session") { stepUp }` guard. Extension-token (`type: "token"`) and service-account auth bypass step-up since neither has a browser session to re-authenticate.
- Test: `route.test.ts:276-322` adds two cases — session step-up returns 403 with `mockPrismaApiKey.create` not called; extension-token path skips step-up and reaches mint successfully.

### F3 [Major] mcp-clients step-up — Resolved
- Action: `src/app/api/tenant/mcp-clients/route.ts:113-114` adds `requireRecentSession` after `requireTenantPermission`.
- Test: `route.test.ts:328-349` asserts 403 + `mockMcpClientCreate` not called.

### F4 [Minor → upgraded by user to fix] approve route step-up — Resolved
- Action: `src/app/api/tenant/access-requests/[id]/approve/route.ts:46-47` adds `requireRecentSession`.
- Test: `route.test.ts:279-296` asserts 403 + `mockPrismaTransaction` not called.

### F5 [Minor] vault/admin-reset comment — Resolved
- Action: `src/app/api/vault/admin-reset/route.ts:36-37` updated comment to "Intentionally stricter than the generic CSRF helper: admin vault reset must never run without an explicit canonical origin configuration."

### F6 [Minor] STEP_UP_WINDOW_MS env override — Skipped (Anti-Deferral check)
- **Anti-Deferral check**: out of scope (different feature)
- **Justification**: TODO marker recorded as part of S5 follow-up tracking. The 15-min window is the operational default for the audit fix; making it configurable is a separate operational requirement, not a security finding.

### S2 [Major] R3 propagation — Resolved (covered by F2/F3/F4)

### S3 [Minor] Step-up audit signal — Skipped (Anti-Deferral check)
- **Anti-Deferral check**: out of scope (different feature, no tracked plan yet)
- **Justification**: SOC visibility into stale-session credential-mint attempts is a separate audit-emit hardening line. TODO marker:
  ```
  TODO(step-up-audit-signal): emit AUDIT_ACTION.SESSION_STEP_UP_DENIED from requireRecentSession
  ```
- **Orchestrator sign-off**: Cost-to-fix non-trivial (new audit action + i18n + emission ordering); not on the audit's stated risk path. Defer with TODO.

### S4 [Minor] R35 manual-test artifact — Resolved
- Action: Created `docs/archive/review/security-credential-issuance-hardening-manual-test.md` with 7 scenario sections covering proxy IP gate, step-up matrix, CSRF fail-closed, SSRF rejection, plus evidence references.

### S5 [Minor] APP_URL/AUTH_URL strict-required in production — Skipped (Anti-Deferral check)
- **Anti-Deferral check**: out of scope (operational-config hardening, separate concern)
- **Justification**:
  - Worst case: post-upgrade deployment 403's all cookie-bearing mutating requests until operator sets `APP_URL` or `AUTH_URL`
  - Likelihood: medium for self-hosted operators that never ran `npm run init:env`
  - Cost to fix: ~30 min (Zod superRefine + startup warning) but interacts with env-schema test fixtures and CI profiles — non-trivial
- **Orchestrator sign-off**: Document this behavior change in CHANGELOG/upgrade notes when the next release-please PR is cut. The fail-closed change itself is the security correct outcome; the operational ergonomic improvement is separable.

### T1 [Major] GET service-accounts step-up test — Resolved differently (revert + complementary test)
- Action: `src/app/api/tenant/service-accounts/[id]/tokens/route.ts:43-45` reverted to NOT call `requireRecentSession` on GET — token metadata listing is read-only and does not mint credentials, so step-up is over-gating.
- Test: `route.test.ts:142-157` adds positive assertion "does not require session step-up for listing tokens" verifying the GET path passes even when the helper would have returned 403, AND that `requireRecentSession` is not called.
- Note: T1's original prescription assumed the GET step-up was intentional. The user correctly identified the over-gating and inverted the fix.

### T2 [Major] Vacuous-pass guards on step-up tests — Resolved
- Action: `expect(<Mint>).not.toHaveBeenCalled()` added to:
  - `mcp/authorize/route.test.ts:105` — `mockFindFirst`
  - `mcp/authorize/consent/route.test.ts:200` — `mockCreateAuthorizationCode`
  - `tenant/scim-tokens/route.test.ts:182` — `mockPrismaScimToken.create`
  - `tenant/service-accounts/[id]/tokens/route.test.ts:287` — `mockPrismaTransaction`

### T3 [Minor] hex-form normalization tests — Resolved
- Action: `src/lib/auth/policy/ip-access.test.ts:46-50, 62-64, 137-141` adds uppercase, zero-padded, and bracketed-hex variants for both `normalizeIp` and `isIpInCidr`.

### T4 [Minor] external-http hex-form DNS tests — Resolved
- Action: `src/lib/http/external-http.test.ts:124-132, 159-173` adds uppercase + zero-padded URL-literal AND DNS-resolution cases.

### T5 [Major] mockCheckAccessWithAudit invocation assertion — Resolved
- Action: `src/lib/proxy/api-route.test.ts:228-233, 251-256, 273-278` adds `expect(mockCheckAccessWithAudit).toHaveBeenCalledWith("t-1", null, "u-1", expect.any(NextRequest))` to all three new tests.

### T6 [Major] Real-DB step-up integration test — Resolved
- Action: New `src/__tests__/db-integration/require-recent-session.integration.test.ts` (129 lines) covers 4 modes — fresh session passes, stale session 403, missing cookie 401, missing row 401. Uses real Postgres `Session` row insert via `setBypassRlsGucs`.
- Verification: `npm run test:integration -- require-recent-session.integration` reports 4 tests passed (per user).

### T7 [Minor] Hardcoded 16-min in operator-tokens test — Resolved
- Action: `src/app/api/tenant/operator-tokens/route.test.ts:3, 95-97` imports `MS_PER_MINUTE` and constructs `STALE_SESSION` from it.

### T8 [Minor] x-forwarded-proto fail-closed negative test — Resolved
- Action: `src/lib/auth/session/csrf.test.ts:60-71` adds "returns 403 when x-forwarded-proto suggests https but canonical origin is unset" with `host: localhost:3000`, `x-forwarded-proto: https`, both env vars deleted.

### T9, T10 [Minor] — Skipped (cosmetic)
- T9 (req-required contract test): Negligible — Next guarantees `req`. No change.
- T10 (test name disambiguation): Cosmetic. Body assertion already disambiguates via `expect(json.error).toBe(...)`.

### Adjacent findings — Tracked

The following Adjacent findings remain out of scope for this branch:

- `tenant/members/[userId]/reset-vault` POST step-up gap (admin-side, single-use token; separate threat shape)
- `extension/token/refresh` lifetime extension (separate refresh-policy discussion)
- SA token POST rate-limiter gap (pre-existing; separate hardening)
- `mcp/authorize/consent` and `mobile/authorize` rate-limiter gap (pre-existing)
- NAT64 / 6to4 not in `BLOCKED_CIDRS` (defense-in-depth follow-up)
- Bearer-authenticated `/api/mcp`, `/api/mcp/token`, `/api/mobile/token` not gated by `enforceAccessRestriction` in handler (pre-existing inconsistency vs `extension/token`)
- api-route.test.ts other describe blocks may need APP_URL stub parity (low risk; surfaces if their tests start failing)
- No unit-test file for `step-up.ts` itself (T6 integration test substantially covers; helper-level unit tests are a follow-up)

Recommend opening a tracking issue or a `security-followups-plan.md` to enumerate these for next iteration.

## Verification

User-reported test status:
- `npx vitest run` on 12 affected test files: **239 tests passed**
- `npm run test:integration -- require-recent-session.integration`: **4 tests passed**

This orchestrator additionally verified:
- ESLint clean on the 6 changed production files (`src/app/api/api-keys/route.ts`, `tenant/mcp-clients/route.ts`, `tenant/access-requests/[id]/approve/route.ts`, `tenant/service-accounts/[id]/tokens/route.ts`, `vault/admin-reset/route.ts`, `lib/http/api-error-codes.ts`)
- `auth.type` enum values verified against `src/lib/auth/session/auth-or-token.ts` — the `api-keys` session-only gating correctly excludes `"token"` (extension), `"service_account"`, `"api_key"`, `"mcp_token"`

Next steps (user-driven):
- Full `npx next build` — recommended before committing per CLAUDE.md "Mandatory Checks"
- Commit and push when ready

