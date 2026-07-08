# Plan Review: fix-mcp-oauth-stepup-recovery
Date: 2026-07-09
Review rounds: 2

## Changes from Previous Round

Round 1 reviewed a narrow one-line plan (URL doubling only). During round-1 assessment the
functionality expert's loop finding (F1) was **confirmed live** (redirect-chain capture with a
real session), triggering an essence shift: the plan was rewritten from a 1-line URL fix to a
3-layer fix (L1 URL doubling / L2 non-canonical step-up primitive / L3 unrecoverable signin
bounce). Round 2 reviewed the rewritten plan. All round-2 findings were incorporated into the
plan text; no contract architecture changed.

## Functionality Findings

- **F1 Major (round 1) — RESOLVED**: fixing the URL alone exposes an infinite step-up redirect
  loop (signin short-circuits authenticated users without re-auth; `createdAt` never refreshes).
  Confirmed by live capture. → became L3 / C3 (reauth panel + recovery-liveness invariant I6).
- **F2 Minor (round 1) — RESOLVED**: stale comment at signin page.tsx:55-58 → folded into C1.
- **F3 Info (round 1)**: double `callbackUrlToHref` computation — negligible, noted.
- **F4 Major (round 2) — RESOLVED**: wrapper mapping must preserve caller-supplied `errorCode`
  (`operator-tokens` passes `OPERATOR_TOKEN_STALE_SESSION`; client branches on it) → C3
  signature now `options.errorCode ?? SESSION_STEP_UP_REQUIRED` + acceptance case.
- **F5 Minor (round 2) — RESOLVED**: page-side session-token extraction must reuse the
  cookie-name SSoT (3 name shapes) → C3 mandates a `cookies()`-variant next to `getSessionToken`.
- **F6 Minor (round 2) — RESOLVED**: webauthn-provider session with all credentials deleted
  dead-ends a passkey-only panel → "sign in again" is always rendered; `canUsePasskey` derived
  server-side (provider + credential count).
- **F7 Info (round 2) — RECORDED**: panel inherits signin-page locale; mobile bounce hardcodes
  DEFAULT_LOCALE — pre-existing, noted in C3 acceptance.
- **F8 Info (round 2) — RESOLVED**: core collapses chooser's 2 DB queries into 1; per-branch
  window constants imported (not hardcoded) — I6 parity assumes they stay equal.

## Security Findings

Round 1 (narrow plan): approve, no findings. Adversarial open-redirect traces of
`resolveCallbackUrl` → `callbackUrlToHref` all safe; OAuth params preserved; auth gate unchanged.
Adjacent: `/passwd-sso//evil.com` → `//evil.com` normalization residue in the NON-API branch —
pre-existing, not exploitable via the API branch → tracked as SC3.

Round 2 (3-layer plan): **no Critical; escalate false; verdict Go — net security improvement.**
- Q1: C2 chooser switch is NOT a downgrade — `passkeyVerifiedAt` requires a live WebAuthn
  assertion (stronger than `createdAt`, which silent IdP re-federation can refresh); absolute
  session cap (`auth-adapter.ts:588,603`, measured from `createdAt`, non-rolling) bounds
  webauthn session lifetime; operator/SA-token minting already uses the chooser.
- Q2: panel is not a usable oracle (SOP, SameSite=Lax, XFO/CSP); signOut is button-gated AND
  Auth.js-CSRF-protected; adversarial callbackUrls cannot reach the panel (`/api/` prefix
  predicate excludes all `//`-residue outputs).
- Q5: signOut nested callbackUrl safe end-to-end (Auth.js default redirect callback same-origin
  + `resolveCallbackUrl` re-validation on return — two independent gates).
- Q6: the 3-route call swap removes no check; ordering unchanged; consent's
  validate-before-stale-bounce open-redirect ordering untouched.
- **S1 Low — RESOLVED**: `callbackHref` structural invariant `^\/(?!\/)` + server-computed-only,
  asserted in panel + test (drift hardening).
- **S2 Low — RESOLVED**: page-side token extraction SSoT (same fix as F5).
- **S3 Info — RESOLVED**: SC4 accepted-residual worst case recorded verbatim in the plan.

## Testing Findings

- **T1 Critical (round 1) — RESOLVED**: `next/navigation` `redirect` must be mocked as a
  non-throwing spy or the L1 test is green-on-both → C4 prerequisite (a).
- **T2 Major (round 1) — RESOLVED**: separate test file required (module-scope `BASE_PATH: ""`
  mock is static) → C4 prerequisite (b), mirrors proven `callback-url-basepath.test.ts`.
- **T3 Minor (round 1) — RESOLVED**: non-API branch assertion under non-empty basePath → C4.
- **T4 Info (round 1)**: mock propagation empirically verified; don't mock callback-url;
  framework basePath re-prepend correctly not unit-tested.
- **T5 Major (round 2) — RESOLVED**: 3 route test files mock the OLD step-up module; C2 swap
  breaks them loudly → rewiring enumerated in C4 (chooser mock, no-options assertion).
- **T6 Major (round 2) — RESOLVED**: extraction breaks 5 chooser delegation tests; matrix must
  add options passthrough + `webauthn + passkeyVerifiedAt: null` → `"stale"` → C4.
- **T7 Major (round 2) — RESOLVED**: page tests need `next/headers` + freshness-core +
  panel-spy mocks → C4.
- **T8 Major (round 2) — RESOLVED**: inverse-L1 case — panel `callbackHref` asserted
  basePath-QUALIFIED → C4.
- **T9 Minor (round 2) — RESOLVED**: panel test jsdom pragma + `signout-button.test.tsx`
  template → C4.
- **T10 Minor (round 2) — RESOLVED**: guard verified safe for the swap; add
  `evaluateStepUpFreshness` to `STEPUP_PRIMITIVE_RE`; sync exempt comments → C4 guard upkeep.
- **T11 Minor (round 2) — RESOLVED**: `canUsePasskey` prop derivation cases → C4.
- **T12 Info (round 2) — RECORDED**: reuse existing consent 303-funnel test; "import gone" is
  the forbidden-pattern grep, not a vitest assertion.

## Adjacent Findings

- Security→Testing: keep the "fresh `passkeyVerifiedAt` + old `createdAt` → fresh" acceptance
  non-mocked at the core level → folded into T6 resolution.
- Testing→guard-design: `evaluateStepUpFreshness` not in the primitive regex → T10, resolved.
- Security round 1: SC3 (`//` residue hardening) routed to a future PR — tracked in plan scope
  contract.

## Resolution Status

All Critical/Major findings incorporated into the plan. No skipped/deferred findings except
scope-contract items (SC1-SC4, SC-E2E) each carrying owner + tracking in the plan. Go/No-Go:
C1-C4 locked.

## Recurring Issue Check

Round-2 experts ran targeted verification rather than the full R1-R42 sweep (focused bug-fix
plan; the blast-radius audit substituted for the codebase-awareness obligation). Notable:
- R42 member-set derivation: performed for C2 (3 gate sites derived from the defining primitive
  grep; verified exactly 3, no aliases) and for the step-up guard primitive set (T10).
- R12-class (i18n key coverage): C3 acceptance requires ja/en keys; ja domain-language rule
  applied (no internal jargon).
- R29 (spec citations): none introduced.
