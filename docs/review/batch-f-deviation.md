# Coding Deviation Record: batch-f

Created: 2026-03-05T13:15:00+09:00

## Deviations from Plan

### DEV-1: Rate limiter return type changed from boolean to RateLimitResult
- **Plan**: Did not explicitly mention changing `check()` return type
- **Actual**: Changed `check()` from returning `Promise<boolean>` to `Promise<{ allowed: boolean; retryAfterMs?: number }>` for Retry-After header support in `/api/v1/*` rate limiting
- **Reason**: The plan specified `checkRateLimit()` returning `{ allowed: boolean; retryAfterMs?: number }` for API key rate limiting; implemented at the core `createRateLimiter` level instead of wrapping
- **Impact**: Required updating 29+ test files to use `{ allowed: true/false }` mock return values and fixing `tenant/members/[userId]/reset-vault/route.ts` which used raw result instead of `.allowed`

### DEV-2: AUDIT_ACTION_GROUP values use camelCase instead of snake_case
- **Plan**: Used `"group:api_keys"`, `"group:travel_mode"`, `"group:directory_sync"`
- **Actual**: Used `"group:apiKeys"`, `"group:travelMode"`, `"group:directorySync"`
- **Reason**: Existing test `audit-log-keys.test.ts` converts group values to i18n keys by capitalizing first character after colon. With snake_case, `"group:travel_mode"` → `"groupTravel_mode"` which doesn't match the JSON key `"groupTravelMode"`. CamelCase ensures consistent conversion.
- **Impact**: None beyond naming convention — i18n keys and test pass correctly

### DEV-3: Travel Mode disable route uses logAudit() without await
- **Plan**: Did not specify sync/async behavior for logAudit
- **Actual**: `logAudit()` is synchronous (returns void), so called without `await`
- **Reason**: Existing codebase pattern — `logAudit()` is fire-and-forget
- **Impact**: None

### DEV-4: Travel Mode routes omit tenantId from logAudit
- **Plan**: Did not explicitly address tenantId availability in Travel Mode audit logs
- **Actual**: Auth.js `session.user` does not include `tenantId`; `tenantId` is optional in `logAudit()`
- **Reason**: Consistent with existing patterns in other route handlers using `auth()`
- **Impact**: None — tenantId is enriched from DB in audit log queries

### DEV-5: travel-mode-card.tsx uses computePassphraseVerifier from crypto-client
- **Plan**: Referenced `computeVerifierHash` from vault context
- **Actual**: Used `computePassphraseVerifier(passphrase, accountSalt)` from `@/lib/crypto-client` + `getAccountSalt()` from vault context
- **Reason**: `computeVerifierHash` doesn't exist in vault context; `computePassphraseVerifier` is the existing function that implements the verifier hash computation
- **Impact**: None — functionally equivalent

### DEV-6: SSH_KEY form mock added to personal-entry-dialogs.test.tsx
- **Plan**: Did not mention test file updates for new entry type
- **Actual**: Added `vi.mock("@/components/passwords/personal-ssh-key-form")` to prevent module import errors
- **Reason**: Test file imports dialog components that now import SSH_KEY form
- **Impact**: None — test correctly ignores SSH_KEY form rendering details

### DEV-7: UI components for WebAuthn and Directory Sync not implemented
- **Plan**: Specified `passkey-credentials-card.tsx`, `passkey-register-dialog.tsx`, `directory-sync-card.tsx`, `directory-sync-dialog.tsx`, `directory-sync-log-sheet.tsx`, vault-lock-screen passkey button
- **Actual**: Only API routes, server libraries, and i18n files were created; UI components deferred
- **Reason**: Subagent scope focused on backend infrastructure; frontend components require additional context about vault-context integration patterns
- **Impact**: WebAuthn and Directory Sync APIs are functional but lack UI — can be added in follow-up

### DEV-8: CLI travel-mode command not implemented
- **Plan**: Specified `cli/src/commands/travel-mode.ts`
- **Actual**: Not created in this batch
- **Reason**: CLI scope focused on env/run/api-key/agent commands; travel-mode CLI is lower priority
- **Impact**: Travel Mode manageable via web UI only

### DEV-9: WebAuthn counter update uses raw SQL instead of Prisma $transaction
- **Plan**: Specified `$transaction` with CAS check
- **Actual**: Used `$executeRaw` with CAS WHERE clause (atomic single-statement update)
- **Reason**: Single raw SQL statement with WHERE counter = old_value achieves the same atomicity guarantee without the overhead of a multi-statement transaction
- **Impact**: None — functionally equivalent, simpler implementation

### DEV-10: parseOtpauthUri deduplicated from totp-field.tsx
- **Plan**: Function existed in both `qr-scanner-client.ts` and `totp-field.tsx`
- **Actual**: Removed duplicate from `totp-field.tsx`, now imports from `@/lib/qr-scanner-client`
- **Reason**: Code review found the duplicate lacked algorithm validation fix
- **Impact**: None — same behavior, single source of truth
