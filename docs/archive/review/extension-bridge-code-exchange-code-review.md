# Code Review: extension-bridge-code-exchange

Date: 2026-04-11
Branch: `feature/extension-bridge-code-exchange`
Base commit reviewed: `f5abcd43`

## Round 1

Three sub-agents (functionality, security, testing) reviewed the implementation in parallel against the plan, deviation log, and full source files.

### Findings Summary

| Severity | Functionality | Security | Testing |
|---|---|---|---|
| Critical | 0 | 0 | 0 |
| Major | 2 | 0 | 0 |
| Minor | 1 | 1 | 4 |

### Functionality Findings

#### F-1 — Major: `issueExtensionToken` doc comment is backwards

- **File**: `src/lib/extension-token.ts:137`
- **Problem**: The doc comment said "The caller MUST already be inside a `withUserTenantRls` (or equivalent RLS) context for the user." This is wrong — the function establishes its own `withUserTenantRls` context internally.
- **Fix**: Replaced with "Sets up its own `withUserTenantRls` + `prisma.$transaction` internally. Callers do NOT need to establish an RLS context before calling."

#### F-2 — Major: `EXTENSION_TOKEN_EXCHANGE_FAILURE` audit gap (revised after re-analysis)

- **File**: `src/app/api/extension/token/exchange/route.ts`
- **Original finding (revised)**: The reviewer claimed the `!consumed` invariant violation path had `consumed.userId` in scope. **This was incorrect**: `consumed` is null in that branch.
- **Real gap**: `issueExtensionToken()` can throw between `consumed` being fetched and the success audit emission. That code path DOES have `consumed.userId` and `consumed.tenantId` available, but the original code had no try/catch — a thrown error would propagate to Next.js's default 500 handler with no audit trail.
- **Fix**:
  - Added `EXTENSION_TOKEN_EXCHANGE_FAILURE` to the AuditAction enum (`prisma/schema.prisma`, migration SQL)
  - Added the constant to `AUDIT_ACTION`, `AUDIT_ACTION_VALUES`, `AUDIT_ACTION_GROUPS_PERSONAL[AUTH]`
  - Added i18n keys to `messages/en/AuditLog.json` and `messages/ja/AuditLog.json`
  - Wrapped the `issueExtensionToken()` call in try/catch in the exchange route; on catch, emit `logAudit({ action: EXTENSION_TOKEN_EXCHANGE_FAILURE, userId: consumed.userId, tenantId: consumed.tenantId, metadata: { reason: "issue_failed" } })` and return 500
  - Added a regression test in `exchange/route.test.ts` that mocks `$transaction` to throw and asserts the audit emission
  - Re-ran `npx prisma generate` to refresh client types
- **Rationale for keeping `!consumed` as pino-only**: That branch genuinely has no resolvable user. The "should be impossible" comment is accurate; if it ever fires, the pino error log + the missing audit row would itself be a forensic signal.

#### F-3 — Minor: `extractClientIp` called twice in bridge-code route

- **File**: `src/app/api/extension/bridge-code/route.ts`
- **Problem**: The DB record creation called `extractClientIp(req)` once; the audit emission then called `extractRequestMeta(req)` which internally calls `extractClientIp(req)` again.
- **Fix**: Call `extractRequestMeta(req)` once before the `withBypassRls` block and reuse `meta.ip` / `meta.userAgent` for both the DB record and the audit. Removed the standalone `extractClientIp` import.

### Security Findings

#### F-1-S — Minor: `codeHash` not in pino redact list

- **File**: `src/lib/logger.ts:21-39`
- **Problem**: The pino logger's `redact.paths` includes `tokenHash` but not `codeHash`. The invariant violation log in `exchange/route.ts` emits `{ codeHash }` unredacted. SHA-256 is non-reversible so practical impact is low, but inconsistent with the `tokenHash` convention.
- **Fix**: Added `"codeHash"` to the `redact.paths` array in `src/lib/logger.ts`.

### Testing Findings

#### M1 — Minor: exchange test cases 2/3/4 are duplicates (skipped — intentional)

- **File**: `src/app/api/extension/token/exchange/route.test.ts`
- **Note**: Cases for "code already used", "code expired", "hash mismatch" all use `mockResolvedValueOnce({ count: 0 })` and exercise the same production code path. The reviewer suggested consolidating to 1 test.
- **Decision**: Kept as-is. The three cases document distinct conceptual scenarios from the security review (P1-C2). Future readers benefit from seeing each case enumerated. No code change.

#### M2 — Minor: proxy test title mismatch

- **File**: `src/__tests__/proxy.test.ts`
- **Problem**: The test titled "returns 401 for /api/extension/bridge-code without session" actually sent a Cookie (i.e., a session existed but was invalid). The test also did not assert that `fetchSpy` was called, so a regression that put bridge-code in the bypass list would not be caught.
- **Fix**: Renamed the test to "requires session for /api/extension/bridge-code (extension prefix is session-required)" and added `expect(fetchSpy).toHaveBeenCalled()` to verify the session check actually ran.

#### M3 — Minor: `userRecord === null` path uncovered in bridge-code test

- **File**: `src/app/api/extension/bridge-code/route.test.ts`
- **Problem**: The branch `if (!userRecord) return unauthorized()` (deleted user case) had no test.
- **Fix**: Added a new test case "returns 401 when the user record cannot be resolved (deleted user)" that mocks `mockUserFindUnique.mockResolvedValueOnce(null)` and asserts 401 + that `extensionBridgeCode.create` was NOT called.

#### M4 — Minor: `vitest.config.ts` `coverage.include` missing entries

- **File**: `vitest.config.ts`
- **Problem**: `src/lib/extension-token.ts` and `src/lib/inject-extension-bridge-code.ts` were not in the coverage include list, so the new helper and the rewritten inject function wouldn't be reflected in coverage metrics.
- **Fix**: Added both files to `coverage.include`.

## Resolution Status (Round 1)

| Finding | Severity | Resolution |
|---|---|---|
| F-1 (Func) | Major | Doc comment fixed in `extension-token.ts` |
| F-2 (Func) | Major | Added `EXTENSION_TOKEN_EXCHANGE_FAILURE` enum + try/catch around `issueExtensionToken` + audit emit + test |
| F-3 (Func) | Minor | `extractRequestMeta` called once and reused |
| F-1-S (Sec) | Minor | `codeHash` added to logger redact list |
| M1 (Test) | — | Skipped (intentional documentation of distinct conceptual cases) |
| M2 (Test) | Minor | proxy test title fixed + `fetchSpy` assertion added |
| M3 (Test) | Minor | null user case added |
| M4 (Test) | Minor | `vitest.config.ts` `coverage.include` extended |

## Verification

| Check | Result |
|---|---|
| Lint | ✅ clean |
| Vitest (web app) | ✅ 553 files / 6917 tests (+2 new from F-2 / M3) |
| Vitest (extension) | ✅ 42 files / 658 tests |
| `npx next build` | ✅ success |
