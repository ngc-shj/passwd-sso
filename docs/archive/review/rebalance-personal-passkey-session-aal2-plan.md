# Plan: rebalance-personal-passkey-session-aal2

## Project context
- Type: `web app`
- Test infrastructure: `unit + integration + E2E`
- Branch name: `feature/rebalance-personal-passkey-session-aal2`

## Objective
Personal-use passkey sign-in currently creates a web session that is always treated as AAL3-equivalent, forcing a `15 min` inactivity timeout and `12 h` overall timeout. Rebalance that behavior so ordinary personal passkey sessions behave as AAL2-level web sessions, while preserving stronger assurance for sensitive actions through explicit recent-passkey-verification step-up.

## Requirements
### Functional requirements
- Personal-use passkey sign-in sessions must no longer be shortened solely because `Session.provider === "webauthn"`.
- Bootstrap-tenant users who sign in with passkey must receive the same effective web-session envelope as other AAL2 web sessions, subject to existing tenant/team policy ceilings.
- Sensitive personal actions must still be able to require a recent passkey ceremony without forcing a full sign-out or revoking every prior session.
- Existing non-personal auth flows must keep their current behavior unless explicitly listed in this plan.
- Existing `SESSION_STEP_UP_REQUIRED` handling must remain compatible with current consumers.

### Non-functional requirements
- Session assurance rules must be explicit in code and docs; no hidden policy coupling to a provider string.
- The change must not weaken CSRF, rate-limiting, audit logging, or session cache invalidation guarantees.
- The change must remain compatible with current NextAuth database-session behavior and current WebAuthn challenge namespaces.
- Tests must cover timeout resolution, recent-passkey-verification enforcement, and no-regression behavior for existing step-up consumers.

## Technical approach
1. Separate two concepts that are currently conflated:
   - ordinary web-session lifetime
   - fresh high-assurance proof of user presence via passkey
2. Stop using `Session.provider === "webauthn"` as the sole signal for global AAL3-style session clamping in personal-use sessions.
3. Introduce explicit freshness metadata on the session row for passkey step-up, so a successful passkey reauthentication can extend sensitive-operation eligibility without rotating the whole session family.
4. Keep the existing session idle/absolute policy resolver as the authoritative source for ordinary web sessions. Personal passkey sessions should resolve to tenant/team policy values, with any AAL3-specific logic moved behind an explicit freshness check rather than a blanket session clamp.
5. Add an authenticated passkey reauth flow that:
   - issues a dedicated challenge namespace separate from sign-in and PRF rebootstrap
   - verifies a passkey assertion against the current signed-in user
   - updates session freshness metadata atomically for the current session only
   - does not revoke unrelated sessions or extension tokens
6. Keep the current unauthenticated passkey sign-in flow for bootstrap users, but change its session creation semantics so it creates an ordinary personal web session plus initial recent-passkey-verification metadata.
7. Roll out recent-passkey-verification enforcement only to explicitly enumerated sensitive personal surfaces in this change; leave unrelated tenant-admin step-up flows on their current `requireRecentSession` semantics unless the implementation intentionally migrates them.

## Contracts

### C1. Personal passkey web sessions resolve as ordinary web sessions
- Subject: Session timeout resolution for personal passkey sign-in
- Function/module signatures:
  - `resolveEffectiveSessionTimeouts(userId: string, sessionProvider: string | null): Promise<ResolvedSessionTimeouts>`
  - `resolveSessionAssuranceContext(userId: string, sessionProvider: string | null): Promise<{ tenantId: string; isBootstrapTenant: boolean; isPasskeySession: boolean }>`
  - `type ResolvedSessionTimeouts = { idleMinutes: number; absoluteMinutes: number; tenantId: string }`
