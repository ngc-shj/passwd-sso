# Delegated Decryption — Phase 5 Implementation Plan

## Context

The MCP Gateway (Phase 3) returns encrypted data only — AI agents cannot read plaintext passwords. Phase 5 enables a human user to selectively share decrypted entries with MCP sessions from their browser, with explicit per-entry consent and time-limited access.

**Core trade-off**: This is a deliberate, user-consented relaxation of zero-knowledge for specific entries. Plaintext exists temporarily on the server (Redis) scoped to a specific MCP token with a short TTL.

## Architecture

### Data Flow

```
Browser (vault unlocked)           Server                    MCP Client
    |                                |                          |
    | 1. GET /api/vault/delegation   |                          |
    |   (list active MCP sessions)   |                          |
    |------------------------------->|                          |
    |                                |                          |
    | 2. User selects MCP session    |                          |
    |    + entries + TTL in UI       |                          |
    | 3. Browser decrypts entries    |                          |
    |    client-side (encryptionKey) |                          |
    |                                |                          |
    | 4. POST /api/vault/delegation  |                          |
    |   { mcpTokenId, entries, ttl } |                          |
    |------------------------------->|                          |
    |   DelegationSession in DB      |                          |
    |   Encrypted entries in Redis   |                          |
    |   Audit: DELEGATION_CREATE     |                          |
    |                                |                          |
    |                                | 5. tools/call             |
    |                                |   get_decrypted_credential|
    |                                |   { id: "entry-uuid" }   |
    |                                |<-------------------------|
    |                                | Check delegation (DB)    |
    |                                | Fetch+decrypt from Redis |
    |                                | Audit: DELEGATION_READ   |
    |                                | Return plaintext         |
    |                                |------------------------->|
    |                                |                          |
    | 6. Vault lock / revoke / TTL   |                          |
    |   DELETE /api/vault/delegation |                          |
    |------------------------------->|                          |
    |   Evict Redis keys             |                          |
    |   Audit: DELEGATION_REVOKE     |                          |
```

### Key Design Decisions

1. **Pre-approval model** (not real-time consent) — no SSE/WebSocket infrastructure exists; 60s notification polling is too slow for interactive consent
2. **Separate tool** `get_decrypted_credential` — not a `decrypt: true` flag on `get_credential` — different authorization levels should not be conflated in one tool
3. **Envelope encryption** in Redis — plaintext entries encrypted with server master key (AES-256-GCM via `encryptServerData()`), so Redis compromise alone doesn't expose plaintext
4. **Redis SET index** for fast revocation without SCAN
5. **Max 20 entries per delegation** — prevents bulk exfiltration
6. **One active delegation per token** — creating a new delegation for the same MCP token auto-revokes the previous one, preventing ambiguity in tool lookup
7. **Request body never logged** — POST body contains plaintext; add delegation-specific fields to `METADATA_BLOCKLIST` and ensure error-reporting middleware strips request bodies on this route

## Requirements

### Functional
- User can create a delegation session scoped to a specific MCP access token (one active delegation per token; creating a new one auto-revokes the previous)
- User selects specific entries (max 20) and TTL (5–60 min, default 15 min, minimum 300 sec)
- MCP agent calls `get_decrypted_credential` to retrieve plaintext for delegated entries
- User can revoke any delegation session at any time
- Vault lock auto-revokes all active delegations
- Key rotation auto-revokes all active delegations

### Non-functional
- Plaintext never stored unencrypted at rest (envelope encryption in Redis)
- TTL enforced both by Redis expiry and DB `expiresAt` check
- All delegation lifecycle events audit-logged
- Tenant admin can configure max TTL and enable/disable feature

## Technical Approach

### 1. Schema Changes (`prisma/schema.prisma`)

**New model: `DelegationSession`**

