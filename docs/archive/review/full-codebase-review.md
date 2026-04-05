# Full Codebase Review: passwd-sso
Date: 2026-04-05
Review type: Full codebase (main branch, clean state)
Review round: 1

## Changes from Previous Round
Initial review (full codebase audit)

---

## Functionality Findings

### [F-01] Major: buildAuditLogDateFilter passes Invalid Date to Prisma without validation
- **File:** `src/lib/audit-query.ts:50-51`
- **Evidence:** `new Date(from)` called without `isNaN` check. Download endpoints validate; list endpoints do not.
- **Problem:** 4 callers lack date validation: `/api/audit-logs`, `/api/tenant/audit-logs`, `/api/teams/[teamId]/audit-logs`, `/api/tenant/breakglass/[id]/logs`. Invalid string like `from=banana` produces `Invalid Date` passed to Prisma.
- **Impact:** Prisma either throws (500 error) or silently ignores filter (returns unfiltered data).
- **Fix:** Add `isNaN(new Date(val).getTime())` validation inside `buildAuditLogDateFilter`, returning undefined for invalid dates (consistent with no-filter behavior), or throw with explicit error.

### [F-03] Minor: Session cache eviction is FIFO, not LRU
- **File:** `src/proxy.ts:284-287`
- **Evidence:** `sessionCache.keys().next().value` evicts the oldest-inserted entry, not least-recently-used.
- **Problem:** Under high concurrency (500+ distinct sessions), active sessions inserted early may be repeatedly evicted.
- **Impact:** Performance degradation (extra auth endpoint calls), no correctness issue.
- **Fix:** Document as accepted trade-off, or implement touch-on-read for LRU behavior.

### [F-09] Major: /api/vault/* and /api/folders/* bypass tenant IP access-restriction enforcement
- **File:** `src/proxy.ts:168-187` (session-check block missing vault/folder paths)
- **Evidence:** `handleApiAuth` session-check block covers 18 route prefixes but NOT `/api/vault/*` or `/api/folders/*`. Vault route handlers call `auth()` for authentication but never call `checkAccessRestrictionWithAudit` or `enforceAccessRestriction`. grep confirms 0 matches for access restriction in `src/app/api/vault/` and `src/app/api/folders/`.
- **Problem:** Tenant-configured IP allowlists do not protect vault unlock, key rotation, passphrase change, or folder operations. A client on a blocked IP range with a valid session cookie can still access these endpoints.
- **Impact:** Tenant IP access restriction policy partially bypassed for the most sensitive operations (vault unlock/rotate-key).
- **Fix:** Add vault and folder paths to the session-check block in `handleApiAuth`, or add `enforceAccessRestriction` calls in each vault/folder route handler.

### ~~[F-08] Major: withBypassRls wrapping prisma.$transaction creates nested transactions~~
- **Status:** FALSE POSITIVE
- **Evidence:** `src/lib/prisma.ts:136-165` implements a Proxy on the base PrismaClient. When `getTenantRlsContext()` returns an active `tx`, the Proxy intercepts `$transaction` calls and routes them to the existing transaction context (L143-154). This means nested `prisma.$transaction` inside `withBypassRls` reuses the same connection with bypass settings intact.
- **Conclusion:** The Proxy pattern deliberately handles this case. No bug.

### ~~[F-11] Major: Same nested-transaction anti-pattern in auth.ts and vault-reset.ts~~
- **Status:** FALSE POSITIVE (same root cause as F-08 — Proxy handles it)

---

## Security Findings

### [S-01] Minor: clientSecretHash comparison uses !== instead of timingSafeEqual
- **File:** `src/lib/mcp/oauth-server.ts:157, 333`
- **Evidence:** `authCode.mcpClient.clientSecretHash !== params.clientSecretHash` — SHA-256 hash strings compared with `!==`.
- **Problem:** Both values are SHA-256 hex hashes (not raw secrets), so timing leak reveals hash relationship, not the secret itself. Practical exploitability is very low.
- **Fix:** Replace with `crypto.timingSafeEqual(Buffer.from(stored, 'hex'), Buffer.from(provided, 'hex'))` for OAuth 2.1 compliance.

### [S-03] Major: Audit log listing endpoints accept invalid date parameters (same root cause as F-01)
- **File:** `src/lib/audit-query.ts:50-51`
- **Problem:** Attacker with valid session can send `?from=garbage` to bypass date filters and potentially retrieve unfiltered audit logs.
- **Fix:** Same as F-01 — validate dates in `buildAuditLogDateFilter`.