- Invariants:
  - Only bootstrap-tenant personal passkey sign-in sessions are reclassified by this change; all other existing session classes keep current timeout semantics unless explicitly migrated in a later plan.
  - Personal bootstrap-tenant web sessions must not receive a `15 min / 12 h` clamp solely because they were established through the passkey sign-in route.
  - Existing tenant/team strictest-wins semantics remain unchanged.
  - Session expiry continues to be derived from the same resolver for `createSession` and `updateSession`.
  - Session cache invalidation behavior remains unchanged.
- Forbidden patterns:
  - `pattern: sessionProvider === "webauthn"` — reason: provider string alone must not globally force AAL3-style lifetime for ordinary personal web sessions.
  - `pattern: PASSKEY_SESSION_MAX_AGE_SECONDS` — reason: passkey session lifetime must not bypass the shared tenant/team resolver with a hidden hardcoded cap.
- Acceptance criteria:
  - A bootstrap-tenant passkey sign-in session resolves to the same idle/absolute envelope as other ordinary web sessions, subject to tenant/team policy.
  - The implementation makes the bootstrap-only scope explicit rather than inferring it from `provider` alone.
  - Existing non-passkey session behavior is unchanged.
  - `src/auth.ts` and the custom auth adapter continue to use one authoritative policy source for ordinary web-session expiry.

### C2. Recent-passkey-verification assurance is explicit session metadata
- Subject: Session schema and helper contract for passkey freshness
- Function/module signatures:
  - `model Session { passkeyVerifiedAt DateTime? @map("passkey_verified_at") @db.Timestamptz(3) }`
  - `requireRecentPasskeyVerification(req: NextRequest, options?: { maxAgeMs?: number; errorCode?: ApiErrorCode }): Promise<NextResponse | null>`
  - `markCurrentSessionPasskeyVerified(sessionToken: string, verifiedAt: Date): Promise<void>`
- Invariants:
  - Recent-passkey-verification eligibility must be tied to the current session row, not to global user state.
  - A successful passkey reauth updates only the current session's freshness metadata.
  - Ordinary session activity updates `lastActiveAt` but must not implicitly refresh `passkeyVerifiedAt`.
  - `requireRecentSession` remains available for existing non-passkey consumers until explicitly migrated.
- Forbidden patterns:
  - `pattern: createdAt = new Date\\(` — reason: step-up freshness must not be simulated by mutating session creation time.
  - `pattern: deleteMany\\(\\{\\s*where:\\s*\\{\\s*userId` — reason: passkey step-up must not revoke all user sessions as part of freshness refresh.
- Acceptance criteria:
  - The schema stores explicit passkey freshness per session.
  - Helper code can reject stale sensitive actions based on `passkeyVerifiedAt` without affecting ordinary idle timeout behavior.
  - Existing `SESSION_STEP_UP_REQUIRED` response mapping stays valid for clients that only understand the current error code.

### C3. Authenticated passkey reauth flow has a dedicated contract
- Subject: Dedicated passkey reauth API and verification flow
- Function/module signatures:
  - `POST /api/auth/passkey/reauth/options -> { challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }`
  - `POST /api/auth/passkey/reauth/verify -> { ok: true; verifiedAt: string } | { error: string }`
  - `authorizeWebAuthn(input: { credentialResponse: string; challengeId: string; expectedUserId?: string }): Promise<AuthorizedWebAuthnUser | null>`
- Invariants:
  - Reauth challenges must use a namespace distinct from sign-in and PRF rebootstrap.
  - The verification route must require an already-authenticated session and must bind the passkey assertion to the current user.
  - Reauth success must emit audit logs appropriate for a security-sensitive reauthentication event.
  - Reauth must be rate-limited and CSRF-protected using the same standards as the existing passkey verify flow where applicable.
- Forbidden patterns:
  - `pattern: "webauthn:challenge:signin:"` — reason: reauth cannot reuse sign-in challenge keys.
  - `pattern: revokeAllExtensionTokensForUser` — reason: step-up reauth is not equivalent to full passkey sign-in.
  - `pattern: SESSION_COOKIE_NAME` — reason: reauth must update current-session freshness, not mint a new session cookie.
