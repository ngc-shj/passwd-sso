# Plan: rebalance-personal-passkey-session-aal2

## Project context
- Type: `web app`
- Test infrastructure: `unit + integration + E2E`
- Branch name: `refactor/rebalance-personal-passkey-session-aal2`

## Objective
Personal-use passkey sign-in currently creates a web session that is always treated as AAL3-equivalent, forcing a `15 min` inactivity timeout and `12 h` overall timeout. Rebalance that behavior so ordinary personal passkey sessions behave as AAL2-level web sessions, while preserving stronger assurance for sensitive actions through explicit fresh-passkey step-up.

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
- Tests must cover timeout resolution, fresh-passkey enforcement, and no-regression behavior for existing step-up consumers.

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
6. Keep the current unauthenticated passkey sign-in flow for bootstrap users, but change its session creation semantics so it creates an ordinary personal web session plus initial fresh-passkey metadata.
7. Roll out fresh-passkey enforcement only to explicitly enumerated sensitive personal surfaces in this change; leave unrelated tenant-admin step-up flows on their current `requireRecentSession` semantics unless the implementation intentionally migrates them.

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

### C2. Fresh-passkey assurance is explicit session metadata
- Subject: Session schema and helper contract for passkey freshness
- Function/module signatures:
  - `model Session { passkeyVerifiedAt DateTime? @map("passkey_verified_at") @db.Timestamptz(3) }`
  - `requireFreshPasskey(req: NextRequest, options?: { maxAgeMs?: number; errorCode?: ApiErrorCode }): Promise<NextResponse | null>`
  - `markCurrentSessionPasskeyVerified(sessionToken: string, verifiedAt: Date): Promise<void>`
- Invariants:
  - Fresh-passkey eligibility must be tied to the current session row, not to global user state.
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
  - `POST /api/auth/passkey/reauth/options -> { challengeId: string; publicKey: PublicKeyCredentialRequestOptionsJSON }`
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
  - Consumer `passkey reauth client helper` (new shared client module or existing passkey sign-in button helper) reads `{ challengeId, publicKey }` from `reauth/options`, passes `publicKey` into the WebAuthn browser ceremony, then sends `{ credentialResponse, challengeId }` to `reauth/verify`; on success it reads `{ verifiedAt }` only to confirm freshness was updated before retrying the blocked action.
  - Consumer `server-side freshness guard` (path: new helper in `src/lib/auth/session`) reads `passkeyVerifiedAt` from the current session row and compares it with `maxAgeMs` to decide whether to allow the action or return `SESSION_STEP_UP_REQUIRED`.

### C4. Sensitive-surface rollout is explicit and limited
- Subject: Initial enforcement scope for fresh-passkey requirement
- Function/module signatures:
  - `requireFreshPasskey(req: NextRequest, options?: { maxAgeMs?: number; errorCode?: ApiErrorCode }): Promise<NextResponse | null>`
  - Existing route handlers keep their current signatures.
- Invariants:
  - Only routes explicitly listed in this plan may switch from generic recent-session checks to fresh-passkey checks in this change.
  - A route may adopt fresh-passkey only if its caller has an in-product passkey reauth path; otherwise it must stay on existing `requireRecentSession` semantics in this change.
  - Tenant-admin and SSO-oriented step-up flows not listed below must keep current behavior.
  - Any client-visible retry loop must remain idempotent across a failed protected action followed by successful reauth and retry.
- Forbidden patterns:
  - `pattern: requireFreshPasskey\\(` outside the enumerated route list — reason: rollout scope must stay auditable.
  - `pattern: SESSION_STEP_UP_REQUIRED.*AUTHENTICATION_FAILED` — reason: step-up and sign-in failure paths must remain distinct.
- Acceptance criteria:
  - The plan enumerates the exact routes/components migrated in this change.
  - Every migrated route has a corresponding passkey-capable caller or documented exclusion path.
  - Non-migrated routes continue using their existing step-up guard.
  - Retry behavior after successful reauth is documented for each migrated consumer.
- Consumer-flow walkthrough:
  - Consumer `extension token issuance` (path: `src/app/api/extension/token/route.ts`) reads the current session and uses the fresh-passkey helper before issuing a long-lived machine credential; if stale, the caller must receive `SESSION_STEP_UP_REQUIRED` and no token is minted.
  - Consumer `developer operator token UI` (path: `src/components/settings/developer/operator-token-card.tsx`) reads a `403` step-up error from `src/app/api/tenant/operator-tokens/route.ts`, launches passkey reauth, and retries the create-token mutation only after `reauth/verify` succeeds.
  - Consumer `API key UI` (path: route caller to `src/app/api/api-keys/route.ts`) must be migrated only if the current UI surface can launch the same passkey reauth helper; otherwise the route stays on `requireRecentSession` in this change.
  - Consumer `MCP / service-account issuance routes` (paths: `src/app/api/mcp/authorize/route.ts`, `src/app/api/mcp/authorize/consent/route.ts`, `src/app/api/tenant/service-accounts/[id]/tokens/route.ts`) remain on existing generic step-up unless this change also lands a passkey-capable retry path for their concrete callers.

## Go/No-Go Gate
| ID | Subject | Status |
|----|---------|--------|
| C1 | Personal passkey web sessions resolve as ordinary web sessions | locked |
| C2 | Fresh-passkey assurance is explicit session metadata | locked |
| C3 | Authenticated passkey reauth flow has a dedicated contract | locked |
| C4 | Sensitive-surface rollout is explicit and limited | locked |

