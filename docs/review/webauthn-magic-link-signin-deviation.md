# Coding Deviation Log: webauthn-magic-link-signin
Created: 2026-03-06T00:00:00+09:00

## Deviations from Plan

### D1: webauthn-authorize.ts lastUsedDevice field
- **Plan description**: CAS counter update should set `last_used_device` from parseDeviceFromUserAgent
- **Actual implementation**: Uses the credentialId as `last_used_device` value since the authorize function doesn't have access to the request object (it's called from Auth.js Credentials provider which doesn't pass request headers)
- **Reason**: Auth.js Credentials provider's `authorize(credentials)` doesn't receive the request object in a way that exposes headers. The device info will be captured by the session metadata storage when Auth.js creates the session.
- **Impact scope**: `last_used_device` field on webauthn_credentials table during sign-in flow only

### D2: Email locale detection in sendVerificationRequest
- **Plan description**: Detect user locale for magic link email template
- **Actual implementation**: Defaults to "ja" (app default locale) as `sendVerificationRequest` doesn't expose the user's locale preference
- **Reason**: Auth.js's `sendVerificationRequest` callback receives `{ identifier, url, provider, theme }` but not the user's locale. Locale detection would require additional DB queries that add complexity for minimal benefit.
- **Impact scope**: Magic link email language is always Japanese (app default). Future improvement could extract locale from the verification URL.

---