- Acceptance criteria:
  - The API returns a dedicated challenge for the signed-in user and records a fresh verification time on success.
  - Reauth verification cannot be replayed across users or across challenge namespaces.
  - Current session token, audit behavior, and rate limiting remain coherent with the existing auth architecture.
- Consumer-flow walkthrough:
  - Consumer `personal sensitive action gate` (path: `src/components/settings/developer/operator-token-card.tsx` and other existing step-up callers migrated in this change) reads `{ error }` from a protected action response and, when the error is `SESSION_STEP_UP_REQUIRED`, invokes the reauth flow before retrying the original mutation.
  - Consumer `passkey reauth client helper` (new shared client module or existing passkey sign-in button helper) reads `{ challengeId, options }` from `reauth/options`, passes `options` into the WebAuthn browser ceremony, then sends `{ credentialResponse, challengeId }` to `reauth/verify`; on success it reads `{ verifiedAt }` only to confirm freshness was updated before retrying the blocked action.
  - Consumer `server-side freshness guard` (path: new helper in `src/lib/auth/session`) reads `passkeyVerifiedAt` from the current session row and compares it with `maxAgeMs` to decide whether to allow the action or return `SESSION_STEP_UP_REQUIRED`.

### C4. Sensitive-surface rollout is explicit and limited
- Subject: Initial enforcement scope and caller matrix for recent-passkey-verification
- Function/module signatures:
  - `requireRecentPasskeyVerification(req: NextRequest, options?: { maxAgeMs?: number; errorCode?: ApiErrorCode }): Promise<NextResponse | null>`
  - Existing route handlers keep their current signatures.
- Invariants:
  - Every step-up-protected route must be classified by caller type before Phase 2 starts: `web-ui-inline-reauth`, `web-ui-browser-redirect`, or `non-passkey-capable`.
  - Every step-up-protected route must also be classified by auth class before Phase 2 starts: `personal-passkey-only`, `session-mixed`, `sso-mixed`, or `non-interactive`.
  - Only routes explicitly listed in this plan may switch from generic recent-session checks to recent-passkey-verification checks in this change.
  - A route may adopt recent-passkey-verification only if its caller has a concrete recovery path for `SESSION_STEP_UP_REQUIRED`; otherwise it must stay on existing `requireRecentSession` semantics in this change.
  - A route may adopt recent-passkey-verification only if its auth class is explicitly passkey-capable. `sso-mixed` routes must not switch to a passkey-only guard until an SSO/IdP step-up contract exists.
  - Tenant-admin and SSO-oriented step-up flows not listed below must keep current behavior.
  - Any client-visible retry loop must remain idempotent across a failed protected action followed by successful reauth and retry.
  - Extension, mobile, MCP, and other bridge-style callers must not surface `SESSION_STEP_UP_REQUIRED` as a generic network/connection error.
- Forbidden patterns:
  - `pattern: requireRecentPasskeyVerification\\(` outside the enumerated route list — reason: rollout scope must stay auditable.
  - `pattern: requireRecentPasskeyVerification\\(` on an `sso-mixed` route without an explicit IdP-reauth contract — reason: passkey-only step-up cannot be the only recovery mechanism for mixed SSO endpoints.
  - `pattern: SESSION_STEP_UP_REQUIRED.*AUTHENTICATION_FAILED` — reason: step-up and sign-in failure paths must remain distinct.
  - `pattern: connectFailed|networkError` in a `SESSION_STEP_UP_REQUIRED` branch — reason: step-up must be presented as recoverable reauthentication, not transport failure.
- Acceptance criteria:
  - The plan enumerates the exact routes/components migrated in this change.
  - Every migrated route has a corresponding passkey-capable caller and passkey-capable auth class, or a documented exclusion path.
  - Non-migrated routes continue using their existing step-up guard.
  - Retry behavior after successful reauth is documented for each migrated consumer.
  - The plan explicitly identifies which routes remain blocked on future SSO/IdP step-up design.
