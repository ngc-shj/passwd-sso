# Code Review (Triangulate): vault-null-autolock + step-up-client-coverage (PRs #642–#645)

Date: 2026-07-08
Review round: 1 (standalone — code already merged to `main`)
Scope: `git diff 9b8476dc..775e857a` (137 files, +6126/-262)
Method: three expert sub-agents (functionality / security / testing), independently verified by orchestrator.

## Changes from Previous Round
Initial triangulated review, run to validate the user's prior "Approve" conclusion on the
combined vault auto-lock hardening + step-up client-recovery coverage work.

## Functionality Findings
No findings. All six focus areas verified correct:
- Auto-lock null→15-min default coalesced on both client (`auto-lock-context.tsx:36-39`,
  `vault-context.tsx:213-217`) and server (`tenant/policy/route.ts:739-742` wraps the whole
  ternary in `?? VAULT_AUTO_LOCK_DEFAULT`); DB stays `null`, client re-derives 15 → consistent.
- Hidden→visible transition is lock-FIRST (`auto-lock-context.tsx:70-77`) — evaluates timeout
  before resetting activity, closing the throttled-background-interval fail-open window.
- `handle-step-up-error.ts` reads the response body exactly once; retry-arg passing type-aligns.
- Optimistic-UI rollback: `entry-list-view.tsx:463-472` rolls back (via `reload()`) before
  opening reauth on `StepUpRequiredError` — no phantom delete.
- `use-bulk-action.ts:167` fails safe when `onStepUpRequired` is absent (error toast, not silent success).
- `entry-form-helpers.ts` keep-if-touched filter drops only the phantom unfilled row; no silent-drop path.

## Security Findings

### S1 [Major]: CI step-up coverage guard is blind to 2 of 3 step-up primitives (anti-drift completeness gap)
- **File**: `scripts/checks/check-step-up-client-coverage.sh:194,197`
- **Evidence**: The guard derives its server-gated-route set with a single grep for
  `requireRecentCurrentAuthMethod\(`. But three primitives default `errorCode =
  API_ERROR.SESSION_STEP_UP_REQUIRED` and thus emit the exact 403 the guard polices:
  - `requireRecentCurrentAuthMethod` — covered
  - `requireRecentSession` (`src/lib/auth/session/step-up.ts:26`) — **NOT covered**
  - `requireRecentPasskeyVerification` (`src/lib/auth/webauthn/recent-passkey-verification.ts:30`) — not covered
  Three live routes gate with `requireRecentSession(req)` and no `errorCode` override, so they
  return `SESSION_STEP_UP_REQUIRED` yet are invisible to the guard:
  `src/app/api/mcp/authorize/route.ts:76`, `src/app/api/mcp/authorize/consent/route.ts:40`,
  `src/app/api/mobile/authorize/route.ts:125`. (`requireRecentPasskeyVerification` has no route
  callers today — latent.)
- **Problem**: The guard's contract is "every step-up-gated route has enforced client recovery,"
  but it anchors on ONE spelling of the gating primitive instead of the defining behavior (returns
  `SESSION_STEP_UP_REQUIRED`). This is the R42 "seed is not the set" pattern
  ([[feedback_triangulate_enumerate_completeness]]): the member-set was derived from the prompt's
  named function, not from the primitive that defines class membership.
- **Impact**: Guard-soundness / anti-drift, NOT a live auth bypass. Server enforcement is fully
  intact for all covered routes AND the 3 `requireRecentSession` routes. The 3 current routes are
  OAuth/mobile authorize endpoints reached by browser navigation/redirect, so their 403
  self-recovers via normal re-login — practical UX gap today is negligible. The durable defect: a
  future `requireRecentSession`-gated mutation reached by a fetch-based UI card would ship with a
  swallowed 403 (generic error / phantom optimistic mutation) and CI would stay green —
  reintroducing exactly the "server enforces, client swallows" class this guard exists to close.
- **Fix**: Derive the server set from all step-up primitives:
  `grep -E 'requireRecentCurrentAuthMethod\(|requireRecentSession\(|requireRecentPasskeyVerification\('`
  (or, more robustly, enumerate exported gate functions whose default `errorCode` is
  `SESSION_STEP_UP_REQUIRED`). Add `@stepup` markers to the 3 `requireRecentSession` routes OR
  exempt them in `stepup-client-exempt.txt` with the browser-redirect justification. Add a
  self-test fixture using `requireRecentSession` to lock the behavior in.
- escalate: false — server-side enforcement is intact for every gated route; blast radius is 3
  self-recovering browser-redirect endpoints. This is a completeness hole in a defense-in-depth
  CI guard, not a Critical auth bypass.