## Testing strategy
- Unit tests:
  - `resolveEffectiveSessionTimeouts` returns tenant/team policy values for bootstrap passkey sessions and does not reintroduce hidden AAL3 clamp.
  - `requireFreshPasskey` accepts fresh sessions, rejects stale ones, and leaves `requireRecentSession` behavior unchanged.
  - Passkey reauth route validation rejects wrong body shape, wrong user binding, stale/missing session, and reused challenge.
- Integration / DB tests:
  - Session row stores and updates `passkeyVerifiedAt` correctly for sign-in and reauth.
  - Sensitive routes migrated in this change reject stale freshness and succeed after reauth without rotating unrelated sessions.
  - Session cache invalidation and audit logging still behave correctly around reauth.
- E2E tests:
  - Personal bootstrap user signs in with passkey, stays signed in longer than 15 minutes of configured policy-equivalent usage, and can complete a protected action after an in-flow passkey step-up.
  - Non-migrated step-up consumers preserve current UX and do not regress.
- If the current browser automation harness cannot drive real WebAuthn ceremonies, the plan must provide:
  - integration coverage for route-level passkey reauth semantics, and
  - a targeted manual-test script for the end-to-end browser ceremony and retry UX.

## Considerations & constraints
- This plan intentionally treats ordinary personal passkey web sessions as AAL2-style sessions. It does not attempt to preserve blanket AAL3 semantics for the entire browsing session.
- Existing docs that state `provider === "webauthn"` implies AAL3 clamp must be updated in the same change.
- The reauth flow must not reuse PRF rebootstrap challenge keys or semantics.
- If a migrated consumer lacks a client-side retry path today, the implementation must either add one or keep that consumer out of scope for this change.
- Before Phase 2 starts, the implementation owner must confirm which current UI surfaces can actually invoke passkey reauth without introducing a dead-end `SESSION_STEP_UP_REQUIRED` loop for users who are not in the bootstrap personal flow.
- Out of scope:
  - Changing tenant/team session policy UI defaults
  - Reworking SSO tenant passkey policy enforcement
  - Changing extension local-unlock behavior

## User operation scenarios
1. Personal user signs in with passkey on the bootstrap sign-in page, browses the vault for longer than 15 minutes with ordinary activity, and remains signed in according to the normal personal session policy.
2. The same user tries to mint an extension token after the fresh-passkey window has elapsed and is prompted for passkey reauth in-flow rather than being fully logged out.
3. The user completes passkey reauth successfully and retries the sensitive action without losing other active sessions or browser state.
4. A stale or replayed reauth challenge is rejected and the sensitive action remains blocked.
5. An SSO-backed tenant user who does not use the bootstrap personal sign-in flow sees no unintended change in ordinary session handling from this refactor.

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
- Route handlers explicitly migrated under C4
- Corresponding unit, integration, and E2E tests for the files above

## Implementation Checklist
- Files and locations to modify
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
    - keep `requireRecentSession`.
    - add `requireFreshPasskey` and current-session freshness update helper.
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
    - new route/helper tests for reauth options + verify + fresh-passkey guard
    - integration test around session freshness persistence if existing DB harness fits
- Shared utilities that must be reused
  - `src/app/api/sessions/helpers.ts:getSessionToken` — canonical current-session cookie lookup.
  - `src/lib/http/api-response.ts:errorResponse|unauthorized|rateLimited` — consistent route error shapes.
  - `src/lib/security/rate-limit.ts:createRateLimiter` — rate limiting for reauth endpoints.
  - `src/lib/auth/session/csrf.ts:assertOrigin` — origin validation for passkey mutation endpoints.
  - `src/lib/auth/webauthn/webauthn-client.ts:startPasskeyAuthentication` — browser ceremony; do not create a parallel client implementation.
  - `src/lib/auth/webauthn/webauthn-server.ts` helpers — challenge/verification primitives and RP handling.
  - `src/lib/http/with-request-log.ts:withRequestLog` — route wrapper consistency.
- Patterns that must be followed consistently
  - Dedicated challenge namespaces per flow: `signin`, `prf-rebootstrap`, and new `reauth` must stay separate.
  - Passkey freshness is session-scoped state, not user-global state.
  - Reauth must update only the current session row and must not revoke all sessions or extension-token families.
  - `SESSION_STEP_UP_REQUIRED` contract remains the generic retry signal for client callers.
  - Route rollout for `requireFreshPasskey` is deferred unless a concrete passkey-capable caller path exists in the same change.
- Duplicate implementation check
  - Existing browser passkey ceremony already lives in `src/lib/auth/webauthn/webauthn-client.ts`; no second helper may be introduced in component code.
  - Existing recent-session guard already lives in `src/lib/auth/session/step-up.ts`; fresh-passkey logic must extend that module instead of adding route-local DB checks.
- CI parity notes
  - CI extractor reports these gates: `check-state-mutation-centralization`, `refactor-phase-verify`, `check:bypass-rls`, `check:crypto-domains`, `check:env-docs`, `check:migration-drift`, `check:team-auth-rls`, `licenses:check:*`, `lint`.
  - `scripts/pre-pr.sh` already runs most local gates plus additional project-specific static checks and tests/build.
  - Remaining manual parity task before completion: inspect the multi-line `run:` workflow blocks flagged by `extract-ci-checks.sh` (`.github/workflows/ci-integration.yml`, `.github/workflows/ci.yml`, `.github/workflows/refactor-phase-verify.yml`, `.github/workflows/release.yml`) and confirm no extra CI-only auth/session gate was missed.