- Recovery UX contract:
  - `web-ui-inline-reauth`
    - Meaning: the caller can launch the passkey ceremony without leaving the current screen.
    - Required UX: show an explicit reauthentication prompt, call `reauth/options` -> browser WebAuthn ceremony -> `reauth/verify`, then retry the blocked mutation automatically or with one clear confirm action.
    - Forbidden UX: generic `networkError`, silent failure, or forcing the user to rediscover the original screen.
  - `web-ui-browser-redirect`
    - Meaning: the caller runs in a browser-controlled bridge or OAuth-style flow and cannot safely embed the passkey ceremony inline.
    - Required UX: show `browser reauthentication required`, explain that the current session is still signed in but not fresh enough for the requested action, provide a clear next action, and retry only after the browser flow has re-established freshness.
    - Forbidden UX: generic connect/auth failure copy that implies bad passphrase, bad transport, or total sign-out.
  - `non-passkey-capable`
    - Meaning: the caller has no reliable way to perform passkey reauth in the current channel.
    - Required UX: remain on `requireRecentSession` in this round, and if it returns `SESSION_STEP_UP_REQUIRED`, direct the user to a browser flow that can recover instead of trying to inline passkey logic in the caller.
    - Forbidden UX: adopting `requireRecentPasskeyVerification` before a concrete recovery channel exists.
- Auth-class contract:
  - `personal-passkey-only`
    - Meaning: the route is reachable only from the bootstrap/personal flow where the app itself can require a passkey ceremony.
    - Allowed guard: `requireRecentPasskeyVerification` once the caller recovery UX exists.
  - `session-mixed`
    - Meaning: the route accepts ordinary browser sessions from multiple auth methods, including non-passkey sessions.
    - Allowed guard in this plan: `requireRecentSession` by default; may migrate only after the route has a negotiated fallback for non-passkey sessions.
  - `sso-mixed`
    - Meaning: the route is used by SSO-backed users for whom the app cannot assume a local passkey exists.
    - Allowed guard in this plan: `requireRecentSession` only.
    - Future prerequisite: define `IdP reauth` or equivalent SSO step-up before any migration.
  - `non-interactive`
    - Meaning: the caller cannot present a browser passkey ceremony or IdP prompt in-band.
    - Allowed guard in this plan: `requireRecentSession` only.
