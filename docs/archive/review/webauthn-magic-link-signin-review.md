# Plan Review: sleepy-puzzling-walrus

Date: 2026-03-06T00:00:00+09:00
Review round: 1

## Changes from Previous Round

Initial review

## Pre-screening Findings (Local LLM)

14 findings identified. Key issues:

1. Rate-limit for Magic Link endpoints
2. Verification token handling (Auth.js manages hashing/expiry)
3. Open-redirect prevention (Auth.js callbackUrl validation)
4. Cross-tenant credential lookup with withBypassRls
5. Challenge binding to IP/UA
6. Discoverable credential enumeration surface
7. CSRF on passkey endpoints
8. Session cookie security flags
9. PRF data in sessionStorage (XSS vector)
10. Missing audit logging for failures
11. Account linking/duplication (SSO vs Magic Link)
12. Email verification before passkey registration
13. TLS/production enforcement
14. Testing gaps (happy paths only)

## Functionality Findings

### F1: Session creation bypasses Auth.js signIn callback (CRITICAL)

- **Problem**: Custom session helper bypasses `ensureTenantMembershipForSignIn()`, allowing deactivated tenant members to authenticate
- **Impact**: Security bypass for tenant membership enforcement
- **Action taken**: Redesigned Phase 2 to use Auth.js Credentials provider, eliminating custom session creation

### F2: Session creation bypasses sessionMetaStorage (IMPORTANT)

- **Problem**: IP/UA not captured, new-device detection not triggered
- **Impact**: Incomplete session metadata, missing security notifications
- **Action taken**: Resolved by Credentials provider adoption (Auth.js adapter handles this)

### F3: residentKey "preferred" may produce non-discoverable credentials (IMPORTANT)

- **Problem**: Non-discoverable credentials won't appear in browser's passkey selection during sign-in
- **Impact**: User registers passkey for sign-in but it silently fails
- **Action taken**: Added warning UI in settings for non-discoverable credentials (Phase 2-8)

### F4: Email provider allows SSO tenant users to bypass SSO (CRITICAL)

- **Problem**: Auth.js finds existing SSO user by email, creates Magic Link session into SSO-enforced tenant
- **Impact**: Bypasses SSO policy for enterprise users
- **Action taken**: Added signIn callback guard to reject nodemailer/webauthn for non-bootstrap tenants (Phase 1-4, 2-2)

### F5: webauthn_credentials RLS policy doesn't support bypass (BLOCKING)

- **Problem**: RLS policy uses `app.current_tenant_id` instead of `app.tenant_id`, and lacks bypass clause
- **Impact**: WebAuthn sign-in feature will fail silently (credential lookup returns null)
- **Action taken**: Added RLS migration fix (Phase 2-7)

### F6: Double WebAuthn prompt for non-PRF credentials (UX)

- **Problem**: Auto-unlock triggers second WebAuthn prompt that achieves nothing for non-PRF users
- **Impact**: Confusing UX, unnecessary biometric prompt
- **Action taken**: Added PRF credential existence check before auto-unlock trigger (Phase 3-2)

## Security Findings

### S1: Custom session creation bypasses Auth.js lifecycle (CRITICAL)

- Overlaps with F1/F2. Resolved by Credentials provider adoption.

### S2: WebAuthn user enumeration via timing (LOW)

- **Problem**: Time difference between "credential not found" and "verification failed" is measurable
- **Impact**: Confirms credential existence (low severity, IDs are random)
- **Action taken**: Added dummy verification for timing equalization (Phase 2-1 step 6)

### S3: Session token entropy and format divergence (IMPORTANT)

- **Problem**: crypto.randomUUID() may not match Auth.js token format
- **Impact**: Proxy's hasValidSession() could reject custom tokens
- **Action taken**: Resolved by Credentials provider adoption

### S4: Missing Origin assertion on unauthenticated endpoints (IMPORTANT)

- **Problem**: No assertOrigin() on session-less POST endpoints
- **Impact**: Cross-origin challenge generation / session creation
- **Action taken**: Added assertOrigin() to passkey options endpoint (Phase 2-3)

### S5: Magic Link token not bound to requesting client (LOW, Known Limitation)

- **Problem**: Magic link usable from any device if email is compromised
- **Impact**: Session hijack via email compromise
- **Action taken**: Documented as known limitation. Mitigated by new-device detection notifications.

### S6: PRF salt derivation uses only userId (LOW)

- **Problem**: Deterministic per-userId salt enables cross-credential correlation
- **Impact**: Low - requires unknown server secret to exploit
- **Action taken**: Documented for future improvement (credentialId inclusion)

### S7: Account takeover via Magic Link + passkey registration chain (IMPORTANT)

- **Problem**: Attacker with email access registers passkey as permanent backdoor
- **Impact**: Passkey survives email password rotation
- **Action taken**: Added passkey registration notification email (Phase 3-3)

## Testing Findings

### T1: auth-session-helper.ts duplicates without shared test coverage (RESOLVED)

- Resolved by Credentials provider adoption (no helper needed)

### T2: Coverage config excludes src/app/api/auth/** (IMPORTANT)

- **Problem**: New passkey routes won't appear in coverage reports
- **Impact**: Untested security-critical code goes undetected
- **Action taken**: Narrowing exclude pattern to `[...nextauth]/**` only (Phase 4-3)

### T3: Proxy route protection implicit allow-through (IMPORTANT)

- **Problem**: No test verifies passkey routes pass through without session
- **Impact**: Implementer could accidentally break unauthenticated flow
- **Action taken**: Added proxy route test cases (Phase 4-3)

### T4: withBypassRls credential lookup lacks test isolation (IMPORTANT)

- **Problem**: Mock Prisma doesn't model RLS bypass behavior
- **Impact**: Unit tests won't catch RLS policy failures
- **Action taken**: RLS policy fix in Phase 2-7 + manual DB verification in testing plan

### T5: No test for startPasskeyAuthentication() PRF salt optional change (IMPORTANT)

- **Problem**: Client-side module has zero test coverage
- **Impact**: Runtime errors on passkey sign-in button click
- **Action taken**: Added webauthn-client.test.ts (Phase 4-3)

### T6: EMAIL_PROVIDER missing from env validation tests (IMPORTANT)

- **Problem**: env.test.ts doesn't test Email-only provider configuration
- **Impact**: Regression could break Email-only deployments
- **Action taken**: Added env test cases (Phase 1-5)