Areas verified clean (no finding): auto-lock fail-open (lock-first confirmed), null⇒15-min
everywhere (no layer treats null as "disabled"), `mergedVaultAutoLock` explicit-null cross-field
validation (closed — wrapped in `?? DEFAULT`), runtime minimum vs suspension (fails safe/locking),
server step-up enforcement not weakened by client changes (diff added only marker comments; no
check removed), exempt allowlist 3 entries all justified + anti-drift-live, no secret/token/session
logging, custom-field filter is client-side E2E-blob shaping only.

## Testing Findings
No blocking findings. Test additions are high quality and mutation-verified:
- Each of the 4 fixes ships a regression test confirmed RED pre-fix (lock-first, null→15 reset,
  keep-if-touched, hidden-cap removal).
- The CI guard is genuinely mutation-verified: `scripts/__tests__/check-step-up-client-coverage.test.mjs`
  (10 fixtures incl. file-vs-adjacency scoping) drives the real guard binary and proves it goes RED;
  `scripts/pre-pr.sh:166` wires it into the gate; `.test.mjs` is in `vitest.config.ts`.
- E2E `step-up-stale-window.spec.ts` registered, asserts by `role=alertdialog` (i18n-robust,
  avoids the known phantom-match trap), restores session recency in afterAll.
- `use-bulk-action` `onStepUpRequired`-absent fail-safe path is tested.

## Adjacent Findings
None material. (Testing expert noted 2 false-positive red-flags in `entry-list-view.test.tsx` from a
delegated scan — both confirmed non-issues: an `import` line and mock-module definitions, not
test-body resets.)

## Convergence note (S1 and the R42 guard)
S1 is itself about the step-up guard's class-membership derivation. Per the phase-3 convergence rule,
a ≥2×-expanded R42 class closes only under a mutation-verified guard. Here the guard EXISTS and is
mutation-verified for its covered primitive — but its member-set derivation is incomplete (misses
2 of 3 primitives). The fix for S1 is precisely to re-derive the guard's set from the defining
primitive (`errorCode default == SESSION_STEP_UP_REQUIRED`) rather than the one function name, then
add a `requireRecentSession` self-test fixture. Until that lands, the guard gives false assurance on
exactly the invariant it advertises (RT7 shape b) for the 2 uncovered primitives.

## Resolution Status

### S1 [Major] CI step-up guard blind to 2 of 3 step-up primitives — FIXED
- **Action**: Broadened the guard's server-set derivation from a single-primitive grep
  (`requireRecentCurrentAuthMethod\(`) to a `STEPUP_PRIMITIVE_RE` covering all three primitives
  whose default `errorCode` is `SESSION_STEP_UP_REQUIRED` (`requireRecentCurrentAuthMethod`,
  `requireRecentSession`, `requireRecentPasskeyVerification`). The regex is used at both the
  file-discovery grep and the per-call completeness grep.
- **Routes marked**: Added `// @stepup id:… method:…` server markers to the 3 now-discovered
  `requireRecentSession` routes: `src/app/api/mcp/authorize/route.ts:76` (mcp-authorize-get),
  `src/app/api/mcp/authorize/consent/route.ts:40` (mcp-authorize-consent-post),
  `src/app/api/mobile/authorize/route.ts:125` (mobile-authorize-get).
- **Exempt disposition**: All 3 are browser-navigation/redirect OAuth-authorize endpoints with no
  fetch-based UI caller — their stale-session recovery is the server's own `NextResponse.redirect`
  to sign-in. Added a new `@browser-redirect` sentinel to the exempt mechanism
  (`scripts/checks/stepup-client-exempt.txt`) that exempts a route from the client-tree anti-drift
  check *only* when there is genuinely no interactive client. The guard rejects using this sentinel
  as a general escape hatch for fetch-reachable routes (documented in the exempt file header).
- **Mutation-verified**: Proven the guard now goes RED for the new primitive — (1) removing a
  route's server marker → `SERVER_MARKER_MISSING`; (2) removing the exempt entries →
  `MISSING_CLIENT_MARKER` ×3. Restored to green after each. Self-test fixtures (ix), (ix-coverage),
  (x), (x-guard) added to `scripts/__tests__/check-step-up-client-coverage.test.mjs` (14/14 pass)
  lock in that `requireRecentSession` is discovered and that the `@browser-redirect` sentinel works.
- **Wired**: guard runs in `scripts/pre-pr.sh:166` (pre-existing wiring; unchanged).
- **R42 class closure**: `R42 class step-up-gated-routes: member-set derivation corrected from
  1-primitive to 3-primitive — closed by mutation-verified CI guard
  scripts/checks/check-step-up-client-coverage.sh (red-proven: drop a route's @stepup marker →
  SERVER_MARKER_MISSING; drop exempt entry → MISSING_CLIENT_MARKER), wired in scripts/pre-pr.sh:166.`

Functionality and Testing findings: none — no action required.

