# Coding Deviation Log: webauthn-l3-minpin-largeblob
Created: 2026-03-16

## Deviations from Plan

### DEV-1: Extensions object cast to `as any`
- **Plan description**: Add extensions individually
- **Actual implementation**: Cast entire `extensions` object to `any` because `@simplewebauthn/server` v9 types do not include `minPinLength` or `largeBlob.support`
- **Reason**: TypeScript build fails without cast; upstream types incomplete for WebAuthn L3
- **Impact scope**: `src/lib/webauthn-server.ts` only

### DEV-2: User query restructured into separate withUserTenantRls call
- **Plan description**: Expand existing user.findUnique select
- **Actual implementation**: Split into two withUserTenantRls calls — first for user info + policy check, second for credential create
- **Reason**: Policy check must return HTTP 400 before credential creation; cannot return NextResponse from inside the create callback
- **Impact scope**: `src/app/api/webauthn/register/verify/route.ts`

No other deviations.