```prisma
model DelegationSession {
  id         String    @id @default(uuid(4)) @db.Uuid
  tenantId   String    @map("tenant_id") @db.Uuid
  userId     String    @map("user_id") @db.Uuid
  mcpTokenId String    @map("mcp_token_id") @db.Uuid
  entryIds   String[]  @map("entry_ids")
  note       String?   @db.VarChar(255)
  expiresAt  DateTime  @map("expires_at")
  revokedAt  DateTime? @map("revoked_at")
  createdAt  DateTime  @default(now()) @map("created_at")

  user           User           @relation(fields: [userId], references: [id], onDelete: Cascade)
  tenant         Tenant         @relation(fields: [tenantId], references: [id], onDelete: Restrict)
  mcpAccessToken McpAccessToken @relation(fields: [mcpTokenId], references: [id], onDelete: Restrict)

  @@index([userId, revokedAt, expiresAt])
  @@index([mcpTokenId, revokedAt])
  @@index([tenantId])
  @@map("delegation_sessions")
}
```

Add back-references on `User`, `Tenant`, and `McpAccessToken`.

**New AuditAction enum values** (consistent `DELEGATION_` prefix): `DELEGATION_CREATE`, `DELEGATION_REVOKE`, `DELEGATION_EXPIRE`, `DELEGATION_READ`. Downstream updates required:
- `AUDIT_ACTION` object + `AUDIT_ACTION_VALUES` array in `src/lib/constants/audit.ts`
- New `AUDIT_ACTION_GROUP.DELEGATION` group in `AUDIT_ACTION_GROUPS_PERSONAL`
- i18n keys in `messages/en/AuditLog.json` and `messages/ja/AuditLog.json` (action labels + `groupDelegation` label)
- `src/__tests__/i18n/audit-log-keys.test.ts` will auto-validate coverage

**New Tenant policy fields**: `delegationDefaultTtlSec Int?`, `delegationMaxTtlSec Int?`

**New MCP scope**: `CREDENTIALS_DECRYPT: "credentials:decrypt"` in `src/lib/constants/mcp.ts`. This auto-updates `MCP_SCOPES` array (derived via `Object.values()`), which flows into:
- Zod validation in `/api/tenant/mcp-clients` routes (scope allowlist)
- OAuth authorize endpoint scope filtering against `McpClient.allowedScopes`
- `TOOL_SCOPE_MAP` in `src/lib/mcp/server.ts`

### 2. Redis Key Structure

```
delegation:{userId}:{sessionId}:entry:{entryId}   → envelope-encrypted JSON
delegation:{userId}:{sessionId}:entries_index      → Redis SET of entryIds
```

TTL set to `(expiresAt - now)` ms. Index key has same TTL.

Envelope encryption uses `encryptShareData()` / `decryptShareData()` from `src/lib/crypto-server.ts`. These functions handle `masterKeyVersion` automatically — `encryptShareData` embeds the current version in the output, and `decryptShareData` uses it to select the correct key for decryption. This is the same pattern used by share links.

**AAD binding**: Pass `aad = Buffer.from(delegationEntryKey(userId, sessionId, entryId))` to the underlying `encryptServerData()` call within a delegation-specific wrapper. This binds ciphertext to its key path, preventing ciphertext relocation attacks if Redis is partially compromised.

**Index key**: The `entries_index` Redis SET stores unencrypted entry ID UUIDs for fast revocation enumeration. This is an accepted trade-off — UUIDs alone do not reveal credential content.

### 3. Core Library (`src/lib/delegation.ts`)

```typescript
// Constants
DELEGATION_DEFAULT_TTL_SEC = 900     // 15 min
DELEGATION_MAX_TTL_SEC = 3600        // 1 hour
DELEGATION_MAX_ENTRIES = 20

// Redis key builders
delegationEntryKey(userId, sessionId, entryId): string
delegationIndexKey(userId, sessionId): string

// Operations
evictDelegationRedisKeys(userId, sessionId): Promise<void>
revokeAllDelegationSessions(userId, tenantId, reason): Promise<number>
findActiveDelegationSession(userId, mcpTokenDbId): Promise<{id, expiresAt} | null>
  // DB query: WHERE mcpTokenId = ? AND userId = ? AND revokedAt IS NULL AND expiresAt > NOW()
storeDelegationEntries(userId, sessionId, entries, ttlMs): Promise<void>
  // Each entry: encryptShareData(JSON.stringify(entry), aad) — handles masterKeyVersion
fetchDelegationEntry(userId, sessionId, entryId): Promise<object | null>
  // decryptShareData(ciphertext, masterKeyVersion, aad) where aad = delegationEntryKey()
```

