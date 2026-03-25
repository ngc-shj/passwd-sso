# Coding Deviation Log: p4-security-hardening
Created: 2026-03-26T00:00:00+09:00

## Deviations from Plan

### D1: Passkey verify — tenantId guard strengthened
- **Plan description**: Use `existingUser!.tenantId` (non-null assertion) for session creation
- **Actual implementation**: Added early return when `existingUser` is null or has no `tenantId`, ensuring the guard rejects users without a tenant rather than crashing
- **Reason**: Prisma `Session.tenantId` is a required field; passing undefined would cause a runtime error
- **Impact scope**: `src/app/api/auth/passkey/verify/route.ts` — test cases updated to expect 401 for null user/tenantId

### D2: Passkey verify — adapter.createSession replaced entirely
- **Plan description**: Plan described using `adapter.createSession()` within a transaction
- **Actual implementation**: Replaced `adapter.createSession()` with direct `prisma.$transaction()` containing `session.deleteMany` + `session.create`, bypassing the auth-adapter entirely
- **Reason**: The auth-adapter's `createSession()` has its own Serializable transaction for `maxConcurrentSessions` enforcement. Nesting transactions or calling adapter inside our transaction would be complex and redundant. Direct prisma call is simpler and correct.
- **Impact scope**: `src/app/api/auth/passkey/verify/route.ts`, `route.test.ts` — removed `createCustomAdapter` and `sessionMetaStorage` imports

### D3: Existing lint warning fixed
- **Plan description**: Not in plan
- **Actual implementation**: Fixed `request` → `_request` in `vault/rotate-key/data/route.ts` to resolve pre-existing lint warning
- **Reason**: CLAUDE.md mandates lint-clean builds; this was the only remaining warning
- **Impact scope**: `src/app/api/vault/rotate-key/data/route.ts`

---