- Route / caller matrix:
  - `src/app/api/tenant/operator-tokens/route.ts`
    - Caller: `src/components/settings/developer/operator-token-card.tsx`
    - Auth class: `personal-passkey-only`
    - Current UX: caller now launches passkey reauth and retries inline.
    - Classification: `web-ui-inline-reauth`
    - Phase-2 decision: migrated to `requireRecentPasskeyVerification`.
  - `src/app/api/extension/bridge-code/route.ts`
    - Caller: `src/components/extension/auto-extension-connect.tsx`
    - Auth class: `personal-passkey-only`
    - Current UX: caller now launches passkey reauth in the browser surface and retries bridge-code issuance.
    - Classification: `web-ui-browser-redirect`
    - Phase-2 decision: migrated to `requireRecentPasskeyVerification`.
  - `src/app/api/extension/token/route.ts`
    - Caller: browser extension background/popup, plus legacy direct issuance path.
    - Auth class: `non-interactive`
    - Current UX: no inline passkey ceremony; failures can collapse into unlock/connect errors.
    - Classification: `non-passkey-capable`
    - Phase-2 decision: stay on `requireRecentSession`.
  - `src/app/api/api-keys/route.ts`
    - Caller: `src/components/settings/developer/api-key-manager.tsx`
    - Auth class: `session-mixed`
    - Current UX: handles validation/limit errors only; no special `SESSION_STEP_UP_REQUIRED` branch.
    - Classification: `web-ui-inline-reauth`
    - Phase-2 decision: stay on `requireRecentSession` in this change; requires auth-class split or non-passkey recovery before any migration.
  - `src/app/api/tenant/service-accounts/[id]/tokens/route.ts`
    - Caller: `src/components/settings/developer/service-account-card.tsx`
    - Auth class: `sso-mixed`
    - Current UX: handles validation/conflict errors only; no special `SESSION_STEP_UP_REQUIRED` branch.
    - Classification: `web-ui-inline-reauth`
    - Phase-2 decision: stay on `requireRecentSession`; blocked on future IdP/SSO step-up design.
  - `src/app/api/tenant/scim-tokens/route.ts`
    - Caller: `src/components/team/security/team-scim-token-manager.tsx`
    - Auth class: `sso-mixed`
    - Current UX: generic network-error toast on non-OK response.
    - Classification: `web-ui-inline-reauth`
    - Phase-2 decision: stay on `requireRecentSession`; blocked on future IdP/SSO step-up design.
  - `src/app/api/tenant/mcp-clients/route.ts`
    - Caller: `src/components/settings/developer/mcp-client-card.tsx`
    - Auth class: `sso-mixed`
    - Current UX: handles conflict/limit errors only; no special `SESSION_STEP_UP_REQUIRED` branch.
    - Classification: `web-ui-inline-reauth`
    - Phase-2 decision: stay on `requireRecentSession`; blocked on future IdP/SSO step-up design.
  - `src/app/api/tenant/access-requests/[id]/approve/route.ts`
    - Caller: `src/components/settings/developer/access-request-card.tsx`
    - Auth class: `sso-mixed`
    - Current UX: approval flow handles domain-specific conflicts only; no special `SESSION_STEP_UP_REQUIRED` branch.
    - Classification: `web-ui-inline-reauth`
    - Phase-2 decision: stay on `requireRecentSession`; blocked on future IdP/SSO step-up design.
  - `src/app/api/mcp/authorize/route.ts` and `src/app/api/mcp/authorize/consent/route.ts`
    - Caller: browser OAuth-style MCP authorize flow (`src/app/[locale]/mcp/authorize/page.tsx`, `src/app/[locale]/mcp/authorize/consent-form.tsx`)
    - Auth class: `sso-mixed`
    - Current UX: no dedicated passkey reauth retry contract.
    - Classification: `web-ui-browser-redirect`
    - Phase-2 decision: stay on `requireRecentSession`; blocked on future IdP/SSO step-up design.
  - `src/app/api/mobile/authorize/route.ts`
    - Caller: iOS `ASWebAuthenticationSession` bridge flow
    - Auth class: `sso-mixed`
    - Current UX: browser redirect handshake only; no inline passkey reauth contract in the host app.
    - Classification: `web-ui-browser-redirect`
    - Phase-2 decision: stay on `requireRecentSession`; blocked on future IdP/SSO step-up design.
- Phase-2 rollout subset for this change:
  - `src/app/api/tenant/operator-tokens/route.ts` may migrate to `requireRecentPasskeyVerification` only together with inline passkey reauth UX in `src/components/settings/developer/operator-token-card.tsx`.
  - `src/app/api/extension/bridge-code/route.ts` may migrate to `requireRecentPasskeyVerification` only together with browser-surface passkey reauth retry UX in `src/components/extension/auto-extension-connect.tsx`.
  - All `session-mixed`, `sso-mixed`, and `non-interactive` routes stay on `requireRecentSession` in this change.
- Consumer-flow walkthrough:
  - Consumer `developer operator token UI` reads a `403 OPERATOR_TOKEN_STALE_SESSION` from `src/app/api/tenant/operator-tokens/route.ts`, launches passkey reauth inline, and retries the create-token mutation only after `reauth/verify` succeeds.
  - Consumer `extension connect UI` reads a `403 SESSION_STEP_UP_REQUIRED` from `src/app/api/extension/bridge-code/route.ts`, launches passkey reauth in the browser surface, and retries bridge-code issuance only after `reauth/verify` succeeds.
  - Consumer `API key / service-account / SCIM / MCP client / access-request UIs` remain on generic recent-session semantics in this round because the route auth class is not yet guaranteed passkey-capable.