### 4. API Endpoints

#### Browser-facing (session-authenticated)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/vault/delegation` | Create delegation (receives decrypted entries from browser) |
| GET | `/api/vault/delegation` | List active delegations for UI |
| DELETE | `/api/vault/delegation` | Bulk revoke all (called on vault lock) — sets `revokedAt` on all active DB rows + evicts Redis keys |
| DELETE | `/api/vault/delegation/[id]` | Revoke single delegation — sets `revokedAt` on DB row + evicts Redis keys |

**POST body**:
```typescript
{
  mcpTokenId: string;        // McpAccessToken.id (UUID)
  ttlSeconds?: number;       // 300–3600, default from tenant policy (min 5 min)
  note?: string;             // optional label
  entries: Array<{
    id: string;              // PasswordEntry.id
    title: string;
    username?: string | null;
    password?: string | null;
    url?: string | null;
    notes?: string | null;
  }>;
}
```

**Validation**:
- `assertOrigin(request)` on all endpoints (existing CSRF model: Origin check + SameSite=Lax cookies + CSP connect-src)
- Verify `mcpTokenId` belongs to user's tenant, not expired/revoked, has `credentials:decrypt` scope
- Verify each `entryId` exists in PasswordEntry for this `userId` AND `tenantId` (multi-tenant isolation)
- If an active delegation already exists for this `mcpTokenId`, auto-revoke it (evict Redis + set `revokedAt`) before creating the new one
- Enforce `ttlSeconds <= tenant.delegationMaxTtlSec ?? 3600`
- Rate limit: 10 creates per user per 15 min (using existing `RateLimiter` from `src/lib/rate-limit.ts` with key `delegation:create:{userId}`)
- **Request body must never be logged**: extract plaintext entries into a separate variable immediately after Zod validation; never pass to logging or error handlers. Add `entries` to `METADATA_BLOCKLIST` in `src/lib/audit-logger.ts`. Audit metadata records `{ entryCount, mcpClientId }` only — never `entryIds` array or plaintext fields

#### MCP-facing (new tool)

| Tool | Scope | Returns |
|------|-------|---------|
| `get_decrypted_credential` | `credentials:decrypt` | Plaintext entry fields |

### 5. MCP Tool Implementation (`src/lib/mcp/tools.ts`)

New `toolGetDecryptedCredential(token, rawInput)`:
1. Parse `{ id: z.string().uuid() }`
2. Guard: `token.userId` must be non-null
3. Find active `DelegationSession` by `(userId, mcpTokenId)`
4. Fetch from Redis → `decryptServerData()` → parse JSON
5. Audit log: `DELEGATION_READ` with `actorType: "MCP_AGENT"`, metadata: `{ entryId, delegationSessionId }`
6. Return plaintext fields

Add to `TOOL_SCOPE_MAP` and `handleToolsCall` switch in `src/lib/mcp/server.ts`.

Add to `MCP_TOOLS` array with description that explicitly states: "Requires credentials:decrypt scope and an active delegation session." This ensures MCP clients that enumerate `tools/list` see the scope requirement upfront.

**MCP token deletion**: If active (non-revoked, non-expired) `DelegationSession` rows exist for a token, the token deletion API must auto-revoke them (set `revokedAt`, evict Redis) before proceeding. The `onDelete: Restrict` FK prevents deletion of tokens with active delegations at the DB level.

### 6. Vault Lock Integration (`src/lib/vault-context.tsx`)

Use `fetch('/api/vault/delegation', { method: 'DELETE', keepalive: true })` in the `lock()` callback and `pagehide` event handler. `keepalive: true` survives page unload, sends proper method/headers, and includes cookies — unlike `sendBeacon` which only supports POST.

