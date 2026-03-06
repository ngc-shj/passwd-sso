# Coding Deviation Log: webauthn-magic-link-signin
Created: 2026-03-06T00:00:00+09:00

## Deviations from Plan

### D1: webauthn-authorize.ts lastUsedDevice field
- **Plan description**: CAS counter update should set `last_used_device` from parseDeviceFromUserAgent
- **Actual implementation**: Sets `last_used_device` to NULL in the CAS update. Device info is captured by session metadata when the session is created.
- **Reason**: The authorize function doesn't have access to the request object. Setting NULL avoids VarChar(100) overflow risk from long credentialId values.
- **Impact scope**: `last_used_device` field on webauthn_credentials table during sign-in flow only
- **Review resolution**: F2 (Round 1) — set to NULL instead of credentialId

### D2: Email locale detection in sendVerificationRequest
- **Plan description**: Detect user locale for magic link email template
- **Actual implementation**: Extracts locale from the callbackUrl query parameter inside the magic link URL.
- **Reason**: Auth.js's `sendVerificationRequest` callback doesn't directly expose the user's locale, but the callbackUrl contains the locale prefix (e.g., `/ja/dashboard`).
- **Impact scope**: Magic link emails now respect the user's locale
- **Review resolution**: F11 (Round 3) — locale extracted from callbackUrl

### D3: Auth.js Credentials provider replaced with custom verify route
- **Plan description**: Use Auth.js Credentials provider for WebAuthn passkey sign-in
- **Actual implementation**: Custom `/api/auth/passkey/verify` route that creates database sessions directly via `adapter.createSession()`
- **Reason**: Auth.js Credentials provider ALWAYS creates JWT sessions internally, even when `strategy: "database"` is configured. Verified in `@auth/core/lib/actions/callback/index.js:227-282`.
- **Impact scope**: Sign-in flow architecture — passkey sign-in bypasses Auth.js entirely
- **Review resolution**: F9 (Round 2)

---