### [S-04] Minor: form-action CSP allows http://localhost:* in production
- **File:** `proxy.ts:22`
- **Evidence:** RFC 8252 OAuth native app callback requirement. Documented in code comments and threat model.
- **Problem:** With XSS as precondition, form POST to localhost is allowed. Known design trade-off.
- **Fix:** Consider environment-conditional form-action, but may break Claude Code/Desktop OAuth flow.

### [S-06] Minor: block-all-mixed-content is deprecated (MDN)
- **File:** `proxy.ts:25`
- **Evidence:** `upgrade-insecure-requests` already covers this. `block-all-mixed-content` is dead code.
- **Fix:** Remove `block-all-mixed-content` line.

### [S-08] Minor: TEST-NET CIDRs missing from webhook SSRF blocklist
- **File:** `src/lib/webhook-dispatcher.ts:106-124`
- **Evidence:** RFC 5737 TEST-NET ranges (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`) not blocked.
- **Problem:** Low risk — these ranges are not routed on the public internet, but could reach internal services in misconfigured cloud environments.
- **Fix:** Add the three TEST-NET CIDRs to `BLOCKED_CIDRS`.

### [S-11] Minor: MCP revoke endpoint does not verify client_secret for confidential clients
- **File:** `src/app/api/mcp/revoke/route.ts:46-48`
- **Evidence:** `revokeToken()` checks `mcpClient.clientId` but not `clientSecretHash`.
- **Problem:** RFC 7009 §2.1 requires confidential client authentication at revoke. Current implementation allows revoke with client_id + token value alone. Practical impact is low (attacker needs the token value).
- **Fix:** Add `clientSecretHash` verification in `revokeToken` for confidential clients.

---

## Testing Findings

### [T-01] Major: buildAuditLogDateFilter Invalid Date case not tested (same root cause as F-01/S-03)
- **File:** `src/lib/audit-query.test.ts:327-358`
- **Evidence:** Tests cover only valid ISO date strings. No test for `"not-a-date"` or `""`.
- **Fix:** Add test case verifying behavior with invalid date strings.

### [T-02] Major: 7 of 14 CLI commands have zero unit test coverage
- **File:** `cli/src/commands/` — `list`, `status`, `export`, `run`, `env`, `get`, `generate` untested.
- **Fix:** Add unit tests for each, mocking `apiRequest` and `vault-state`.

### [T-03] Major: IPC integration test uses mock sockets only — no real process fork test
- **File:** `cli/src/__tests__/integration/agent-decrypt-ipc.test.ts`
- **Evidence:** `handleConnection` imported directly, `MockSocket` used. No `child_process.fork()`.
- **Fix:** Add integration test that forks the actual daemon and communicates via real Unix socket.

### [T-05] Minor: Watchtower E2E 180s timeout creates flaky CI risk
- **File:** `e2e/tests/watchtower.spec.ts:19`
- **Fix:** Cap seeded entries or mock HIBP.

### [T-06] Minor: Brittle CSS selector `a.rounded-xl` in E2E team test
- **File:** `e2e/tests/teams.spec.ts:48`
- **Fix:** Use existing page object method `teamsPage.teamByName()`.

### [T-07] Minor: Emergency Access E2E does not test request→approve→vault lifecycle
- **File:** `e2e/tests/emergency-access.spec.ts`
- **Fix:** Add E2E scenario covering the critical grant approval flow.

### [T-08] Minor: audit-query.ts excluded from vitest coverage include list
- **File:** `vitest.config.ts:16-48`
- **Fix:** Add `"src/lib/audit-query.ts"` to coverage include.

### [T-09] Minor: 60% global coverage threshold too low for security-critical app
- **File:** `vitest.config.ts:54`
- **Fix:** Raise to 75-80% and add per-file thresholds for critical modules.

---

## Adjacent Findings
- [Adjacent from Testing] S-08 (TEST-NET CIDR gap) — webhook SSRF test should also cover redirect-follow scenario (T-10).

---

## Quality Warnings
None flagged by local LLM (skipped — no diff to review).

---

## Resolution Status

### [F-01/S-03/T-01] Major: buildAuditLogDateFilter date validation
- **Action:** Added `isNaN(d.getTime())` validation inside `buildAuditLogDateFilter`. Invalid dates are silently ignored (filter returns undefined). Added 5 test cases for invalid date inputs.
- **Modified files:** `src/lib/audit-query.ts`, `src/lib/audit-query.test.ts`
- **Status:** RESOLVED

### [F-09] Major: vault/folders IP access restriction bypass
- **Action:** Replaced `API_PATH.VAULT_DELEGATION` with `"/api/vault/"` prefix check (covers all vault sub-paths). Added `API_PATH.FOLDERS` to session-check block. Added 3 proxy tests for vault/folders 401.
- **Modified files:** `src/proxy.ts`, `src/__tests__/proxy.test.ts`
- **Status:** RESOLVED

### [S-01] Minor: timingSafeEqual for clientSecretHash
- **Action:** Added `safeEqual()` helper using `crypto.timingSafeEqual`. Replaced `!==` with `safeEqual()` in `exchangeCodeForToken`, `exchangeRefreshToken`. Also replaced manual XOR loop in `verifyPkceS256` with `timingSafeEqual`.
- **Modified files:** `src/lib/mcp/oauth-server.ts`
- **Status:** RESOLVED

### [S-06] Minor: Remove deprecated block-all-mixed-content
- **Action:** Removed `block-all-mixed-content` from CSP directives. `upgrade-insecure-requests` already covers this.
- **Modified files:** `proxy.ts`
- **Status:** RESOLVED

### [S-08] Minor: TEST-NET CIDRs missing from webhook SSRF blocklist
- **Action:** Added `192.0.2.0/24` (TEST-NET-1), `198.51.100.0/24` (TEST-NET-2), `203.0.113.0/24` (TEST-NET-3) to `BLOCKED_CIDRS`. Added 3 tests for TEST-NET IPs.
- **Modified files:** `src/lib/webhook-dispatcher.ts`, `src/lib/webhook-dispatcher.test.ts`
- **Status:** RESOLVED

### [S-11] Minor: MCP revoke client_secret verification
- **Action:** Added `clientSecretHash` param to `revokeToken()`. Confidential clients now require valid `client_secret` for revocation. Revoke route handler passes hashed secret.
- **Modified files:** `src/lib/mcp/oauth-server.ts`, `src/app/api/mcp/revoke/route.ts`
- **Status:** RESOLVED

### [T-06] Minor: Brittle CSS selector in E2E
- **Action:** Replaced `ownerPage.locator("a.rounded-xl")` with `teamsPage.teamByName(PRE_SEEDED_TEAM_NAME)`.
- **Modified files:** `e2e/tests/teams.spec.ts`
- **Status:** RESOLVED

### [T-08] Minor: audit-query.ts excluded from coverage
- **Action:** Added `"src/lib/audit-query.ts"` to vitest coverage include list.
- **Modified files:** `vitest.config.ts`
- **Status:** RESOLVED

### [T-10] Minor: Webhook redirect-follow test missing
- **Action:** Added test verifying delivery fails when fetch throws redirect error. Also added TEST-NET SSRF tests.
- **Modified files:** `src/lib/webhook-dispatcher.test.ts`
- **Status:** RESOLVED

### Deferred findings (not addressed in this PR)
- **[T-02] Major:** 7/14 CLI commands untested — requires new test files, separate effort
- **[T-03] Major:** IPC integration test mock-only — requires real process fork test infrastructure
- **[T-05] Minor:** Watchtower E2E 180s timeout — flaky CI risk
- **[T-07] Minor:** Emergency Access E2E lifecycle gap
- **[T-09] Minor:** 60% global coverage threshold
- **[F-03] Minor:** Session cache FIFO eviction (accepted trade-off)
- **[S-04] Minor:** form-action localhost in production (RFC 8252 requirement)

---

## Summary

| Severity | Count | IDs |
|----------|-------|-----|
| Critical | 0 | — |
| Major | 4 (unique root causes: 3) | F-01/S-03/T-01, F-09, T-02, T-03 |
| Minor | 12 | F-03, S-01, S-04, S-06, S-08, S-11, T-05, T-06, T-07, T-08, T-09, T-10 |
| False Positive | 2 | F-08, F-11 |

### Root Cause Grouping
1. **Date validation gap** (F-01 = S-03 = T-01): `buildAuditLogDateFilter` lacks `isNaN` check — affects 4 audit-log list endpoints
2. **IP access restriction bypass** (F-09): vault/* and folders/* excluded from proxy session-check block
3. **CLI test gap** (T-02): 7/14 commands untested
4. **IPC test gap** (T-03): Mock socket only, no real process fork
