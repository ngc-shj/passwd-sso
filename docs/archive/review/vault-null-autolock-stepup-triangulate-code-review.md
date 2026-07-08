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
