# Code Review: webauthn-magic-link-signin
Date: 2026-03-06T12:00:00+09:00
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### F1 (Critical): Race condition in auto-unlock useEffect
- **File**: src/components/vault/vault-lock-screen.tsx
- **Problem**: sessionStorage flag is consumed (removeItem) before hasPrfPasskeys query resolves. If the query is slow, the flag is gone and auto-unlock never triggers.
- **Recommended fix**: Move flag consumption inside the `if (hasPrfPasskeys)` branch, or use a ref to track consumption.

### F2 (High): last_used_device VarChar(100) overflow
- **File**: src/lib/webauthn-authorize.ts
- **Problem**: Uses credentialId as `last_used_device` value, but base64url credential IDs can exceed 100 chars (VarChar(100) column).
- **Recommended fix**: Set to `null` instead of credentialId. Device info captured elsewhere.

### F3 (High): base64urlToUint8Array duplicated
- **File**: src/lib/webauthn-authorize.ts
- **Problem**: Contains a copy of base64urlToUint8Array instead of importing from webauthn-server.ts where it's already exported.
- **Recommended fix**: Import from `@/lib/webauthn-server`.

### F4 (Medium): Non-discoverable credential warning heuristic
- **File**: src/components/settings/passkey-credentials-card.tsx
- **Problem**: `deviceType === "singleDevice" && !backedUp` is an imprecise proxy for non-discoverable. Some platform authenticators are single-device but still discoverable.
- **Recommended fix**: Add code comment acknowledging the limitation.

### F5 (Medium): EMAIL_PROVIDER reads process.env directly
- **File**: src/lib/env.ts
- **Problem**: EMAIL_PROVIDER is not validated via Zod schema; uses raw process.env.
- **Recommended fix**: Add to envSchema with z.string().optional().

### F7 (Low): Plan-required tests not implemented
- **Problem**: Plan specified tests for all new modules but none were created.
- **Recommended fix**: Create test files for all new modules.

### F8 (Low): Email sign-in shows success even on access denied
- **File**: src/components/auth/email-signin-form.tsx
- **Problem**: signIn("nodemailer") returns success even if Auth.js signIn callback returns false (email is still "sent" by design to avoid user enumeration).
- **Recommended fix**: This is intentional behavior for security (no user enumeration). Add code comment.

## Security Findings

### S1-S7 (from plan review): All confirmed resolved/addressed

### NEW-S1 (High): Magic Link rate limiting not implemented
- **Problem**: Plan required IP 5/min + email 3/10min rate limiting for magic link, but not implemented.
- **Recommended fix**: Add rate limiting to Nodemailer sendVerificationRequest or signIn callback.

### NEW-S2 (Medium): Race condition same as F1
- **File**: src/components/vault/vault-lock-screen.tsx
- **Problem**: Same as functionality F1.

### NEW-S3 (Low): SSO tenant guard bypassed for null email
- **File**: src/auth.ts signIn callback
- **Problem**: Guard checks `if (params.user?.email)` — users with null email bypass the check entirely.
- **Recommended fix**: Also block null-email users for nodemailer/webauthn providers (they shouldn't exist).

### NEW-S4 (Low): challengeId not format-validated
- **File**: src/lib/webauthn-authorize.ts
- **Problem**: challengeId used directly in Redis key without format validation.
- **Recommended fix**: Validate challengeId format (UUID or hex) before Redis lookup.

## Testing Findings

### T1: Coverage exclusion too broad
- **File**: vitest.config.ts
- **Problem**: `src/app/api/auth/**` excludes the new passkey options route from coverage.
- **Recommended fix**: Narrow to `src/app/api/auth/[...nextauth]/**`.

### T2: No proxy test for passkey options route
- **Problem**: New unauthenticated route not tested in proxy tests.

### T3: No test for PRF salt optional change
- **File**: src/lib/webauthn-client.ts
- **Problem**: Making prfSalt optional is untested.

### T4: No env test for EMAIL_PROVIDER-only config
- **File**: src/lib/env.ts

### T5: No tests for authorizeWebAuthn
- **File**: src/lib/webauthn-authorize.ts

### T6: No tests for email templates
- **Files**: src/lib/email/templates/magic-link.ts, passkey-registered.ts

### T7: Race condition in auto-unlock not tested
- **File**: src/components/vault/vault-lock-screen.tsx

### T8: SSO tenant guard in signIn callback not tested
- **File**: src/auth.ts

## Resolution Status
(To be updated after fixes)
