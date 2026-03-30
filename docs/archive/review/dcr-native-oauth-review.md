# Plan Review: dcr-native-oauth
Date: 2026-03-29
Review round: 1

## Changes from Previous Round
Initial review

## Local LLM Pre-screening (8 findings, all addressed before expert review)
1. [Major] nullable tenantId impact files → plan updated with affected file list
2. [Major] Rate limiter reuse → plan updated to specify createRateLimiter
3. [Major] Audit event dispatch missing → plan updated with dispatch locations
4. [Major] Consent CSRF → plan mentions SameSite + param validation
5. [Minor] Constants import → noted for implementation
6. [Minor] CSPRNG → existing pattern uses crypto.randomBytes
7. [Major] SA flow impact → plan clarified SA unaffected, test updates needed
8. [Minor] Cleanup scheduling → piggyback + admin endpoint described

## Functionality Findings

### [F-01] Critical: DCR client tenantId nullable breaks exchangeCodeForToken tenant boundary guard
- **Problem:** `exchangeCodeForToken()` compares `authCode.tenantId !== authCode.mcpClient.tenantId`. For unclaimed DCR clients both are null, so `null === null` passes the guard. Also `createAuthorizationCode()` tenantId param is `string` (not nullable) — passing null violates DB NOT NULL on McpAuthorizationCode.tenantId.
- **Impact:** Either 500 error (DB constraint) or tenant boundary bypass for unclaimed DCR clients.
- **Recommended action:** (1) In consent page claiming logic, set tenantId BEFORE calling createAuthorizationCode — pass user's tenantId, never null. (2) Add explicit null guard in exchangeCodeForToken: `if (!authCode.tenantId || !authCode.mcpClient.tenantId) return { error: "invalid_client" }`. (3) Clarify in plan that /authorize → consent page → claiming → code generation is sequential, not concurrent.
- **Merged with:** Security S-2 (same root cause, security perspective)

### [F-02] Major: Scope delimiter inconsistency (space vs comma)
- **Problem:** RFC 6749/OAuth 2.1 uses space-delimited scopes in requests. Existing code converts space → comma for DB storage. Plan doesn't specify DCR scope delimiter handling.
- **Impact:** scope parsing mismatch for DCR-issued tokens if conversion isn't applied consistently.
- **Recommended action:** Explicitly state in plan: "DCR scope parameters use space delimiter (RFC standard), converted to comma for internal storage, matching existing pattern."

### [F-03] Major: @@unique([tenantId, name]) constraint with nullable tenantId
- **Problem:** PostgreSQL treats NULL as distinct in unique constraints. Multiple unclaimed DCR clients can share the same name. After claiming, need to check tenant-level name uniqueness.
- **Impact:** Name collision after claiming; tenant client count (MAX_MCP_CLIENTS_PER_TENANT) doesn't count DCR clients.
- **Recommended action:** Add explicit name uniqueness check within claiming logic. Document that DCR client count is managed by global cap (100), not per-tenant cap (10), until claimed.

### [F-04] Major: McpRefreshToken missing cascade delete + access token ↔ refresh token lifecycle coupling
- **Problem:** Plan doesn't specify onDelete: Cascade for McpRefreshToken → McpClient. Also when access token is revoked, corresponding refresh tokens should also be revoked.
- **Impact:** Orphaned refresh tokens on client deletion. Active refresh tokens allow new access tokens even after explicit revocation.
- **Recommended action:** (1) Add `onDelete: Cascade` on McpRefreshToken.mcpClient relation. (2) When revoking access token, revoke related refresh tokens in same transaction.

### [F-05] Major: New AuditAction downstream invariants not fully specified
- **Problem:** Adding new audit actions requires updating: AUDIT_ACTION object, AUDIT_ACTION_VALUES array, AUDIT_ACTION_GROUPS_TENANT[MCP_CLIENT], messages/en.json, messages/ja.json. These are not all listed.
- **Impact:** Test failure (audit.test.ts alignment check) and missing i18n labels.
- **Recommended action:** List all downstream files in Step 10: AUDIT_ACTION_VALUES, AUDIT_ACTION_GROUPS_TENANT, both i18n message files.