## Go/No-Go Gate
| ID | Subject | Status |
|----|---------|--------|
| C1 | Personal passkey web sessions resolve as ordinary web sessions | locked |
| C2 | Recent-passkey-verification assurance is explicit session metadata | locked |
| C3 | Authenticated passkey reauth flow has a dedicated contract | locked |
| C4 | Sensitive-surface rollout is explicit and limited | locked |

## Testing strategy
- Unit tests:
  - `resolveEffectiveSessionTimeouts` returns tenant/team policy values for bootstrap passkey sessions and does not reintroduce hidden AAL3 clamp.
  - `requireRecentPasskeyVerification` accepts fresh sessions, rejects stale ones, and leaves `requireRecentSession` behavior unchanged.
  - Passkey reauth route validation rejects wrong body shape, wrong user binding, stale/missing session, and reused challenge.
- Integration / DB tests:
  - Session row stores and updates `passkeyVerifiedAt` correctly for sign-in and reauth.
  - Sensitive routes migrated in this change reject stale freshness and succeed after reauth without rotating unrelated sessions.
  - Session cache invalidation and audit logging still behave correctly around reauth.
- E2E tests:
  - Personal bootstrap user signs in with passkey, stays signed in longer than 15 minutes of configured policy-equivalent usage, and can complete a protected action after an in-flow passkey step-up.
  - Non-migrated step-up consumers preserve current UX and do not regress.
  - Extension connect path must prove that `SESSION_STEP_UP_REQUIRED` from `bridge-code` is surfaced as reauthentication guidance, not as generic connection failure.
  - Inline browser-management UIs must prove that a stale protected action can recover through passkey reauth without losing form state or forcing a full page restart.
  - Browser-redirect flows must prove that `SESSION_STEP_UP_REQUIRED` copy does not mention passphrase mismatch, transport failure, or sign-out unless one of those conditions is actually true.
- If the current browser automation harness cannot drive real WebAuthn ceremonies, the plan must provide:
  - integration coverage for route-level passkey reauth semantics, and
  - a targeted manual-test script for the end-to-end browser ceremony and retry UX.

## Considerations & constraints
- This plan intentionally treats ordinary personal passkey web sessions as AAL2-style sessions. It does not attempt to preserve blanket AAL3 semantics for the entire browsing session.
- Existing docs that state `provider === "webauthn"` implies AAL3 clamp must be updated in the same change.
- The reauth flow must not reuse PRF rebootstrap challenge keys or semantics.
- If a migrated consumer lacks a client-side retry path today, the implementation must either add one or keep that consumer out of scope for this change.
- Before Phase 2 starts, the implementation owner must confirm which current UI surfaces can actually invoke passkey reauth without introducing a dead-end `SESSION_STEP_UP_REQUIRED` loop for users who are not in the bootstrap personal flow.
- Before any extension/mobile/MCP caller is migrated away from `requireRecentSession`, the implementation must define where reauthentication happens, how success is communicated back, and what exact user-facing copy replaces today's generic failure states.
- Out of scope:
  - Changing tenant/team session policy UI defaults
  - Reworking SSO tenant passkey policy enforcement
  - Changing extension local-unlock behavior

## User operation scenarios
1. Personal user signs in with passkey on the bootstrap sign-in page, browses the vault for longer than 15 minutes with ordinary activity, and remains signed in according to the normal personal session policy.
2. The same user tries to mint an operator token after the recent-passkey-verification window has elapsed, completes passkey reauth inline, and retries without being fully logged out.
3. A user coming from the extension sees `browser reauthentication required` when `POST /api/extension/bridge-code` returns `SESSION_STEP_UP_REQUIRED`, rather than a generic connection failure.
4. A stale or replayed reauth challenge is rejected and the sensitive action remains blocked.
5. API key, service-account token, SCIM token, MCP client, MCP consent, mobile authorize, and extension token flows remain on current recent-session semantics until each caller has a concrete recovery path.
6. An SSO-backed tenant user who does not use the bootstrap personal sign-in flow sees no unintended change in ordinary session handling from this refactor.

