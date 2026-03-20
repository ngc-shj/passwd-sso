# Plan Review: add-key-rotation-consumers
Date: 2026-03-20
Review round: 4 (final)

## Changes from Previous Round
Initial review

## Functionality Findings

### F1 [Critical] ECDH private key re-encryption missing
- **Problem**: vault `rotateKey` flow does not re-encrypt the ECDH private key. When secretKey changes, `deriveEcdhWrappingKey(secretKey)` produces a different wrapping key, making the existing encrypted ECDH private key unrecoverable.
- **Impact**: After rotation, team E2E encryption (join, key distribution, vault decrypt) breaks for the user.
- **Recommended action**: Add ECDH private key re-encryption to both client flow and API schema (`encryptedEcdhPrivateKey`, `ecdhPrivateKeyIv`, `ecdhPrivateKeyAuthTag`).

### F2 [Major] Team entries bulk fetch API lacks includeTrash support
- **Problem**: `GET /api/teams/[teamId]/passwords` doesn't support `includeTrash=true`. Current options are `trashOnly=true` or default (active+archived). Team rotate-key requires ALL entries (active+archived+trash) or the server rejects with `ENTRY_COUNT_MISMATCH`.
- **Impact**: Team rotate-key UI cannot work with current API.
- **Recommended action**: Add `GET /api/teams/[teamId]/rotate-key/data` bulk fetch endpoint (symmetric with vault).

### F3 [Major] historyEntries ID field ambiguity
- **Problem**: Plan's `historyEntries[].id` doesn't clarify whether it refers to `PasswordEntryHistory.id` or `PasswordEntryHistory.entryId`.
- **Impact**: Implementation error could cause wrong records to be updated.
- **Recommended action**: Clarify that `id` = `PasswordEntryHistory.id` (the history record's own ID).

### F4 [Major] Sequential to interactive transaction migration not explicit
- **Problem**: Current vault rotate-key uses sequential `prisma.$transaction([...])`. Advisory lock requires interactive transaction `prisma.$transaction(async (tx) => {...})`. This migration is not called out in implementation steps.
- **Impact**: Implementer may attempt advisory lock in wrong transaction mode.
- **Recommended action**: Add explicit step: "Convert existing sequential transaction to interactive transaction format" with advisory lock at transaction start.
- **Note**: Merged with Security Finding #3 (advisory lock implementation details).

### F5 [Minor] Missing vault unlock guard in rotateKey
- **Problem**: `rotateKey` function lacks early guard for `secretKeyRef.current === null` (vault locked state).
- **Recommended action**: Add guard matching `changePassphrase` pattern.

## Security Findings

### S1 [Major] GET /api/vault/rotate-key/data access control not specified
- **Problem**: New bulk fetch endpoint returns all encrypted entries+history but plan doesn't specify auth requirements. `/api/vault/*` uses route-handler auth (not middleware).
- **Impact**: Missing auth = unauthenticated full vault data exposure. Missing RLS = cross-tenant access.
- **Recommended action**: Specify: session auth (`auth()`), RLS (`withUserTenantRls`), rate limiting (share `rotateLimiter`), minimal `select` fields.

### S2 [Major] Entry ID schema: cuid vs cuid2 mismatch
- **Problem**: Plan uses `z.string().cuid2()` but codebase consistently uses `z.string().cuid()`. ID format mismatch could reject all entries.
- **Impact**: Rotation fails entirely, or weakened multi-layer defense if switched to permissive validation.
- **Recommended action**: Use `z.string().cuid()` to match existing codebase. Ensure `where` clauses include `userId` scope.

### S3 [Minor] TARGET_VERSION shell injection in script
- **Problem**: Unvalidated `TARGET_VERSION` env var could manipulate JSON payload.
- **Recommended action**: Add numeric validation in script: `[[ "$TARGET_VERSION" =~ ^[0-9]+$ ]]`.

## Testing Findings

### T1 [Critical] No tests specified for new /data endpoint
- **Problem**: `GET /api/vault/rotate-key/data` is a new endpoint returning sensitive data but has no test cases listed.
- **Recommended action**: Add test file with cases: 401 (unauth), 404 (vault not set up), 200 (entries+history), 429 (rate limit).

### T2 [Critical] No specific test cases for extended rotate-key schema
- **Problem**: "Update existing tests" is too vague. Entry/history re-encryption in transaction needs explicit test cases.
- **Recommended action**: Specify: entry count mismatch → 400/409, entries max exceeded → 400, successful rotation with entries+history update verification, advisory lock assertion.

### T3 [Major] No unit tests for rotateKey client function
- **Problem**: `vault-context.tsx` `rotateKey` function has complex state transitions (decrypt→re-encrypt loop, progress callback, POST failure rollback) with no test plan.
- **Recommended action**: Add vault-context `rotateKey` unit tests with Web Crypto API mocks.

### T4 [Major] Advisory lock test verification missing
- **Problem**: No test verifies advisory lock acquisition. Current mock pattern would pass without lock.
- **Recommended action**: Use `vi.fn(async (fn) => fn(tx))` mock pattern and assert `tx.$executeRaw` called with advisory lock SQL.

### T5 [Major] Shell script testing is manual only
- **Problem**: "manual test with curl" for `rotate-master-key.sh`. Other scripts have automated tests in `scripts/__tests__/`.
- **Recommended action**: Add `scripts/__tests__/rotate-master-key.test.mjs` for input validation logic.

### T6 [Minor] Constant boundary value tests not specified
- **Problem**: `VAULT_ROTATE_ENTRIES_MAX` boundary test not explicitly listed.
- **Recommended action**: Add `entries.length === 5001 → 400` test case.

## Adjacent Findings

### [Adjacent from Security] Team entries pagination
- Security expert flagged: team entries bulk fetch may hit pagination limits, causing `ENTRY_COUNT_MISMATCH`.
- Routed to Functionality scope → merged with F2.