### [F-06] Major: redirect_uri validation inconsistency (127.0.0.1 vs localhost)
- **Problem:** DCR allows `http://127.0.0.1:PORT/` but existing admin API validates `http://localhost` only. Also port must be required (RFC 8252 §7.3: localhost is discouraged due to DNS rebinding).
- **Impact:** DCR clients can't be edited via admin UI; portless 127.0.0.1 could allow auth code interception.
- **Recommended action:** (1) Require port in loopback URIs: `^http://127\.0\.0\.1:\d{1,5}/`. (2) Reject `localhost`. (3) Update admin API validation to also accept `127.0.0.1:PORT`. (4) Add to impact files list.
- **Merged with:** Security S-4 (same issue, security perspective adds RFC 8252 reference)

## Security Findings

### [S-1] Major: Empty granted scope allows token issuance
- **Problem:** If client requests only scopes not in allowedScopes, grantedScopes becomes empty array. Current /authorize doesn't reject empty scopes — issues scope="" token.
- **Impact:** scope="" tokens could bypass scope checks in edge cases; scope downgrade attack vector.
- **Recommended action:** Add `grantedScopes.length === 0 → invalid_scope error` in both /authorize and consent endpoint.

### [S-3] Major: Token endpoint rate limiter key is user-controlled (client_id from request body)
- **Problem:** Rate limiter keyed on `client_id` from request body. Attacker can use different client_ids to bypass rate limit or exhaust another client's quota.
- **Impact:** DoS against legitimate clients; brute-force via key flooding.
- **Recommended action:** Add IP-based primary rate limiter alongside client_id-based secondary limiter.

### [S-5] Major: Refresh token chain revocation needs familyId for efficient bulk revoke
- **Problem:** replacedByHash creates a linked list requiring forward traversal to find active tokens. O(n) chain walk for revocation.
- **Impact:** Replay detection works but can't efficiently revoke the entire chain including current access tokens.
- **Recommended action:** Add `familyId` (UUID) column to McpRefreshToken. On replay detection: `UPDATE ... SET revokedAt = NOW() WHERE familyId = ? AND revokedAt IS NULL`. Also revoke associated access tokens.

### [S-6] Minor: state parameter must be preserved through consent UI flow
- **Problem:** state must flow: /authorize → consent page (hidden input) → POST consent → redirect. Not explicitly specified.
- **Impact:** OAuth CSRF protection (RFC 6749 §10.12) ineffective if state is lost.
- **Recommended action:** Specify state as hidden input in consent form, validated in POST consent.

### [S-7] Minor: DCR global cap TOCTOU race condition
- **Problem:** count + create without transaction allows exceeding 100 cap under concurrent requests.
- **Recommended action:** Use Prisma $transaction for count → create serialization.

### [S-8] Minor: DCR cleanup filter must use strict AND conditions
- **Recommended action:** Ensure `isDcr = true AND tenantId IS NULL AND dcrExpiresAt < NOW()` — add test for claimed clients not being deleted.

## Testing Findings

### [T-1] Critical: Refresh token replay detection test must verify chain revocation DB writes
- **Problem:** Plan mentions replay detection test but doesn't specify verifying that the entire token family is revoked.
- **Impact:** Implementation could break without detection.
- **Recommended action:** Add explicit test cases: (1) reused token → invalid_grant + all family tokens revoked, (2) normal rotation → old token reuse → new token also revoked.

### [T-2] Major: DCR global cap test needs clear mock specification
- **Problem:** Global cap test needs to mock `prisma.mcpClient.count({})` (no tenant filter) separately from tenant cap.
- **Recommended action:** Specify constant name (MAX_UNCLAIMED_DCR_CLIENTS) and mock signature in plan.

### [T-3] Major: Token route refresh_token grant needs separate VALID_BODY constant
- **Problem:** Existing VALID_BODY is authorization_code-specific. Mixing with refresh_token params causes false positives.
- **Recommended action:** Create VALID_REFRESH_BODY in test updates.

### [T-4] Major: Consent deny flow redirect parameter testing missing
- **Problem:** Deny → redirect with error=access_denied + state must be verified.
- **Recommended action:** Add deny test case verifying redirect URL params.

### [T-5] Minor: scope-parser allowlist test placement should be clarified
- **Recommended action:** Allowlist validation in parseScope() → test in scope-parser.test.ts.

### [T-6] Minor: Discovery endpoint test needs Phase 6 field verification
- **Recommended action:** Update integration test Scenario 7 to check registration_endpoint and updated grant_types.

### [T-7] Minor: vitest coverage.include missing src/lib/mcp/**
- **Recommended action:** Add `"src/lib/mcp/**/*.ts"` to coverage.include.

## Adjacent Findings
None — all findings fell within respective expert scopes.

## Quality Warnings
None flagged by deduplication.
