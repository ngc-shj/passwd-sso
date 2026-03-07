# Plan: fix-audit-log-consistency

## Objective

Standardize audit log output fields across all `logAudit()` call sites to ensure consistency in `targetType`, `targetId`, `metadata`, `ip`/`userAgent`, and constant usage.

## Requirements

### Functional
1. Replace string literals (`"PERSONAL"`, `"RECOVERY_PASSPHRASE_RESET"`, etc.) with `AUDIT_SCOPE.*` / `AUDIT_ACTION.*` constants
2. Add missing `ip`/`userAgent` via `extractRequestMeta(req)` where `req` is available
3. Remove duplicate `ip` from metadata when already present as top-level field
4. Add `USER` to `AUDIT_TARGET_TYPE` and replace `"User"` string literals
5. Unify `EMERGENCY_ACCESS_ACTIVATE` metadata to always include `ownerId`, `granteeId`, and `earlyApproval`
6. Verify SCIM_USER_UPDATE metadata differences are legitimate (PUT=full replace, PATCH=partial)
7. Add `provider` to `AUTH_LOGIN` metadata for login source traceability

### Non-functional
- No runtime behavior changes beyond additional/corrected metadata fields
- No new dependencies
- All existing tests must continue to pass

## Technical Approach

- Direct edits to existing route handlers and `auth.ts`
- Add `USER` constant to `src/lib/constants/audit-target.ts`
- Add `AUDIT_SCOPE`, `AUDIT_ACTION`, `AUDIT_TARGET_TYPE` imports where missing
- Use `extractRequestMeta(req)` spread pattern for ip/userAgent
- Add `{ provider }` to AUTH_LOGIN metadata in both auth.ts (signIn event) and passkey verify route

## Implementation Steps

1. **vault/recovery-key/recover/route.ts**: Import constants, replace `"PERSONAL"` → `AUDIT_SCOPE.PERSONAL`, `"RECOVERY_PASSPHRASE_RESET"` → `AUDIT_ACTION.RECOVERY_PASSPHRASE_RESET`
2. **vault/recovery-key/generate/route.ts**: Import constants, replace string literals for scope and action
3. **vault/reset/route.ts**: Import constants, replace `"PERSONAL"` and `"VAULT_RESET_EXECUTED"` with constants
4. **auth/passkey/verify/route.ts**: Import `extractRequestMeta`, add `...extractRequestMeta(req)` and `metadata: { provider: "passkey" }`
5. **admin/rotate-master-key/route.ts**: Remove `ip` from metadata object (already in top-level), use `...extractRequestMeta(req)` to also capture `userAgent`
6. **constants/audit-target.ts**: Add `USER: "User"` entry
7. **vault/admin-reset/route.ts**: Import `AUDIT_TARGET_TYPE`, replace `"User"` → `AUDIT_TARGET_TYPE.USER`
8. **tenant/members/[userId]/reset-vault/route.ts**: Same as above
9. **tenant/members/[userId]/reset-vault/[resetId]/revoke/route.ts**: Same as above
10. **emergency-access/[id]/approve/route.ts**: Add `ownerId` to metadata
11. **emergency-access/[id]/vault/route.ts**: Add `granteeId` and `earlyApproval: false` to metadata
12. **auth.ts**: Destructure `account` in signIn event, add `metadata: { provider: account?.provider ?? "unknown" }`

## Testing Strategy

- Run `npm run build` to verify no TypeScript compilation errors
- Run existing test suite to ensure no regressions
- Verify no new `"User"` or `"PERSONAL"` string literal usage in audit log calls via grep

## Considerations & Constraints

- Auth.js v5 `signIn` event does not provide `req` object, so `ip`/`userAgent` cannot be added there (known limitation, not addressed)
- System events (`WEBHOOK_DELIVERY_FAILED`, `DIRECTORY_SYNC_STALE_RESET`) intentionally lack `ip`/`userAgent` as there is no HTTP request context
- SCIM PUT vs PATCH metadata difference is legitimate and not changed