Note: `sendBeacon` is NOT suitable here (POST-only, `text/plain` content-type, no auth headers). Redis TTL is the ultimate fallback if `fetch` with `keepalive` fails.

### 7. Key Rotation Integration (`src/app/api/vault/rotate-key/route.ts`)

Call `revokeAllDelegationSessions(userId, tenantId, "KEY_ROTATION")` after successful rotation transaction.

### 8. UI Components

| Component | Location | Purpose |
|-----------|----------|---------|
| `DelegationManager` | Settings → Developer tab (after ApiKeyManager) | List/revoke active delegations, "New Delegation" button |
| `CreateDelegationDialog` | Dialog opened from DelegationManager | Select MCP token → select entries → set TTL → confirm |
| `DelegationRevokeBanner` | DashboardShell (after RecoveryKeyBanner) | Persistent banner: "N active delegation(s)" |

**Entry selector in dialog**: Uses `useVault()` to access `encryptionKey`, decrypts overviews in-browser (same pattern as `password-list.tsx`), renders checkboxes for selection.

### 9. i18n

Add keys under `MachineIdentity.delegation.*` in `messages/en.json` and `messages/ja.json`.

### 10. Tenant Admin Policy

Add `delegationDefaultTtlSec` and `delegationMaxTtlSec` fields to the tenant policy UI (mirrors JIT token TTL pattern).

## Implementation Steps

| # | Task | Key Files | Dependencies |
|---|------|-----------|-------------|
| 1 | Schema + migration | `prisma/schema.prisma` | — |
| 2 | Constants (scope, audit, API path) | `src/lib/constants/mcp.ts`, `audit.ts`, `api-path.ts` | 1 |
| 3 | Core library | `src/lib/delegation.ts` + tests | 1, 2 |
| 4 | Browser API endpoints + proxy | `src/app/api/vault/delegation/`, `src/proxy.ts` + tests | 3 |
| 5 | MCP tool | `src/lib/mcp/tools.ts`, `server.ts` + tests | 3 |
| 6 | Vault lock + key rotation hooks | `vault-context.tsx`, `rotate-key/route.ts` | 4 |
| 7 | UI components | Settings page, delegation manager, dialog, banner | 4, 5 |
| 8 | i18n + tenant admin policy UI | `messages/`, tenant settings | 7 |

## Comprehensive File List

### New files
- `src/lib/delegation.ts` — core library
- `src/lib/delegation.test.ts` — unit tests
- `src/app/api/vault/delegation/route.ts` — POST/GET/DELETE
- `src/app/api/vault/delegation/[id]/route.ts` — DELETE by ID
- `src/app/api/vault/delegation/route.test.ts` — integration tests
- `src/components/settings/delegation-manager.tsx` — list/revoke UI
- `src/components/settings/create-delegation-dialog.tsx` — entry selector
- `src/components/vault/delegation-revoke-banner.tsx` — dashboard banner
- `src/lib/constants/mcp.test.ts` — MCP_SCOPES exhaustiveness test

### Modified files
- `prisma/schema.prisma` — DelegationSession model, AuditAction enum, Tenant policy fields
- `src/lib/constants/mcp.ts` — `CREDENTIALS_DECRYPT` scope
- `src/lib/constants/audit.ts` — DELEGATION_* actions, group, AUDIT_ACTION_VALUES
- `src/lib/constants/api-path.ts` — `VAULT_DELEGATION` path
- `src/lib/constants/api-path.test.ts` — new path assertions
- `src/lib/audit-logger.ts` — add `entries` to METADATA_BLOCKLIST
- `src/lib/mcp/tools.ts` — `get_decrypted_credential` tool + handler
- `src/lib/mcp/server.ts` — TOOL_SCOPE_MAP + handleToolsCall switch
- `src/lib/mcp/tools.test.ts` — new tool tests
- `src/lib/vault-context.tsx` — sendBeacon on lock/pagehide
- `src/app/api/vault/rotate-key/route.ts` — revokeAllDelegationSessions
- `src/proxy.ts` — add `/api/vault/delegation` to session-protected paths
- `src/app/[locale]/dashboard/settings/page.tsx` — DelegationManager in developer tab
- `src/components/layout/dashboard-shell.tsx` — DelegationRevokeBanner
- `messages/en.json` — delegation UI strings
- `messages/ja.json` — delegation UI strings
- `messages/en/AuditLog.json` — DELEGATION_* action labels + groupDelegation
- `messages/ja/AuditLog.json` — DELEGATION_* action labels + groupDelegation

