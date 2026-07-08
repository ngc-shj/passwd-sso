# Code Review: mcp-refresh-replay-revocation-followup

Date: 2026-07-09
Review round: 1 (triangulate on merged branch #646, follow-up fixes on a new branch)
Reviewed ref: `main` @ ee331b03 (`fix(security): harden tenant network boundary and step-up recovery ...` #646, squash-merged)
Follow-up branch: `fix/mcp-refresh-replay-revocation-followup`

## Context

`/triangulate` was run against the already-merged #646 branch (tenant network-boundary + step-up recovery hardening). Three expert sub-agents (functionality / security / testing) reviewed `git diff main...HEAD` statically (node_modules absent → no vitest/tsc/next build in this environment; all bash/node-only static guards were run and pass).

**Verdict: no Critical/Major, no merge blocker.** All load-bearing behaviors verified correct: IP-gate ordering (gate strictly before mint/rotation/consume on all three token endpoints), open-redirect surface closed on the three browser-nav routes (all redirect targets self-origin; client `redirect_uri` validated against the stored allowlist before any echo), and the `check-step-up-client-coverage` guard is the mutation-verified convergence artifact for the 8→24 step-up class (primitive set now derived from "returns SESSION_STEP_UP_REQUIRED", not one function name).

Three Minor findings were confirmed and fixed on the follow-up branch.

## Functionality Findings

**F1 [Minor] — consent route throws (uncaught 500) instead of controlled 500 when app origin unconfigured**
- File: `src/app/api/mcp/authorize/consent/route.ts:87`
- Evidence: `new URL(serverAppUrl(API_PATH.MCP_AUTHORIZE))`. `serverAppUrl` returns `getAppOrigin() ?? ""` + path, so with no `APP_URL`/`AUTH_URL` it yields a relative string, and `new URL(relative)` with no base throws. `mobile/authorize`'s `redirectToSignIn` explicitly guards this (`if (!origin) return errorResponse(INTERNAL_ERROR)`); consent did not.
- Impact: only in a fully-misconfigured deployment (auth already non-functional); generic 500 vs controlled 500.
- Fix: added `if (!getAppOrigin()) return errorResponse(API_ERROR.INTERNAL_ERROR)` before the URL build, for parity with `mobile/authorize`.
- Note: `mcp/authorize` GET uses string concatenation (not `new URL()`), so it fails soft to a relative Location and does NOT throw — out of F1 scope, left as-is (matches its pre-existing no-session path).

**F2 [Nit] — exempt-file status annotations loose vs code** — documentation-only, guard does not assert status codes. No change.

## Security Findings

**S1 [Minor] — off-network refresh replay is 403'd by the IP gate BEFORE `exchangeRefreshToken`, suppressing family theft-revocation**
- File: `src/app/api/mcp/token/route.ts:206-210` (gate) vs `oauth-server.ts:469`/`641` (replay → family revocation)
- Evidence: rotated refresh tokens are retained (`rotatedAt` set, row kept), so the gate resolves a replayed token's tenantId; an off-network replay returns 403 before `exchangeRefreshToken` runs, so `revokeFamilyOutOfBand` + the `MCP_REFRESH_TOKEN_REPLAY` audit never fire. This directly contradicts the branch's own in-function ordering comment (`oauth-server.ts:514-516`: passkey enforcement is placed AFTER replay detection precisely "so theft-detection family-revocation for a replayed token is never suppressed") — the new route-level IP gate reintroduces that suppression for the IP dimension.
- Attack: holder of a stolen, already-rotated MCP refresh token, replaying off-network, against an IP-restricted tenant. The immediate mint is still blocked (confidentiality holds), but the theft alarm and family revocation are silently skipped → the family's live tokens stay valid for an on-network attacker / second exfil path. Defense-in-depth / detection weakening, not a direct access-control break.
- Fix: `resolveRefreshTokenTenantId` → `resolveRefreshTokenGate`, now returning `{ tenantId, alreadyRotated }` (reads `rotatedAt`). The route applies the IP gate only when `!refreshGate.alreadyRotated`; a replayed token skips the gate and falls through to `exchangeRefreshToken`, which revokes the family. Live-rotation requests are still IP-gated before rotation. `resolveCodeTenantId` unchanged (authorization codes have no replay/rotate concept).
- escalate: false

**S2 / S3 [Info] — `@browser-redirect` guard soundness residual; token-endpoint 403-vs-400 differential**
- S3 (guard): the sentinel exempts a route from the client-marker check; nothing MECHANICALLY proves a `@browser-redirect` route redirects rather than returning JSON 403 — only hand-written route tests pin it (all three current entries DO have such tests). Residual process-integrity gap, appropriately bounded (human-reviewed exempt-list edit + reason required). Optional future hardening: have the guard grep each `@browser-redirect` handler for `NextResponse.redirect` on the 403 path. Not fixed — Info, out of this PR's scope.
- S2 (oracle): a valid-but-off-network code/token returns 403 ACCESS_DENIED while a nonexistent one returns 400 invalid_grant. Negligible — the differential only distinguishes states for a high-entropy secret the attacker already possesses; no enumeration is enabled. No fix (collapsing to a uniform error would remove the legitimate ACCESS_DENIED signal for real clients).

## Testing Findings

**T1 [Minor] — MCP token route never exercised the null-resolver "skip gate → invalid_grant" branch**
- File: `src/app/api/mcp/token/route.test.ts`
- Evidence: resolver mocks were pinned truthy in `beforeEach`; the `invalid_grant` tests ran with the gate invoked-and-allowed, so the `if (codeTenantId)` / `if (refreshTenantId)` skip branch had no route-level test.
- Fix: added route-level tests for both grant types:
  - `authorization_code`: unknown code → null tenant → `enforceAccessRestriction` NOT called, `exchangeCodeForToken` called, 400 `invalid_grant`.
  - `refresh_token`: unknown token → null gate → same.
  - `refresh_token`: **replayed (already-rotated) token → IP gate SKIPPED** (`enforceAccessRestriction` NOT called even when it would deny), `exchangeRefreshToken` called (family revocation not suppressed) — the regression test for S1.
- Also updated `oauth-server.test.ts` for the `resolveRefreshTokenGate` rename: live → `{tenantId, alreadyRotated:false}`, replayed → `alreadyRotated:true`, missing → `null`, and asserts the `select` now reads `rotatedAt`.

**Red-flag scan (all existing + added tests): clean.** Deny-mocks return correct `NextResponse|null` shape; every `not.toHaveBeenCalled()` paired with a matching deny setup; async `POST` awaited; per-test state in `beforeEach`.

## Resolution Status

### S1 [Minor] off-network refresh replay suppresses family revocation — Fixed
- Action: added `alreadyRotated` to the refresh-token gate resolver; route skips the IP gate for replayed tokens so they reach `exchangeRefreshToken` (family revocation).
- Modified: `src/lib/mcp/oauth-server.ts` (`resolveRefreshTokenGate` + `RefreshTokenGate`), `src/app/api/mcp/token/route.ts:206-214`, `scripts/checks/route-policy-manifest.json:579` (documented the exception).

### T1 [Minor] null-resolver skip branch untested — Fixed
- Action: added 3 route-level tests (authz-code null, refresh null, refresh replay-skip) + updated `resolveRefreshTokenGate` unit tests.
- Modified: `src/app/api/mcp/token/route.test.ts`, `src/lib/mcp/oauth-server.test.ts`.

### F1 [Minor] consent route uncaught 500 on unconfigured origin — Fixed
- Action: added `getAppOrigin()` presence guard before the `new URL()` build (parity with `mobile/authorize`).
- Modified: `src/app/api/mcp/authorize/consent/route.ts:87`.

### S2, S3, F2 — Accepted (Info/Nit), no change
- S2 (403/400 oracle): negligible — high-entropy secrets, no enumeration; collapsing errors would remove the legitimate ACCESS_DENIED signal.
- S3 (`@browser-redirect` mechanical proof): residual process gap, bounded by required human-reviewed exempt-list edits + per-route redirect tests; optional guard hardening noted for a future PR.
- F2 (annotation looseness): documentation-only, guard does not assert status codes.

### N1 [Nit] replay audit `metadata.clientId` is the self-asserted request-body value — Accepted, no change
- Source: second-opinion external review (post-merge follow-up on this branch).
- Detail: `route.ts` replay branch fires `MCP_REFRESH_TOKEN_REPLAY` before client validation, so `metadata.clientId` = `clientIdValue` (request body). `familyId` and `tenantId` are stored-row-derived and correct; `clientId` is auxiliary metadata only, and family revocation fires correctly regardless of the asserted client_id. Attacker must already hold a high-entropy refresh token.
- Anti-Deferral check: acceptable risk. Worst case: forensic metadata shows an attacker-chosen client_id string on a replay event (family/tenant still accurate). Likelihood: low (requires a stolen rotated token). Cost to fix: the `replay`/`race_lost` outcome in `exchangeRefreshToken` (`oauth-server.ts:652-666`) would need to carry the stored public `mcpClientId` (`mcpc_xxx`) — `rt` selects only the internal `clientId` FK UUID, so an extra client lookup/join on the replay path (+1 DB read on the theft-detection path) is required. Not worth the forensic-only gain now.
- TODO(mcp-refresh-replay-revocation-followup): surface stored `mcpClientId` in the replay/race_lost outcome and use it for the replay audit metadata instead of the request-body client_id.

### N2, N3 — Accepted (Nit), no change
- N2 (live-token off-network denial does rotation-prevention, not family theft-revocation): deliberate — off-network ≠ theft; auto-revoking a live family on every off-network hit would DoS legitimate users.
- N3 (theoretical TOCTOU between `resolveRefreshTokenGate` and `exchangeRefreshToken`): a token that flips live→rotated in the gap is handled safely — the subsequent replay attempt triggers family revocation; the momentary "resolved live, then off-network 403" leaves the family intact, which is the correct outcome for a live token.

## Environment Verification Report

N/A — no environment constraints declared in a Phase 1 (this was a review-only triangulate on a merged branch). All mandatory checks executed and passed on this developer machine:
- `verified-local` — `npx vitest run`: **12124 passed / 1 skipped**, 0 failed (full suite).
- `verified-local` — `npx next build`: succeeded (production build, all routes compiled).
- `verified-local` — `npm run lint`: 0 errors; the 4 pre-existing warnings are all in untouched files (`auto-extension-connect.tsx`, `use-password-entry-detail.test.tsx`, `delegation.ts`) — none in the changed files.
- `verified-local` — static guards all green: `check-step-up-client-coverage`, `check-passkey-mint-gate`, `check-fail-closed-routes-have-test`, `check-raw-body-read`, `check-permanent-delete-stepup`, `check-api-error-body-drift`, `check-bypass-rls`, `check-count-then-create-lock`, `check-raw-sql-usage`.