## Files expected to change
- `docs/security/session-timeout-design.md`
- `prisma/schema.prisma`
- `prisma/migrations/<new migration>/migration.sql`
- `src/app/api/auth/passkey/verify/route.ts`
- `src/app/api/auth/passkey/options/route.ts` or shared passkey challenge helper extracted from it
- `src/app/api/auth/passkey/reauth/options/route.ts`
- `src/app/api/auth/passkey/reauth/verify/route.ts`
- `src/lib/auth/session/session-timeout.ts`
- `src/lib/auth/session/step-up.ts`
- `src/lib/auth/webauthn/webauthn-authorize.ts`
- `src/lib/constants/auth/api-path.ts`
- `src/components/settings/developer/operator-token-card.tsx`
- `src/components/extension/auto-extension-connect.tsx`
- Route handlers explicitly migrated under C4
- Corresponding unit, integration, and E2E tests for the files above

## Implementation Checklist
- Files and locations to modify
  - `src/app/api/tenant/operator-tokens/route.ts`
    - replace `requireRecentSession(...OPERATOR_TOKEN_STALE_SESSION)` with `requireRecentPasskeyVerification(...OPERATOR_TOKEN_STALE_SESSION)` only when the same change also lands inline reauth recovery in the caller.
  - `src/components/settings/developer/operator-token-card.tsx`
    - add inline passkey reauth + retry handling for `OPERATOR_TOKEN_STALE_SESSION`.
  - `src/components/extension/auto-extension-connect.tsx`
    - distinguish `SESSION_STEP_UP_REQUIRED` from generic connect failure and present browser reauthentication guidance.
  - `prisma/schema.prisma`
    - `Session` model: add `passkeyVerifiedAt` nullable timestamp.
  - `prisma/migrations/<new migration>/migration.sql`
    - additive migration for `sessions.passkey_verified_at`.
  - `src/lib/auth/session/session-timeout.ts`
    - remove blanket provider-based AAL3 clamp from ordinary personal passkey session resolution.
  - `src/app/api/auth/passkey/verify/route.ts`
    - replace hidden `PASSKEY_SESSION_MAX_AGE_SECONDS` expiry with resolver-derived expiry.
    - initialize `passkeyVerifiedAt` on newly-created passkey session rows.
  - `src/lib/auth/session/step-up.ts`
    - keep `requireRecentSession` only.
  - `src/lib/auth/webauthn/recent-passkey-verification.ts`
    - add `requireRecentPasskeyVerification` and current-session freshness update helper.
  - `src/lib/auth/webauthn/webauthn-authorize.ts`
    - extend challenge verification to support authenticated reauth namespace and optional expected-user binding.
  - `src/app/api/auth/passkey/reauth/options/route.ts`
    - authenticated options endpoint with dedicated challenge namespace.
  - `src/app/api/auth/passkey/reauth/verify/route.ts`
    - authenticated verify endpoint that marks current session fresh without rotating session family.
  - `src/lib/constants/auth/api-path.ts`
    - add path constants/builders for reauth endpoints.
  - `src/lib/auth/webauthn/webauthn-client.ts`
    - reuse existing authentication ceremony helper; no duplicate browser-ceremony implementation.
  - `src/components/auth/passkey-signin-button.tsx`
    - no behavior change expected; verify shared helper compatibility only.
  - Tests
    - `src/lib/auth/session/session-timeout.test.ts`
    - `src/app/api/auth/passkey/verify/route.test.ts`
    - new route/helper tests for reauth options + verify + recent-passkey-verification guard
    - integration test around session freshness persistence if existing DB harness fits