## Testing Strategy

- **Unit**: `src/lib/delegation.test.ts` — Redis key format, envelope encrypt round-trip with AAD, session lookup, TTL verification (mock Redis `set` args include PX option)
- **Unit**: `src/lib/constants/mcp.test.ts` — MCP_SCOPES contains all MCP_SCOPE values including credentials:decrypt
- **Unit**: `src/lib/mcp/tools.test.ts` — get_decrypted_credential: valid, expired, missing scope, Redis miss, revokedAt check
- **Integration**: `src/app/api/vault/delegation/route.test.ts` — CRUD, validation, CSRF, rate limiting, one-active-per-token invariant (create → create again for same token → verify first revoked), tenantId isolation
- **E2E**: Full flow — unlock vault → create delegation → MCP tool call → revoke

## Verification

1. `npx vitest run` — all tests pass
2. `npx next build` — production build succeeds
3. Manual: unlock vault → Settings → Developer → New Delegation → select entry → confirm → `curl` MCP `get_decrypted_credential` with mcp_ token → verify plaintext returned → revoke → verify 404

## Security Considerations

| Threat | Mitigation |
|--------|-----------|
| Redis compromise exposes plaintext | Envelope encryption with `SHARE_MASTER_KEY` (AES-256-GCM) |
| MCP token theft → read delegated entries | Token has short TTL (1h); delegation has shorter TTL (default 15min); revocation immediate |
| Bulk exfiltration | Max 20 entries per delegation; rate limit on creation |
| Ciphertext relocation in Redis | AAD binding: `aad = delegationEntryKey()` prevents cross-key decryption |
| Cross-user/cross-tenant access | Redis keys scoped by `userId`; DB queries filter by `userId` AND `tenantId` |
| CSRF on delegation endpoints | `assertOrigin(request)` on all destructive operations |
| Stale delegation after browser close | Redis TTL auto-expires; DB `expiresAt` checked on read; lazy cleanup marks DB row expired when Redis key missing |
| Plaintext in request body logged | Route-level log suppression; never pass plaintext fields to `logAudit()` metadata or error-reporting middleware |
| Key rotation consistency | Active delegations auto-revoked on key rotation |

## Considerations & Constraints

- **Out of scope**: Real-time consent flow (requires SSE/WebSocket — Phase 5b if needed)
- **Out of scope**: Team vault delegation (requires team key distribution to MCP context)
- **Out of scope**: File attachment delegation (binary data, different encryption path)
- Server momentarily holds plaintext — this is the fundamental trade-off, mitigated by envelope encryption + TTL

## User Operation Scenarios

1. **Happy path**: User unlocks vault → Settings → Developer → "New Delegation" → selects "GitHub" MCP client → checks 3 entries → 15min TTL → Confirm → Claude Desktop calls `get_decrypted_credential` → gets plaintext → after 15min, entries expire
2. **Vault lock**: User locks vault → browser fires DELETE → all delegations revoked → MCP tool returns "not delegated"
3. **Manual revoke**: User clicks "Revoke" on active delegation → Redis keys deleted → MCP tool returns "not delegated"
4. **Token expired**: MCP token expires → `validateMcpToken()` rejects → delegation entries remain in Redis until TTL but are inaccessible
5. **No decrypt scope**: MCP client authorized without `credentials:decrypt` → UI shows tooltip "Re-authorize to enable delegation" → cannot create delegation for this token
6. **Tenant disabled**: Admin sets delegation disabled → POST /api/vault/delegation returns 403 → UI hides "New Delegation" button
