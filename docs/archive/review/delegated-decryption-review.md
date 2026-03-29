# Plan Review: delegated-decryption
Date: 2026-03-28T21:50:00+09:00
Review round: 1

## Changes from Previous Round
Initial review

## Merged Findings (Deduplicated)

### M1 (Critical) — MCP scope definition + OAuth validation
Sources: F1, S1 (escalate: true)
**Problem**: `credentials:decrypt` scope is not defined in `MCP_SCOPE` / `MCP_SCOPES`. OAuth authorize endpoint must validate requested scopes against `McpClient.allowedScopes` — otherwise any MCP client can self-grant decrypt scope.
**Impact**: Access control for plaintext password retrieval is entirely absent.
**Recommended action**: Add `CREDENTIALS_DECRYPT` to `MCP_SCOPE`; verify OAuth authorize route filters scopes against `McpClient.allowedScopes`; add explicit scope check in `get_decrypted_credential` handler.
**Files**: `src/lib/constants/mcp.ts`, `src/app/api/mcp/authorize/route.ts`, `src/lib/mcp/server.ts`

### M2 (Critical) — Audit action downstream invariants
Sources: F2, T1, T2
**Problem**: New `DELEGATION_*` audit actions need to be added to: Prisma `AuditAction` enum, `AUDIT_ACTION` object, `AUDIT_ACTION_VALUES` array, a group in `AUDIT_ACTION_GROUPS_PERSONAL` (new `DELEGATION` group or extend `MCP_CLIENT`), i18n keys in `messages/{en,ja}/AuditLog.json`, and group label key. Existing `audit.test.ts` and `audit-log-keys.test.ts` will fail if any are missed.
**Impact**: Build-blocking test failures; delegation events invisible in audit log UI filters.
**Recommended action**: Create `AUDIT_ACTION_GROUP.DELEGATION` group; add all 4 actions to it; add i18n keys for actions + group label.
**Files**: `prisma/schema.prisma`, `src/lib/constants/audit.ts`, `messages/en/AuditLog.json`, `messages/ja/AuditLog.json`

### M3 (Major) — Redis envelope encryption lacks AAD binding
Source: S2
**Problem**: `encryptServerData()` supports AAD but the plan doesn't specify using it. Without AAD, a Redis-compromised attacker can relocate ciphertext between entry keys (ciphertext relocation attack).
**Impact**: Entry-level consent bypass if Redis is partially compromised.
**Recommended action**: Pass `aad = Buffer.from(delegationEntryKey(userId, sessionId, entryId))` to `encryptServerData()` and `decryptServerData()`.
**Files**: `src/lib/delegation.ts`

### M4 (Major) — Proxy session protection missing for delegation endpoint
Source: F3
**Problem**: `/api/vault/delegation` not in `src/proxy.ts` session-required path list. Vault endpoints are individually enumerated, not prefix-matched.
**Impact**: Endpoint reachable without middleware session check (still has route-handler auth, but defense-in-depth is weakened).
**Recommended action**: Add `/api/vault/delegation` to `src/proxy.ts` protected paths.
**Files**: `src/proxy.ts`

### M5 (Major) — lock() fire-and-forget DELETE unreliable
Source: F4
**Problem**: `lock()` callback uses `fetch()` which fails on network errors, tab close, or page navigation. TTL (up to 60 min) is the only fallback.
**Impact**: Delegated plaintext remains accessible after vault lock for up to TTL duration.
**Recommended action**: Use `navigator.sendBeacon()` for the DELETE call (survives page unload); document that TTL is the ultimate fallback.
**Files**: `src/lib/vault-context.tsx`

### M6 (Major) — DelegationSession.mcpTokenId missing FK
Source: F5
**Problem**: No FK relation to `McpAccessToken` — orphan delegation records when MCP token is deleted.
**Impact**: Stale DB records; potential confusion in UI/audit.
**Recommended action**: Add `mcpAccessToken McpAccessToken @relation(fields: [mcpTokenId], references: [id], onDelete: Cascade)` to schema. Add back-reference on `McpAccessToken`.
**Files**: `prisma/schema.prisma`