- Shared utilities that must be reused
  - `src/app/api/sessions/helpers.ts:getSessionToken` — canonical current-session cookie lookup.
  - `src/lib/http/api-response.ts:errorResponse|unauthorized|rateLimited` — consistent route error shapes.
  - `src/lib/security/rate-limit.ts:createRateLimiter` — rate limiting for reauth endpoints.
  - `src/lib/auth/session/csrf.ts:assertOrigin` — origin validation for passkey mutation endpoints.
  - `src/lib/auth/webauthn/webauthn-client.ts:startPasskeyAuthentication` — browser ceremony; do not create a parallel client implementation.
  - `src/lib/auth/webauthn/webauthn-server.ts` helpers — challenge/verification primitives and RP handling.
  - `src/lib/http/with-request-log.ts:withRequestLog` — route wrapper consistency.
  - `src/lib/constants/auth/api-path.ts:API_PATH|apiPath` — reuse existing route builders for reauth endpoints and caller fetches.
  - `src/lib/url-helpers.ts:fetchApi` — reuse existing browser fetch helper rather than bespoke retry code in UI callers.
  - `src/lib/http/api-error-codes.ts:API_ERROR` — reuse existing error-code constants for UI branching.
  - `src/lib/constants/time.ts:MS_PER_MINUTE` — reuse shared time constants; do not introduce duplicate minute literals.
  - `src/lib/security/rate-limit.ts:createRateLimiter` — already used by all affected auth routes; keep parity with existing step-up-protected issuance routes.
- Patterns that must be followed consistently
  - Dedicated challenge namespaces per flow: `signin`, `prf-rebootstrap`, and new `reauth` must stay separate.
  - Passkey freshness is session-scoped state, not user-global state.
  - Reauth must update only the current session row and must not revoke all sessions or extension-token families.
  - `SESSION_STEP_UP_REQUIRED` contract remains the generic retry signal for client callers.
  - Route rollout for `requireRecentPasskeyVerification` is deferred unless a concrete passkey-capable caller path exists in the same change.
  - UI callers must preserve user input/form state across reauth recovery; retry should resume the blocked mutation rather than resetting the screen.
  - Redirect/bridge callers must map `SESSION_STEP_UP_REQUIRED` to reauthentication guidance, not `networkError` / `connectFailed`.
- Duplicate implementation check
  - Existing browser passkey ceremony already lives in `src/lib/auth/webauthn/webauthn-client.ts`; no second helper may be introduced in component code.
  - Existing recent-session guard already lives in `src/lib/auth/session/step-up.ts`; recent-passkey-verification logic stays as a separate passkey-specific route guard helper rather than route-local DB checks.
  - Existing extension-connect flow already lives in `src/components/extension/auto-extension-connect.tsx` + `src/lib/inject-extension-bridge-code.ts`; do not add a parallel bridge-code bootstrap path.
  - Existing operator-token stale-session UI branch already exists in `src/components/settings/developer/operator-token-card.tsx`; extend it into recovery rather than introducing a second token-creation flow.
- CI parity notes
  - CI extractor reports these gates: `check-state-mutation-centralization`, `refactor-phase-verify`, `check:bypass-rls`, `check:crypto-domains`, `check:env-docs`, `check:migration-drift`, `check:team-auth-rls`, `licenses:check:*`, `lint`.
  - `scripts/pre-pr.sh` already runs most local gates plus additional project-specific static checks and tests/build, but the extracted CI gate list includes `check-state-mutation-centralization`, which is not present in the current local pre-PR extraction and must be run manually during Phase 2 completion.
  - Remaining manual parity task before completion: inspect the multi-line `run:` workflow blocks flagged by `extract-ci-checks.sh` (`.github/workflows/ci-integration.yml`, `.github/workflows/ci.yml`, `.github/workflows/refactor-phase-verify.yml`, `.github/workflows/release.yml`) and confirm no extra CI-only auth/session gate was missed.