### S2 [Medium] `/api/user/passkey-status` bypassed tenant IP access restriction — FIXED
- **Finding source**: user-supplied security review (post-triangulate), independently verified.
- **Evidence**: `/api/user/passkey-status` was classified `api-default` (route-policy-manifest.json),
  not `api-session-required`. The proxy applies tenant IP restriction
  (`checkAccessRestrictionWithAudit`) ONLY in the `API_SESSION_REQUIRED` branch
  (`src/lib/proxy/api-route.ts:126-140`). The handler (`route.ts:21-24`) self-checks *authentication*
  via `checkAuth` but does NOT self-enforce IP restriction — so a logged-in user from a blocked
  network (outside `allowedCidrs` / Tailscale) could read tenant passkey-enforcement policy. This
  contradicts the documented boundary (`docs/security/policy-enforcement.md`: "Session-cookie routes
  are blocked in proxy (`API_SESSION_REQUIRED`)").
- **Root cause / blind spot**: the manifest's `handlerAuthReason` for this route reasoned only about
  the *authentication* dimension ("still session-gated at the handler level") and missed the
  *IP-restriction* consequence of `api-default`. Every other `/api/user/*` route is
  `api-session-required`; passkey-status was the lone outlier.
- **Fix** (chosen: reclassify, not in-handler enforcement — matches the sibling SSoT pattern):
  Added `API_PATH.USER_PASSKEY_STATUS` to `SESSION_REQUIRED_PREFIXES`
  (`src/lib/proxy/route-policy.ts`), updated the manifest entry `kind` → `api-session-required` and
  dropped the now-stale `handlerAuthReason`. The route now gets proxy IP enforcement like its
  siblings. Verified safe: passkey-status is a dashboard-only session-cookie route (grace-period
  banner), no extension/mobile/bearer caller, and already 401s cookieless requests — so proxy
  session-gating is behavior-compatible.
- **Regression test**: added `/api/user/passkey-status` to the `API_SESSION_REQUIRED` positive-case
  table in `src/lib/proxy/route-policy.test.ts`; mutation-verified RED pre-fix
  (`expected 'api-default' to be 'api-session-required'`). The generic IP-enforcement assertions in
  `api-route.test.ts` (ACCESS_DENIED) now cover this route via its classification. Manifest
  assertion 2 mechanically ties classification↔handler.
- **Impact**: Medium — limited data (boolean enforcement flags + grace-period days), but a real hole
  in the network-boundary model. Not a step-up-guard issue; bundled into this branch per user
  decision (single PR).

### S3 [Medium] `@browser-redirect` exemption justification was false (stale session returned JSON 403, not a redirect) — FIXED
- **Finding source**: user-supplied review of the S1 fix; a defect in my own S1 change.
- **Evidence**: The `@browser-redirect` exempt sentinel (added for S1) claimed the 3 authorize routes
  "recover via NextResponse.redirect to sign-in." But `requireRecentSession` returns
  `errorResponse(SESSION_STEP_UP_REQUIRED, 403)` (`src/lib/auth/session/step-up.ts:48`) — a JSON 403,
  NOT a redirect. All 3 routes returned it raw on the stale-session path, stranding the browser on a
  JSON 403 page. Existing tests pinned the JSON 403. So the exemption recorded a false recovery and
  the sentinel became an RT7-shape-b false-assurance escape hatch that could mask future gaps.
- **Not an auth bypass**: credential issuance still failed closed (403 blocks the mint). The defect
  was the false justification + UX dead-end, not a security bypass.
- **Fix** (chosen: make the routes genuinely redirect — path A, matching each route's own no-session
  redirect and design intent):
  - `mcp/authorize` GET (`route.ts`): stale 403 → 307 redirect to `/api/auth/signin?callbackUrl=<self>`.
  - `mobile/authorize` GET: stale 403 → reuse `redirectToSignIn(req)` (302), identical to no-session.
  - `mcp/authorize/consent` POST (native form POST): step-up gated at entry, but the redirect is
    deferred until after `client_id`/`redirect_uri` are validated (avoiding an open-redirect in the
    callback), then 303 (POST→GET) to the authorize GET with OAuth params reconstructed from the
    validated form fields; the authorize GET re-runs auth+step-up → sign-in. `unauthorized()` (no/
    absent session) paths still fail closed immediately.
- **Guard markers**: kept the 3 `@stepup id:… method:…` server markers (moved to line H-1 of the
  gate call after inserting explanatory comments, so the guard's line-adjacency completeness check
  still binds them). Rewrote the exempt-file `@browser-redirect` header + per-entry reasons to
  describe the ACTUAL redirect mechanism (307/302/303) and to require a route-level redirect test.
- **Regression tests**: rewrote the 3 "returns 403 when session step-up is required" tests to assert
  the redirect (mcp GET 307 → signin+callbackUrl; mobile 302 → /ja/auth/signin+callbackUrl; consent
  303 → /api/mcp/authorize with reconstructed client_id/redirect_uri/code_challenge/state). Added the
  `url-helpers` mock to the consent test so `serverAppUrl` yields an absolute URL. All 3 assert the
  credential-issuance mock is NOT called on the stale path (still fails closed). 354 affected tests pass.
- **Impact**: Medium — closes the UX dead-end AND makes the CI exemption honest (removes the
  false-assurance). Guard green; `@browser-redirect` justification is now true.

### S4 [Medium] `/api/mcp/token` exchange+refresh skipped tenant IP restriction — FIXED (user decision: enforce)
- **Finding source**: user-supplied review. The MCP gateway (`/api/mcp`) enforces
  `enforceAccessRestriction` ("a leaked mcp_ token must still honor allowed-CIDR"), but
  `/api/mcp/token` (auth-code exchange + refresh rotation) did NOT — a stolen refresh token could be
  rotated from an off-network IP. Docs (threat-model D5a, policy-enforcement) assert Bearer/non-session
  flows enforce `allowedCidrs` in handlers, so the token endpoint was out of contract.
- **User decision**: token endpoint is INSIDE the tenant network boundary → enforce.
- **Fix**: enforce IP restriction on the resolved tenantId BEFORE the side-effecting exchange for both
  grant types (so no orphan token is minted and, critically for refresh, the rotation chain is not
  advanced before a denial — post-rotation denial would strand a legitimate client). Added two
  read-only resolvers `resolveCodeTenantId` / `resolveRefreshTokenTenantId` to `oauth-server.ts`
  (look up the grant's tenantId without mutation); the route calls
  `enforceAccessRestriction(req, SYSTEM_ACTOR_ID, tenantId, ACTOR_TYPE.MCP_AGENT)` and returns the
  deny response before the exchange. A grant that resolves to no tenant skips the gate and the
  exchange produces the authoritative invalid_grant (the gate only restricts, never grants).
- **Why pre-exchange, not inside**: mirrors the existing passkey-enforcement gate's "block before
  mint" position but keeps the exchange HTTP-agnostic; reuses the vetted `enforceAccessRestriction`
  (incl. Tailscale WhoIs + ACCESS_DENIED audit) rather than duplicating it.
- **Tests**: 2 route regression tests (auth-code + refresh) assert deny→403 and that the exchange is
  NOT called (mutation-verified RED without the guard); 4 resolver unit tests in oauth-server.test.ts.
- **Docs**: threat-model D5a now lists `/api/mcp/token` with the pre-mint rationale; manifest
  `handlerAuthReason` + regenerated route-policy-matrix updated.

### S5 [Medium] R42 横展開 of S4: other credential-issuing Bearer routes also skipped IP restriction — FIXED
- **Trigger**: S4 was one instance of a class (Bearer/token-issuing routes that skip proxy IP
  enforcement because they're `api-default`). Per the R42 discipline, swept the full member-set from
  the primitive (all Bearer/non-session routes under v1/extension/mcp/mobile/scim) rather than
  trusting S4 was the only member.
- **Sweep result**:
  - `/api/scim/v2/*` — ✅ already enforces IP inside `authorizeScim` (`with-scim-auth.ts:28`). Not a gap.
  - `/api/mcp/revoke` — intentionally NOT gated (RFC 7009 revocation must work from any network so a
    compromised token can always be killed). Documented as an exception in D5a. Not a gap.
  - `/api/mobile/autofill-token` — **GAP**: mints a `passwords:write` DPoP-bound AutoFill token from an
    IOS_APP bearer token; had `tenantId` in hand but no `enforceAccessRestriction`. A stolen IOS_APP
    token could mint off-network. FIXED: enforce on the authenticated tenantId before the mint.
  - `/api/extension/token/exchange` — **GAP**: mints an extension token from a bridge code; no IP
    enforcement (its companion `token/refresh` already enforces). FIXED: enforce on the resolved
    tenantId after the read-only bridge-code lookup, BEFORE DPoP/CAS-consume — so an off-network
    attempt neither consumes the code nor mints.
- **Tests**: 1 deny regression test each (mutation-verified RED without the guard); both assert the
  mint/consume primitive is NOT called on deny.
- **Docs**: D5a mechanism text enumerates all credential-issuing endpoints now covered + the revoke
  exception.
- **Class closure note**: the class is "credential-issuing Bearer endpoint that resolves a tenantId";
  the enforcement point is uniformly "before the side-effecting mint/rotate/consume." No CI guard
  mechanizes this class yet — a future `check-bearer-issue-ip-coverage` (enumerate routes that call a
  token-issuing primitive AND lack an enforceAccessRestriction call) would lock it; tracked, not built
  this round. TODO(network-boundary): mechanize the Bearer-issue IP-coverage class.