### M7 (Major) — Request body plaintext logging risk (nested fields)
Sources: F6, S3
**Problem**: POST body contains `entries[].password` which is nested. Pino's flat `redact.paths` won't match. Error middleware may capture full body.
**Impact**: Plaintext passwords leaked to log aggregators on unhandled exceptions.
**Recommended action**: In route handler, extract plaintext entries into a separate variable and never pass to logging. Add `entries` to `METADATA_BLOCKLIST`. Consider pino wildcard redact paths.
**Files**: `src/app/api/vault/delegation/route.ts`, `src/lib/audit-logger.ts`

### M8 (Major) — Entry ownership missing tenantId check
Source: S4
**Problem**: Plan specifies entryId verification against `userId` only, not `tenantId`. Multi-tenant isolation requires both.
**Impact**: Cross-tenant entry leakage in edge cases.
**Recommended action**: Add `tenantId: session.user.tenantId` to entry ownership query. Also verify tenantId in `get_decrypted_credential`.
**Files**: `src/app/api/vault/delegation/route.ts`, `src/lib/mcp/tools.ts`

### M9 (Major) — No test for MCP_SCOPES exhaustiveness
Source: T3
**Problem**: No test verifies `MCP_SCOPES` contains `credentials:decrypt` after addition.
**Recommended action**: Create `src/lib/constants/mcp.test.ts` with exhaustiveness test (same pattern as `audit.test.ts`).

### M10 (Major) — Redis TTL verification missing from test strategy
Source: T4
**Problem**: Unit tests don't verify `set` is called with `EX`/`PX` option and correct TTL value.
**Recommended action**: Add mock assertion for Redis `set` arguments including TTL.

### M11 (Major) — No test for one-active-per-token invariant under concurrency
Source: T5
**Problem**: No test for concurrent POST creating duplicate delegations for same token.
**Recommended action**: Add test: create delegation → POST again for same token → verify first is revoked, second is active.

### M12 (Minor) — Implementation file list incomplete
Sources: F7, S7, T6
**Recommended action**: Add comprehensive file list to plan.

### M13 (Minor) — DelegationSession validity check specification
Source: S5
**Recommended action**: Explicitly specify `revokedAt: null AND expiresAt > now()` in DB query for `findActiveDelegationSession`.

### M14 (Minor) — Audit metadata should use entryCount not entryIds
Source: S6
**Recommended action**: Record `{ entryCount, mcpClientId }` in metadata, not entryIds array.

## Adjacent Findings
None (all adjacent findings merged with appropriate expert scope above).

---

# Round 2

## Changes from Previous Round
All 14 findings from Round 1 reflected in plan. See M1–M14 above.

## Round 2 Findings (Deduplicated)

### R2-1 (Major) — sendBeacon only supports POST, not DELETE
Sources: Func-R2-1, Sec-N1
**Resolution**: Changed to `fetch({keepalive: true})` which supports DELETE, headers, and cookies. sendBeacon removed.

### R2-2 (Major) — masterKeyVersion management missing for envelope encryption
Source: Func-R2-2
**Resolution**: Changed from `encryptServerData`/`decryptServerData` to `encryptShareData`/`decryptShareData` which handle masterKeyVersion automatically.

### R2-3 (Major) — onDelete: Cascade destroys delegation audit trail
Source: Sec-N2
**Resolution**: Changed FK to `onDelete: Restrict`. Token deletion must auto-revoke active delegations first.

### R2-4 (Minor) — TTL min/max inconsistency
Source: Func-R2-3
**Resolution**: Unified to min 300 sec (5 min), max 3600 sec (1 hour).

### R2-5 (Minor) — tools/list shows tool regardless of scope
Source: Sec-N5
**Resolution**: Tool description explicitly states scope requirement.

### R2-6 (Minor) — Redis entries_index exposes entry IDs
Source: Sec-N4
**Resolution**: Accepted risk, documented in plan (UUIDs alone don't reveal content).

### R2-7 (Minor) — assertOrigin bypassed when APP_URL unset
Source: Sec-N3
**Resolution**: Not addressed — pre-existing pattern across all vault endpoints, not Phase 5 specific. Tracked as separate issue.

### Testing Expert Findings (Round 2)
Note: Testing expert checked CURRENT codebase, not the plan. Since code has not been written yet, findings about missing test files are expected. The plan specifies all required tests. Pre-existing gaps (ENTRY_DELETE/ACCESS_DENIED not in groups, Machine Identity api-path tests) are out of scope for Phase 5.
