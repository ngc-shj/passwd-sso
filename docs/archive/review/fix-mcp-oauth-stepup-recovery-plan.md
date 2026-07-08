# Plan: Fix MCP/iOS OAuth step-up recovery (3-layer defect)

## Project context

- **Type**: web app (Next.js 16 App Router, TypeScript, Auth.js v5 database sessions, `basePath` via `NEXT_PUBLIC_BASE_PATH`)
- **Test infrastructure**: unit + integration (vitest) + E2E (Playwright) + CI/CD
- **Verification environment constraints**:
  - `VC1` — The URL-doubling failure (L1) requires `NEXT_PUBLIC_BASE_PATH` set AND a stale-but-valid session. Local dev usually runs empty basePath → doubling invisible. Regression tests MUST stub a non-empty `BASE_PATH`: `verifiable-CI`.
  - `VC2` — The step-up loop (L2/L3) requires a session older than `STEP_UP_WINDOW_MS` (15 min). Reproduced manually via live redirect-chain capture with a real session cookie. Full browser E2E of the recovery (reauth → consent) is not wired in CI: `blocked-deferred` — see `SC-E2E`.
  - `VC3` — Non-WebAuthn recovery exercises the Auth.js provider sign-in flow. Google/SAML round-trips need an external IdP: `blocked-deferred`. Magic-link (Mailpit) and passkey (virtual authenticator) paths: `verifiable-local`.

## Objective

Make MCP OAuth (Claude Code, passwd-sso CLI) and iOS OAuth login succeed for a stale-but-valid session, on any basePath, for every session provider type. Three verified defects currently combine to break it:

- **L1 — URL doubling** (basePath deployments): signin page passes a basePath-qualified path to Next's `redirect()`, which re-prepends basePath → `/passwd-sso/passwd-sso/api/mcp/authorize` → intl adds locale → 404.
- **L2 — non-canonical step-up primitive**: the three browser-redirect OAuth gates call `requireRecentSession` (createdAt) directly instead of the canonical chooser `requireRecentCurrentAuthMethod`, so even WebAuthn users cannot recover via the passkey `passkeyVerifiedAt` path there.
- **L3 — signin bounce cannot re-authenticate**: every stale-session recovery path (mcp authorize GET 403, consent POST stale→authorize→…, mobile authorize GET 403) funnels into "redirect to signin with callbackUrl", but the signin page short-circuits any authenticated user straight back to the callback WITHOUT re-authenticating. `Session.createdAt` never refreshes → gate fails again → **infinite redirect loop** (masked as a 404 by L1 on basePath deployments; a live loop elsewhere).

## Root cause (all verified)

### L1 — live redirect-chain capture
`src/app/[locale]/auth/signin/page.tsx:59`: `nextRedirect(resolved)` where `resolved` is basePath-qualified. Next server-component `redirect()` re-prepends basePath. Sibling non-API branch already strips via `callbackUrlToHref`. Introduced PR #529 (v0.4.57). Never caught: `signin/page.test.ts:28` mocks `BASE_PATH: ""`.

### L2 — code read + member-set derivation (R42)
Defining primitive grep (`requireRecentSession\(` outside the chooser): exactly 3 members —
- `src/app/api/mcp/authorize/route.ts:81` (GET)
- `src/app/api/mcp/authorize/consent/route.ts:48` (POST)
- `src/app/api/mobile/authorize/route.ts:131` (GET)

The canonical chooser `requireRecentCurrentAuthMethod` (`src/lib/auth/session/recent-current-auth-method.ts:26`) routes `provider === "webauthn"` → `requireRecentPasskeyVerification` (`passkeyVerifiedAt`, recoverable via ceremony) and everything else → `requireRecentSession`. All ~45 in-app gated routes use the chooser; only these 3 browser-redirect routes bypass it.

### L3 — code read + git history
`requireRecentSession` gates on `Session.createdAt` (`step-up.ts:47`); only `createSession` (fresh sign-in) sets it (`auth-adapter.ts:326`). The in-app recovery for non-WebAuthn sessions already exists: `RecentSessionRequiredDialog` (`src/components/auth/recent-session-required-dialog.tsx:38-46`) does `signOut({ callbackUrl: signin?callbackUrl=<current> })` — sign out (old session destroyed), land on signin unauthenticated, real sign-in mints a fresh session. The browser-redirect flows lack this: PR #646 added the 403→signin bounce assuming "the second pass has a recent-enough session", which is false because of the signin short-circuit (`page.tsx:44`).

