# Plan Review: expand-security-policies
Date: 2026-04-09
Review round: 3

## Changes from Previous Round

### Round 1 → Round 2 (11 Major resolved)
- F-01: AUDIT_ACTION group → specified concrete group (ADMIN) + AUDIT_ACTION_VALUES + TENANT_WEBHOOK_EVENT_GROUPS
- F-02: getPolicyViolations → removal from password-generator.tsx + shared PasswordPolicy type
- F-03: updateSession → createdAt + withBypassRls(AUTH_FLOW) + 60s cache
- F-04: purge-history → split into subtask 10a (PasswordEntryHistory) + 10b (new AuditLog purge)
- F-07: TENANT_WEBHOOK_EVENT_GROUPS → merged into F-01
- S-01: Lockout cross-field → server-side Zod .refine() with specific conditions
- S-02: Open redirect → hard-coded path + API endpoint (no query param)
- T-01: FULL_POLICY_RESPONSE → explicit 14+ field update
- T-02: account-lockout mock → vi.hoisted + default mock + custom threshold tests
- T-03: team-policy constants → 3 new fields with specific defaults
- T-04: test strategy → pure function unit tests (not React render)

### Round 2 → Round 3 (Critical 1 + Major 4 resolved)
- F-08/F-05 [Critical]: Edge Runtime → hasPasskey in session info via /api/auth/session
- F-09: Watchtower → client-side in use-watchtower.ts
- F-10: userId → added to updateSession select
- S-07: WebAuthn exclusion → /api/webauthn/register/*, /api/webauthn/authenticate/*, /api/auth/*
- S-08: Grace period → requirePasskeyEnabledAt field added
- N-01: account-lockout migration → vi.hoisted mock pattern
- N-02: team-policy mapping → getTeamPolicy return block + test constants

### Round 3 fixes applied
- Func N-01: Wrong model name → corrected to WebAuthnCredential + withBypassRls
- Func N-02: SessionInfo type → extended interface, setSessionCache, next-auth.d.ts
- Func N-03: requirePasskeyEnabledAt set-once → PATCH handler false→true transition logic
- Sec S-10: hasPasskey cache staleness → documented as accepted limitation (30s, self-only)
- Sec S-11: X-Passkey-Grace-Remaining header → removed, use API endpoint only
- Sec S-12: Duration non-decreasing → strict ascending
- Test N-05: Mock key name → specified {attempts, lockMinutes} matching existing constants
- Test N-06: withBypassRls mock → vi.mock("@/lib/tenant-rls") in team-policy.test.ts
- Test N-07: Mapped policy test → assertions for 3 new fields

## Functionality Findings
All Round 1-3 findings resolved.

## Security Findings
All Round 1-3 findings resolved. Open minors (S-03 rate limiting, S-04 retention bypass) accepted.

## Testing Findings
All Round 1-3 findings resolved.

## Adjacent Findings
None.

## Quality Warnings
None.