## Technical approach

All recovery paths already funnel into the signin page — fix them there, reusing the existing in-app recovery components ("方式は合わせる"). No schema change (unified-field idea evaluated and rejected: for non-WebAuthn sessions a "last verified" field would be write-identical to `createdAt`; the only recoverable-without-resignin ceremony is WebAuthn's, which already has `passkeyVerifiedAt`).

1. **L1**: strip basePath before `nextRedirect` (Next re-adds it).
2. **L2**: switch the 3 browser-redirect gates to `requireRecentCurrentAuthMethod`.
3. **L3**: in the signin page's authenticated + `isApiCallbackUrl` branch, evaluate step-up freshness server-side with the SAME chooser semantics. Fresh → redirect to callback (current behavior + L1 fix). Stale → render a **reauth panel** (new client component) instead of redirecting:
   - WebAuthn session: passkey reauth ceremony (existing `reauthenticateWithPasskey()` + `PasskeyReauthDialog` pattern) → refreshes `passkeyVerifiedAt` (session kept) → navigate to callback.
   - Non-WebAuthn session: "sign in again" action (existing `RecentSessionRequiredDialog` pattern) → `signOut({ callbackUrl: signin?callbackUrl=<callback> })` → real re-sign-in → fresh session → signin short-circuit (now fresh) → callback.
   - Requires a user gesture (button) — no auto-signOut on GET (logout-CSRF hygiene).

**IdP silent re-federation caveat (explicit posture decision)**: on "sign in again", Google/SAML may re-federate without re-challenging the user (no `prompt=login` / `forceAuthn` configured — `auth.config.ts:52` uses `prompt: "consent"`). This matches the EXISTING in-app `RecentSessionRequiredDialog` posture; aligning is the consistency choice. Forcing IdP re-challenge is deferred (`SC4`).

**Shared-core refactor (no drift)**: the signin page (server component, no `NextRequest`) and the API gates must evaluate freshness identically. Extract the chooser's core into a token-parameterized function (e.g. `evaluateStepUpFreshness(sessionToken, options): Promise<"fresh" | "stale" | "invalid">`); `requireRecentCurrentAuthMethod(req)` wraps it (unchanged external contract), the signin page calls it with the token from `cookies()`. Single implementation, two entry points.

## Contracts

### C1 — signin API-callback redirect strips basePath before `nextRedirect` (L1)

- **Location**: `src/app/[locale]/auth/signin/page.tsx` line 59 + stale comment at 55-58.
- **Change**: `nextRedirect(resolved)` → `nextRedirect(callbackUrlToHref(resolved))`; update comment (basePath stripped because Next re-prepends it).
- **Invariants** (app-enforced): I1 — `Location` for an API callbackUrl contains basePath exactly once, no locale segment. I2 — non-API branch unchanged.
- **Forbidden patterns**: `pattern: nextRedirect(resolved) — reason: basePath-qualified path re-prefixed by Next redirect (the L1 bug).`
- **Acceptance**: `BASE_PATH="/passwd-sso"` + callbackUrl resolving to `/passwd-sso/api/mcp/authorize?x=1` → `nextRedirect("/api/mcp/authorize?x=1")`. `BASE_PATH=""` → same call (unchanged). Query string preserved byte-for-byte.
- **Consumer-flow walkthrough**: consumer *browser/OAuth client* (Claude Code, passwd-sso CLI `runOAuthFlow`, iOS ASWebAuthenticationSession) reads `Location`, navigates with OAuth params (`client_id`, `code_challenge`, `scope`, `state`, `redirect_uri`) intact; `callbackUrlToHref` preserves `pathname + search`. ✅

### C2 — browser-redirect OAuth gates use the canonical chooser (L2)

- **Location**: `src/app/api/mcp/authorize/route.ts:81`, `src/app/api/mcp/authorize/consent/route.ts:48`, `src/app/api/mobile/authorize/route.ts:131`.
- **Change**: `requireRecentSession(req)` → `requireRecentCurrentAuthMethod(req)` at all 3 sites (default options — no custom `maxAgeMs`).
- **Invariants**: I3 — WebAuthn sessions gate on `passkeyVerifiedAt` at these routes. I4 — non-WebAuthn gate on `createdAt` (recovered via C3). I5 — the step-up coverage guard (`scripts/checks/check-step-up-client-coverage.sh`, primitives regex line ~112 already includes all three primitive names) still passes; the `@stepup` markers and `@browser-redirect` exempt entries (`mcp-authorize-get`, `mcp-authorize-consent-post`, `mobile-authorize-get`) remain valid.
- **Forbidden patterns**: `pattern: requireRecentSession\( in src/app/api/(mcp|mobile)/ — reason: bypasses provider-aware chooser (L2).` `pattern: maxAgeMs: in the 3 gate call-sites — reason: custom window would diverge from the signin page's freshness evaluation (C3 parity invariant I6).`
- **Member-set derivation (R42)**: `grep -rn "requireRecentSession(" src/app/api/` → exactly the 3 sites above (verified in blast-radius audit); all converted, none missed. Indirect members: none (no aliased wrapper of `requireRecentSession` exists).
- **Acceptance**: WebAuthn session with fresh `passkeyVerifiedAt` but old `createdAt` passes all 3 gates (today it fails — proves the switch is live).

### C3 — signin page reauth panel for stale step-up API callbacks (L3)

- **Location**: `src/app/[locale]/auth/signin/page.tsx` (authenticated branch), new client component (e.g. `src/components/auth/signin-reauth-panel.tsx`), shared-core extraction in `src/lib/auth/session/recent-current-auth-method.ts`, i18n keys in `messages/ja.json` + `messages/en.json`.
- **Signatures**:
  - `evaluateStepUpFreshness(sessionToken: string, options?: RequireRecentSessionOptions): Promise<"fresh" | "stale" | "invalid">` — extracted core; ONE `session.findUnique` selecting `{ provider, createdAt, passkeyVerifiedAt }` (F8: collapse the chooser's two round-trips; do not add a third). Branch semantics: `provider === "webauthn"` → `passkeyVerifiedAt` (a NULL `passkeyVerifiedAt` on a live row is `"stale"`, NOT `"invalid"` — matches today's 403 at `recent-passkey-verification.ts:51-52`); other providers → `createdAt`. Default windows stay the per-branch constants (`PASSKEY_VERIFICATION_WINDOW_MS` / `STEP_UP_WINDOW_MS` — both 15 min today; I6 parity silently assumes they remain equal, so the core must import both, not hardcode one).
  - `requireRecentCurrentAuthMethod(req, options)` becomes a thin wrapper: no token → `unauthorized()`; `"invalid"` → `unauthorized()`; `"stale"` → `errorResponse(options.errorCode ?? SESSION_STEP_UP_REQUIRED, 403)` (**F4: MUST preserve caller-supplied `errorCode`** — `operator-tokens/route.ts:140` passes `OPERATOR_TOKEN_STALE_SESSION` and its client branches on that exact code); `"fresh"` → null. External contract unchanged for all ~45 existing callers.
  - Page-side token extraction (**F5/S2**): MUST reuse the same cookie-name SSoT as `getSessionToken` (`getSessionCookieName` + `isSecureCookieFromAuthUrl` + basePath — three name shapes `authjs.session-token` / `__Secure-` / `__Host-`, see `src/lib/auth/session/cookie-name.ts:26-33`). Add a `cookies()`-store variant next to `getSessionToken` in `src/app/api/sessions/helpers.ts`; never hand-roll the name in the page.
  - `SignInReauthPanel({ callbackHref, canUsePasskey })` — client component: passkey path runs `reauthenticateWithPasskey()` then `window.location.assign(callbackHref)` (basePath-QUALIFIED — client navigation gets no framework re-prepend; inverse of C1's stripped form); non-passkey path button runs `signOut({ callbackUrl: <signin with callbackUrl> })` (mirrors `RecentSessionRequiredDialog:38-46`). **F6**: the "sign in again" action is ALWAYS rendered (secondary action on the passkey branch) — a webauthn-provider user who deleted every credential after sign-in must not dead-end (the bootstrap invariant holds at session creation only; `DELETE /api/webauthn/credentials/[id]` has no last-credential guard). `canUsePasskey` is derived server-side: `provider === "webauthn"` AND user has ≥1 registered credential.
  - **S1 hardening invariant**: `callbackHref` must always be the server-computed `resolved` (never re-derived client-side) and must match `^\/(?!\/)` — assert it in the panel (refuse navigation otherwise) and pin it in the panel test. Guards against future drift turning `window.location.assign` into a protocol-relative open redirect at a post-reauth high-trust moment.
- **Behavior**: authenticated + `isApiCallbackUrl(resolved)` → evaluate freshness via shared core with **default options** → `"fresh"`: `nextRedirect(callbackUrlToHref(resolved))` (C1); `"stale"`: render `SignInReauthPanel`; `"invalid"`: fall through to the normal sign-in form (session row gone — cookie is a ghost).
- **Invariants**:
  - I6 (recovery-liveness, load-bearing): for every provider type, a stale-step-up API callback reaches a terminal recovery (passkey ceremony or re-sign-in) and the second pass satisfies the gate — no infinite loop. Gate parity is guaranteed by the shared core + default-options-only (see C2 forbidden pattern).
  - I7 (no-self-logout): non-WebAuthn recovery uses `signOut({ callbackUrl })` — the standard Auth.js sequence; the new session exists only after the user actually signs in again. No manual session-row surgery.
  - I8 (normal-signin-unaffected): non-API callbacks and unauthenticated visits render/redirect exactly as today.
  - I9 (no-auto-signout): signOut fires only on explicit user gesture (button), never on page load.
  - I10 (gesture-gated ceremony): passkey ceremony also starts from a button (WebAuthn user-activation requirements).
- **Forbidden patterns**: `pattern: signOut\( in a useEffect/page-load path of the new panel — reason: logout CSRF / surprise logout (I9).` `pattern: session.update(...createdAt — reason: never fake recency by mutating createdAt.`
- **Consumer-flow walkthrough**:
  - Consumer *`/api/mcp/authorize` GET second pass* reads (via chooser) `passkeyVerifiedAt` (webauthn) / `createdAt` (other): the field the panel's action refreshed for that provider type is the field the gate reads. ✅
  - Consumer *`/api/mcp/authorize/consent` POST* (native form POST from ConsentForm): stale path 303-redirects to authorize GET carrying validated OAuth params (`consent/route.ts:86-103`) → funnels into the same recovered flow. ✅
  - Consumer *`/api/mobile/authorize` GET second pass*: same chooser semantics inside ASWebAuthenticationSession; panel renders in that browser context. ✅
  - Consumer *`/dashboard/settings/sessions`*: after non-WebAuthn recovery, old session row is gone (signOut) and the new one is listed. ✅
- **Acceptance**:
  - WebAuthn stale: panel offers passkey (primary) + "sign in again" (secondary); ceremony updates `passkeyVerifiedAt`; navigate to callback; consent reached; session token unchanged.
  - WebAuthn stale, zero credentials left: `canUsePasskey: false` → "sign in again" only; no dead-end (F6/I6).
  - Non-WebAuthn stale: panel offers "sign in again"; signOut destroys old session; fresh sign-in; callback reached; consent reached; old session absent from sessions list.
  - Ghost cookie (`"invalid"`): sign-in form renders (no crash, no loop).
  - operator-tokens step-up still returns `OPERATOR_TOKEN_STALE_SESSION` in the 403 body (F4 regression case).
  - i18n: panel strings exist in both `ja` and `en` (ja uses 保管庫-style domain language; no internal jargon like "step-up" in user-facing copy). Note (F7): the panel inherits the signin page's locale; `mobile/authorize` hardcodes `DEFAULT_LOCALE` in its bounce URL (`route.ts:105`) — pre-existing signin-page behavior, not a panel defect.

### C4 — regression tests

- **Location**: new `src/app/[locale]/auth/signin/page.basepath.test.ts` (separate file — the existing file's module-scope `BASE_PATH: ""` mock cannot be overridden per-test); route tests for the 3 gates; unit tests for `evaluateStepUpFreshness`; panel component test.
- **Test-mechanism prerequisites (testing-expert-verified)**:
  - (a) `vi.mock("next/navigation", () => ({ redirect: mockNextRedirect }))` with a **non-throwing spy** — without it both pre/post-fix throw `NEXT_REDIRECT` and the L1 test is green-on-both.
  - (b) separate file with module-scope `vi.mock("@/lib/url-helpers", () => ({ BASE_PATH: "/passwd-sso", getAppOrigin: () => "https://example.com", ... }))` — mirrors the proven `callback-url-basepath.test.ts` pattern.
  - (c) do NOT mock `@/lib/auth/session/callback-url` (exercise the real strip).
- **Existing-test rewiring (T5/T6/T7 — budgeted, not incidental)**:
  - T5: the 3 route test files (`mcp/authorize/route.test.ts:62-64,199-215`, `consent/route.test.ts:110-112,250-264`, `mobile/authorize/route.test.ts:69-71,222`) mock `@/lib/auth/session/step-up` and drive stale paths through `mockRequireRecentSession`. After the C2 swap the old mock is dead and the REAL chooser runs (unmocked prisma → loud failures). Each file: mock `@/lib/auth/session/recent-current-auth-method` (default resolve `null`), rewire stale tests to the chooser mock, assert `toHaveBeenCalledWith(req)` with NO options argument (enforces the C2 no-`maxAgeMs` forbidden pattern). Keep the consent 303-funnel test (`consent/route.test.ts:250-264`) as the funnel regression — don't duplicate (T12).
  - T6: `recent-current-auth-method.test.ts:56-106` (5 delegation-assertion tests) breaks under the extraction — rewrite against the new architecture: wrapper maps core verdicts; core tested directly. Matrix: provider (`webauthn`/`google`/`null`) × (fresh/stale/no-row) PLUS `webauthn + passkeyVerifiedAt: null` → `"stale"`, options passthrough (`errorCode: OPERATOR_TOKEN_STALE_SESSION` appears in 403 body; `maxAgeMs` shifts the boundary on BOTH branches). Keep the security-load-bearing case "fresh `passkeyVerifiedAt` + old `createdAt` → fresh" non-mocked at the core level (security-review adjacent).
  - T7: `page.test.ts` gains three new module mocks or its existing authenticated-branch tests break at import/run: `next/headers` (cookie store with session token), the freshness core (per-test `"fresh" | "stale" | "invalid"`), and `SignInReauthPanel` as a hoisted spy component (mirrors `mockSignInButton` at `page.test.ts:48-53`; the existing direct-invocation + `hasElement` tree-walker harness at `:74-87` fits the panel-render assertions).
- **Cases**:
  - L1: authenticated + fresh + API callbackUrl `https://example.com/passwd-sso/api/mcp/authorize?x=1` → `mockNextRedirect` called with `/api/mcp/authorize?x=1` (RED pre-fix: receives `/passwd-sso/api/mcp/authorize?x=1`). Non-API basePath case: `redirect({ href: "/dashboard?x=1", locale })` (I2 under non-empty basePath).
  - **T8 (inverse-L1)**: stale + API callback under `BASE_PATH="/passwd-sso"` → panel prop `callbackHref === "/passwd-sso/api/mcp/authorize?x=1"` (basePath-QUALIFIED); empty-basePath file → `/api/mcp/authorize?x=1`. Without this, a stripped href in the panel 404s on basePath deployments with all tests green.
  - L2: each of the 3 routes — chooser mock called; the "direct `requireRecentSession` import gone" check is the C2 forbidden-pattern grep, NOT a vitest assertion (T12).
  - L3: freshness matrix per T6; signin page renders panel on stale / redirects on fresh / form on invalid; `canUsePasskey` prop cases (T11): webauthn-stale → `true` (with ≥1 credential), google-stale → `false`, webauthn-stale + zero credentials → `false`.
  - Panel (`src/components/auth/signin-reauth-panel.test.tsx`, `// @vitest-environment jsdom` pragma — vitest env is `node` by default; template: `signout-button.test.tsx` with its `next-auth/react` signOut mock): no `signOut` on mount (I9); click → `signOut` with correct nested callbackUrl; passkey action → `reauthenticateWithPasskey` (mocked) then `window.location.assign(callbackHref)`; S1 `^\/(?!\/)` refusal case.
- **Invariants**: I11 — L1 test RED on pre-fix code. I12 — every assertion fails if removed.
- **Guard upkeep (T10)**: add `evaluateStepUpFreshness` to `STEPUP_PRIMITIVE_RE` in `scripts/checks/check-step-up-client-coverage.sh` (a future route calling the core directly and hand-rolling the 403 must not be invisible to the guard); sync the requireRecentSession-era comment text on the 3 exempt entries in `stepup-client-exempt.txt`.

## Testing strategy

- Unit: C4 (vitest). Full suite `npx vitest run` + `npx next build` (mandatory).
- Guard: `scripts/checks/check-step-up-client-coverage.sh` must pass (C2/I5).
- Manual verify (this deployment): re-run `passwd-sso login` and Claude Code MCP connect against the Tailscale deployment with a >15-min session; confirm consent page reached and token issued (both a passkey user and a non-passkey path if available).
- Deferred: external-IdP E2E (`SC-E2E`).

## Considerations & constraints

- **Scope contract**:
  - `SC1` — 15-min `STEP_UP_WINDOW_MS` sizing is policy, not in scope (this PR makes it recoverable, not longer/shorter).
  - `SC2` — MCP discovery hardening (RFC 9728 root `oauth-protected-resource`, `WWW-Authenticate` on `/api/mcp` 401s, RFC 8414 path-aware well-known) — separate latent issue found during investigation; NOT the cause here (CLI does no discovery and hit the same defect). Future PR.
  - `SC3` — Pre-existing `/passwd-sso//evil.com` → `//evil.com` normalization quirk in the signin NON-API branch (security-review adjacent; not exploitable through the API branch). Future hardening PR.
  - `SC4` — IdP re-challenge enforcement (`prompt=login` for Google, `forceAuthn` for SAML) on the "sign in again" path. Today's in-app `RecentSessionRequiredDialog` shares the silent-re-federation posture; changing it is a product/security decision spanning both flows. Future PR. **Accepted residual (S3, security-review verbatim)**: an attacker with control of the victim's *browser* while an IdP SSO session is alive (unlocked machine, borrowed session) can satisfy step-up indefinitely and mint MCP/mobile tokens without any credential challenge. Crucially, a **stolen session cookie alone cannot** pass this recovery (attacker lacks the IdP session), so the step-up gate's primary threat model (cookie theft) is intact.
  - `SC-E2E` — full basePath + provider Playwright harness (VC2/VC3).
- **Out of scope**: schema changes (unified auth-verified field rejected — see Technical approach), `resolveCallbackUrl`/`callbackUrlToHref` internals, intl routing, proxy modules.
- **Risk**: L1 trivial; L2 low (3-site call swap, guard-covered); L3 medium — touches signin UX; mitigated by I8 (only the authenticated+API-callback+stale intersection changes behavior, which today is a guaranteed 404/loop, i.e. strictly broken).

## User operation scenarios

1. **WebAuthn user, MCP connect, stale session**: authorize → signin → panel → passkey tap → back to authorize → consent → Allow → CLI/Claude Code token. Session kept.
2. **Google/SAML user, MCP connect, stale session**: authorize → signin → panel → "sign in again" → signOut → real sign-in → authorize → consent → Allow. Old session revoked.
3. **Consent-form stale mid-flight** (user sat on consent page >15 min): Allow POST → 303 to authorize → funnels into 1/2.
4. **iOS OAuth**: same as 1/2 inside ASWebAuthenticationSession.
5. **Fresh session** (≤15 min): authorize → consent directly; signin never involved. Unchanged.
6. **Ordinary sign-in / non-API callback**: unchanged (I8).
7. **Empty-basePath deployment**: L1 no-op; L2/L3 fix the live loop.

## Go/No-Go Gate

| ID  | Subject                                                             | Status |
|-----|---------------------------------------------------------------------|--------|
| C1  | signin API-callback strips basePath before nextRedirect (L1)        | locked |
| C2  | 3 browser-redirect OAuth gates use requireRecentCurrentAuthMethod   | locked |
| C3  | signin reauth panel + shared freshness core (L3)                    | locked |
| C4  | regression tests (basePath, chooser, freshness, panel)              | locked |
