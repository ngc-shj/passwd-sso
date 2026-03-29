# Plan: MCP Zero-Knowledge CLI Decrypt

## Objective

Eliminate plaintext **secret** (password, notes) exposure in the MCP flow. Three actors with strict separation of concerns:

- **Human** (Delegation UI): decides which entries to allow, for how long
- **Server** (DelegationSession): answers "is this request authorized?" — never holds vault key
- **Agent** (CLI daemon): decrypts when authorized — never makes authorization decisions

## Requirements

### Functional Requirements

1. **MCP tools return metadata only** — `list_credentials` and `search_credentials` return non-secret metadata (title, username, urlHost, tags). No password, notes, or full URL.
2. **Credential usage via Skill/hook** — Claude Code Skill or hook executes "decrypt → use → result" as a one-liner. Plaintext stays in pipe/stdin; only the operation result reaches Claude's context. This is **Claude Code specific** — other MCP clients can only access metadata.
3. **Scope separation** — `credentials:list` (metadata) and `credentials:use` (authorize decrypt via agent)
4. **Agent daemon** — `passwd-sso agent --decrypt` holds vault key in memory, listens on Unix socket, checks authorization with server before every decrypt
5. **Delegation UI preserved** — Human selects entries, TTL, MCP client in browser. Server stores DelegationSession with entryIds allowlist. No secrets sent to server.
6. **Authorization check endpoint** — `GET /api/vault/delegation/check` lets agent verify "should I decrypt entry X for MCP client Y right now?"
7. **Shell integration** — `eval $(passwd-sso agent --decrypt --eval)` for ssh-agent-style session scoping

### Non-Functional Requirements

1. **Zero plaintext on server** — Server never sees passwords, notes, or vault key
2. **Zero plaintext to LLM** — Plaintext never appears in Claude's conversation context. Consumed in pipe/stdin within Skill/hook.
3. **Session-scoped** — Agent starts/stops with shell session, vault key never persisted to disk
4. **No PSSO_PASSPHRASE** — Passphrase entered once via TTY at agent startup, not stored in env

## Technical Approach

### Architecture

```
Human                     Server                Agent daemon           Claude Code (AI)
  │                         │                       │                       │
  ├── Delegation UI ───────→│                       │                       │
  │   (select entries,      │ DelegationSession     │                       │
  │    TTL, MCP client)     │ { entryIds, ttl }     │                       │
  │                         │                       │                       │
  ├── passwd-sso agent ─────────────────────────────→│                      │
  │   --decrypt --eval      │                       │ vault key in memory   │
  │   (passphrase 1回)      │                       │ Unix socket listen    │
  │                         │                       │                       │
  │                         │                       │     MCP: tools/call   │
  │                         │                       │     list_credentials ◄┤
  │                         │── metadata ──────────────────────────────────→│
  │                         │                       │                       │
  │                         │                       │  Skill/hook: Bash     │
  │                         │                       │  one-liner ◄──────────┤
  │                         │                       │                       │
  │                         │ ◄── check auth ───────┤                       │
  │                         │── 200 OK / 403 ──────→│                       │
  │                         │                       │                       │
  │                         │                       │  decrypt (pipe) ─────→│
  │                         │                       │  use credential       │
  │                         │                       │  echo "result" ──────→│
  │                         │                       │                       │
  │                         │                       │  Claude sees only     │
  │                         │                       │  "result" in stdout   │
```

### Credential Usage Pattern (Claude Code Specific)

Claude Code invokes a Skill or Bash command. Plaintext is consumed in pipe/stdin and never appears in stdout:

```bash
# Safe: password stays in pipe, process args clean, errors suppressed
passwd-sso decrypt <id> --field password --mcp-token <tokenId> \
  | curl --config - -X POST https://api.example.com 2>/dev/null \
  && echo "API call succeeded" || echo "API call failed"
```

**Security constraints for Skill/hook commands:**
- Never put credentials in process arguments (visible via `ps`) — use stdin/pipe
- `curl --config -` or `curl -K -` reads auth from stdin (not `-u user:pass`)
- Suppress stderr (`2>/dev/null`) to prevent credential leaks in error messages
- Only the final `echo` reaches Claude's conversation context

### Scope Model

| Scope | Tools | What AI sees |
|-------|-------|-------------|
| `credentials:list` | `list_credentials`, `search_credentials` | Metadata only (title, username, urlHost, tags) |
| `credentials:use` | (authorizes agent decrypt) | Nothing directly — Skill/hook result only |
| `credentials:decrypt` (legacy) | All of the above | Alias for `list + use` during migration |

Note: `credentials:use` does NOT correspond to a specific MCP tool. It authorizes the agent to respond to decrypt requests for delegated entries. The actual credential usage happens via Claude Code Skill/hook (Bash tool), not via MCP protocol.

### Authorization Flow (per decrypt request)

```
Agent receives via Unix socket: decrypt(entryId="abc", mcpTokenId="X", field="password")

1. Agent → GET /api/vault/delegation/check?mcpTokenId=X&entryId=abc
   (Agent authenticates with its own Bearer token)

2. Server checks:
   ✓ DelegationSession exists for (userId, mcpTokenId=X) — via findActiveDelegationSession()
   ✓ session.revokedAt IS NULL
   ✓ session.expiresAt > NOW()
   ✓ "abc" ∈ session.entryIds
   → 200 OK { authorized: true, sessionId, expiresAt }
   OR
   → 403 Forbidden { authorized: false, reason }

3. Agent:
   if 200 → fetch GET /api/passwords/abc → verify response.id == "abc" → decrypt with vault key + AAD → return plaintext field
   if 403 → return error to caller
```

**No caching** of authorization responses. Every decrypt request makes a fresh check against the server. This ensures revocation is immediate (no 5-second window).

### JIT Authorization Model

The DelegationSession acts as a **pre-authorized allowlist**: the user explicitly selects which entries an MCP client can access.

- `list_credentials` → returns metadata only for entries in `DelegationSession.entryIds`
- `search_credentials` → searches only within delegated entry metadata
- Agent decrypt → authorized only if entryId ∈ `DelegationSession.entryIds`

**Session lookup is always by `(userId, mcpTokenId)` pair** — never by userId alone.

### What Gets Removed

- **Secret fields from delegation data** — `password`, `notes`, `url` removed from request schema
- **Plaintext secret relay** — Browser never sends secrets to server
- **Old `get_credential` tool** — No replacement MCP tool (credential usage goes through Skill/hook)
- **Redis envelope encryption for secrets** — Server stores only metadata in Redis
- `CREDENTIALS_DECRYPT` as standalone scope (becomes legacy alias)

### What Gets Preserved (Modified)

- **DelegationSession model + Redis cache** — Retained for metadata storage + JIT authorization
- **Delegation UI** — Sends metadata only, not secrets
- **Agent command** — Extended with `--decrypt` mode
- **Redis functions** — Type narrowed to metadata-only

### What Gets Added

- `credentials:list` and `credentials:use` scopes
- `passwd-sso agent --decrypt [--eval]` — Decrypt agent with Unix socket
- `passwd-sso decrypt <id>` — Thin socket client for Skill/hook usage
- `GET /api/vault/delegation/check` — Authorization check endpoint
- `DELEGATION_CHECK` audit action
- Claude Code Skill template for credential usage

## Implementation Steps

### Step 1: Add New Scopes

1. `src/lib/constants/mcp.ts`:
   - Add `CREDENTIALS_LIST: "credentials:list"` and `CREDENTIALS_USE: "credentials:use"`
   - **Keep `CREDENTIALS_DECRYPT` in `MCP_SCOPE`** as legacy alias
   - `MCP_SCOPES` array contains all values

2. `src/lib/scope-parser.ts`:
   - Add `credentials:list` and `credentials:use` to `VALID_RESOURCE_ACTIONS`
   - **Import from `MCP_SCOPE` constants** (not string literals)

3. Tests:
   - `mcp.test.ts`: Assert `CREDENTIALS_LIST`, `CREDENTIALS_USE` in `MCP_SCOPES`, legacy `CREDENTIALS_DECRYPT` remains
   - `scope-parser.test.ts`: **Delete L201-L204** (old rejection test), add positive tests for new scopes

### Step 2: Agent Decrypt Mode

1. `cli/src/commands/agent.ts` — Extend with `--decrypt` flag:

   **Code structure:** Existing `agentCommand()` is SSH-agent-only. Add top-level flag check: `--decrypt` → call new `decryptAgentCommand()` (separate function). Extract to `cli/src/commands/agent-decrypt.ts` if code grows large. Do NOT mix SSH agent and decrypt agent logic.

   **Socket:**
   - Create Unix socket at `$XDG_RUNTIME_DIR/passwd-sso/decrypt.sock`
   - **No `/tmp` fallback** — if `$XDG_RUNTIME_DIR` is not set, error and exit with instructions
   - Socket permissions: `0600` (owner only)
   - On startup: verify socket path ownership via `fs.lstatSync()` before binding
   - If stale socket exists: verify UID matches, then unlink and rebind

   **Vault unlock:**
   - `--decrypt` mode does **NOT** call `autoUnlockIfNeeded()` (which reads `PSSO_PASSPHRASE` env)
   - Instead, call `readPassphrase()` directly for TTY prompt — **requires exporting `readPassphrase()` from `cli/src/commands/unlock.ts`** (currently unexported). Alternatively, extract to `cli/src/lib/passphrase.ts` as a shared module.
   - Hold vault key in memory via `setEncryptionKey()`
   - If no TTY available and vault is locked → error and exit

   **Request handling:**
   - Accept JSON over Unix socket: `{ entryId: string, mcpTokenId: string, field?: string }`
   - **Input validation:**
     - `entryId`: `z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/)` (safe for shell, supports CUID v1 + UUIDv4)
     - `field`: enum `"password" | "username" | "url" | "notes" | "totp"` (whitelist, no injection)
     - `mcpTokenId`: `z.string().uuid()`
   - For each request:
     a. Call `GET /api/vault/delegation/check?mcpTokenId=...&entryId=...` (**no caching**)
     b. If 403 → return error
     c. If 200 → fetch `GET /api/passwords/<entryId>` → verify response.id == entryId → decrypt with vault key + AAD → return requested field
   - **Reuse existing**: `decryptData()` from `cli/src/lib/crypto.ts`, `buildPersonalEntryAAD()` from `cli/src/lib/crypto-aad.ts`

   **Background token refresh:**
   - Reuse `startBackgroundRefresh()` from `cli/src/lib/api-client.ts`
   - Agent stays authenticated as long as it runs

2. `--eval` flag — Daemonization:
   - When `--eval` is passed, agent forks itself as a background process (`child_process.spawn` with `detached: true`, `stdio: 'ignore'`, `unref()`)
   - Parent process outputs eval commands to stdout and exits:
     ```bash
     PSSO_AGENT_SOCK=/run/user/1000/passwd-sso/decrypt.sock; export PSSO_AGENT_SOCK;
     PSSO_AGENT_PID=<child_pid>; export PSSO_AGENT_PID;
     trap "kill $PSSO_AGENT_PID 2>/dev/null; rm -f $PSSO_AGENT_SOCK" EXIT;
     ```
   - Child process runs the agent daemon (socket listen, vault key in memory)
   - **Passphrase challenge**: Parent prompts for passphrase via TTY, derives vault key, then passes raw key bytes to child via IPC channel. Spawn with `stdio: ['ignore', 'pipe', 'ignore', 'ipc']`. Parent sends `child.send({ key: hexEncode(rawKeyBytes) })`, child receives via `process.on('message')` and imports with `crypto.subtle.importKey()`. Parent then calls `child.unref()` and exits.
   - **trap EXIT caveat**: `eval $(...)` runs in current shell. If shell already has a trap EXIT (e.g., direnv), it gets overwritten. Document this and recommend wrapper pattern.

3. `cli/src/commands/decrypt.ts` — Thin socket client:
   - `passwd-sso decrypt <id> --field <field> --mcp-token <tokenId>`
   - Connects to `$PSSO_AGENT_SOCK` Unix socket
   - Sends `{ entryId, mcpTokenId, field }`
   - Prints plaintext to **stdout** (for pipe consumption), errors to **stderr**
   - Exit code 0/1 for scripting
   - **No crypto, no vault access** — just a socket client
   - If `$PSSO_AGENT_SOCK` not set → stderr: "Agent not running. Start with: eval \$(passwd-sso agent --decrypt --eval)"

4. Register both in `cli/src/index.ts` (top-level + REPL interactive mode switch)

5. Tests (`cli/src/__tests__/agent-decrypt.test.ts`, `cli/src/__tests__/decrypt-client.test.ts`):
   - Socket creation, permissions (0600), ownership verification
   - Auth check call: 200 → decrypt, 403 → error, network failure → error
   - Decrypt flow: aadVersion=0 (no AAD), aadVersion>=1 (with AAD)
   - Response entryId mismatch → error
   - Field whitelist: valid fields accepted, invalid rejected
   - Decrypt client: socket connect, stdout/stderr separation, exit codes
   - Agent not running → helpful error message
   - **CI environment**: Use `$TMPDIR` or `mkdtemp` for socket path in tests (not `$XDG_RUNTIME_DIR`)

### Step 3: Authorization Check Endpoint

1. `src/app/api/vault/delegation/check/route.ts` — New GET endpoint:
   - Query params: `mcpTokenId` (UUID), `entryId` (regex: `[a-zA-Z0-9_-]{1,100}`)
   - Auth: Bearer token (session-based, same as CLI API calls)
   - Logic:
     a. `findActiveDelegationSession(userId, mcpTokenId)` — reuses existing function
     b. Verify entryId ∈ session.entryIds
     c. 200: `{ authorized: true, sessionId, expiresAt }`
     d. 403: `{ authorized: false, reason: "no_session" | "expired" | "entry_not_delegated" }`
   - Audit: `DELEGATION_CHECK` action (lightweight, metadata only)
   - Rate limit: session-based key `delegation:check:${userId}` using existing `createRateLimiter()`

2. `src/lib/constants/audit.ts`:
   - Add `DELEGATION_CHECK: "DELEGATION_CHECK"` to `AUDIT_ACTION`
   - Add to `AUDIT_ACTION_GROUP.DELEGATION` array
   - Verify i18n audit labels if applicable

3. Test: `src/app/api/vault/delegation/check/route.test.ts`:
   - Active session + entry in allowlist → 200
   - Session expired → 403
   - Entry not in allowlist → 403
   - No session → 403
   - Unauthenticated → 401
   - Audit log assertion

### Step 4: Rewrite MCP Tools (Metadata Only)

1. `src/lib/mcp/tools.ts`:
   - **Remove** `get_credential` tool entirely (and `toolGetCredential` export)
   - `list_credentials`: Returns metadata from delegation Redis cache
     - Session lookup: `findActiveDelegationSession(token.userId!, token.tokenId)` — **never userId-only**
     - Fields: `{ id, title, username, urlHost, tags, entryType }` — no password/notes/url
   - `search_credentials`: Same, with filtering
   - **No `use_credential` MCP tool** — credential usage goes through Claude Code Skill/hook (Bash tool), not MCP protocol

2. `src/lib/mcp/server.ts`:
   - `list_credentials` → `credentials:list`
   - `search_credentials` → `credentials:list`
   - Remove `get_credential` from dispatch and `TOOL_SCOPE_MAP`
   - `hasRequiredScope()`: Check required scope OR legacy `credentials:decrypt`

3. `tools.test.ts`:
   - Update mock fixtures to metadata-only (remove password/notes/url from fixtures AND add absence assertions)
   - **Remove `toolGetCredential` import (L29)** and entire `get_credential` describe block — must be atomic with Step 4-1 to avoid import errors
   - Legacy scope: `credentials:decrypt` grants `list_credentials` and `search_credentials`
   - Verify `not.toHaveProperty("password")`, `not.toHaveProperty("notes")`, `not.toHaveProperty("url")` on responses

### Step 5: Modify Delegation to Metadata-Only

1. `src/app/api/vault/delegation/route.ts`:
   - **POST**: Schema → `{ id, title, username, urlHost, tags }` only. Remove password/notes/url.
   - **POST scope**: Accept `credentials:list` OR `credentials:use` OR legacy `credentials:decrypt`
   - **GET**: Rename `hasDecryptScope` → `hasDelegationScope`. Compute as: token has any of `credentials:list`, `credentials:use`, `credentials:decrypt`. Also add scope filter to `availableTokens` query so only tokens with delegation-relevant scopes appear.
   - Type rename: `DelegationEntryData` → `DelegationMetadata`

2. `src/lib/delegation.ts`:
   - Narrow type to `DelegationMetadata` (exclude secret fields)
   - Keep Redis storage for metadata
   - **Redis compatibility**: Existing delegation sessions in Redis may contain old `DelegationEntryData` with password/notes fields. `fetchDelegationEntry()` should silently ignore extra fields when parsing (use `DelegationMetadata` type but don't `z.strict()`). Old sessions will expire via TTL naturally.

3. UI components:
   - `create-delegation-dialog.tsx`: Send metadata only, accept new scopes, update copy
   - `delegation-manager.tsx`: Update terminology

### Step 6: Update OAuth & Consent UI

1. `src/app/api/mcp/.well-known/oauth-authorization-server/route.ts`:
   - Add `credentials:list`, `credentials:use` to `scopes_supported`
   - Keep `credentials:decrypt`

2. i18n:
   - `McpConsent.json` (en/ja): New scope descriptions
   - `MachineIdentity.json` (en/ja): Remove "temporarily decrypted" warning, update to metadata-only language

3. `consent-form.tsx`, `mcp-client-card.tsx`: Display/select new scopes

### Step 7: Handle Legacy `credentials:decrypt` Scope

1. **Expansion at consent time**: In `consent/route.ts`, expand `credentials:decrypt` to `credentials:list,credentials:use` before storing in authorization code
2. `server.ts`: `hasRequiredScope()` checks new scope OR legacy fallback
3. No backfill — existing tokens expire naturally
4. **Exhaustive scope reference audit**: All files referencing `credentials:decrypt` — see full list in previous plan revision (constants, parser, server, tools, delegation route, OAuth discovery, consent, UI components, i18n, all test files, docs)

### Step 8: Update Tests

1. `src/lib/mcp/tools.test.ts` — Metadata-only list/search, remove `get_credential` tests, absence assertions, fixture cleanup
2. `src/lib/delegation.test.ts` — Metadata-only entries. Update test fixtures (e.g., L82-84 plaintext JSON) to use metadata-only fields (no `password`)
3. `src/__tests__/integration/mcp-oauth-flow.test.ts`:
   - **Delete** Scenario 5 `get_credential` tests (L592-706) and `toolGetCredential` import
   - Add fixture variants with `credentials:list`, `credentials:use`
   - Add legacy `credentials:decrypt` expansion scenario
   - **Add absence assertion**: `list_credentials` response must `not.toHaveProperty("password")`
   - **Import from `MCP_SCOPE` constants** (not hardcoded strings)
4. `src/app/api/mcp/authorize/consent/route.test.ts`:
   - Add legacy expansion assertion: when `credentials:decrypt` is consented, `createAuthorizationCode` receives expanded scopes
   - Import from `MCP_SCOPE` constants
5. `src/lib/constants/mcp.test.ts`:
   - Assert `CREDENTIALS_LIST`, `CREDENTIALS_USE` in `MCP_SCOPES`
   - Assert `CREDENTIALS_DECRYPT` legacy remains
6. `src/lib/scope-parser.test.ts`:
   - Delete L201-L204, add positive tests for `credentials:list` and `credentials:use`, import from `MCP_SCOPE`
   - Add rejection test: `team:<uuid>:credentials:use` should return null (not a valid team scope)
7. `cli/src/__tests__/agent-decrypt.test.ts` — Agent socket, auth check, decrypt flow, AAD branching
8. `cli/src/__tests__/decrypt-client.test.ts` — Socket client, exit codes, error handling
9. `src/app/api/vault/delegation/check/route.test.ts` — Auth check endpoint: 200/403/401 cases, audit
10. `cli/src/__tests__/crypto-aad.test.ts` — Add aadVersion=0 behavior test if not covered

### Step 9: Claude Code Skill Template

Create example Skill definition for credential usage:

```markdown
# /use-credential Skill
Decrypts a vault credential and uses it for an API call.
Plaintext never appears in conversation context.

Usage: /use-credential <entryId> <curl-args...>
```

Implementation:
```bash
passwd-sso decrypt "$ENTRY_ID" --field password --mcp-token "$MCP_TOKEN_ID" \
  | curl --config - "$@" 2>/dev/null \
  && echo "Request succeeded" || echo "Request failed (exit $?)"
```

Document in `docs/architecture/machine-identity.md` with:
- Safe pattern examples (stdin/pipe, never process args)
- Unsafe anti-patterns to avoid
- How to configure in `.claude/settings.json`

### Step 10: Update Documentation

1. `docs/operations/audit-log-reference.md` — Add `DELEGATION_CHECK`
2. `docs/architecture/machine-identity.md` — New architecture, Skill pattern, safe usage guide

## Testing Strategy

### Unit Tests
- New scopes parse correctly, legacy expands at consent time
- `list_credentials`/`search_credentials`: metadata only (absence assertions for password/notes/url)
- Agent: socket creation/permissions/ownership, auth check, decrypt with AAD (v0 and v>=1), entryId verification
- Decrypt client: socket connect, stdout/stderr, exit codes 0/1
- Auth check endpoint: 200/403/401, audit logging
- Delegation POST: rejects requests with password/notes, accepts new scopes
- `hasRequiredScope()`: new scopes and legacy fallback
- Legacy expansion at consent time: assertion on stored scope string

### Integration Tests
- Full OAuth flow with `credentials:list` + `credentials:use`
- Legacy `credentials:decrypt` grants both capabilities
- Agent → auth check → decrypt → stdout round-trip
- Agent rejects unauthorized entry (not in entryIds)
- Agent rejects expired delegation session

### Manual Tests
- `eval $(passwd-sso agent --decrypt --eval)` → shell integration, passphrase prompt, background daemon
- Delegation UI → metadata only in network tab
- Claude Code Skill: `passwd-sso decrypt` → pipe → curl → only result in context
- Agent stops on terminal close (trap EXIT)
- Revocation: revoke in browser → next agent decrypt fails immediately (no cache)

## Considerations & Constraints

1. **Claude Code specific** — Credential usage (Skill/hook) is Claude Code specific. Other MCP clients can only access metadata via `list_credentials`/`search_credentials`. This is an explicit design choice, not a limitation.

2. **encryptedOverview is E2E encrypted** — Metadata for list/search comes from delegation (browser pre-decrypts overview, sends metadata only). Username/urlHost pass through server as plaintext metadata — inherent trade-off.

3. **Agent is session-scoped** — Starts with `eval $(...)` in shell profile, stops on terminal close. Vault key only in process memory, never on disk.

4. **No PSSO_PASSPHRASE** — Agent uses TTY passphrase prompt (`readPassphrase()`) directly. Does NOT call `autoUnlockIfNeeded()` which would read from env.

5. **Socket security** — `$XDG_RUNTIME_DIR` only (no `/tmp` fallback). Socket `0600`. Ownership verified before bind. Stale socket: verify UID → unlink → rebind.

6. **No authorization cache** — Every decrypt request checks the server. Ensures immediate revocation. DB round-trip is ~1ms, acceptable even for batch operations.

7. **Bearer token vs vault key separation** — Agent uses a Bearer token (stored on disk by `passwd-sso login`) for API authentication. Vault key is separate, held only in process memory. Bearer token compromise allows checking delegation status but NOT decrypting entries (vault key required).

8. **Mixed entry ID formats** — Both CUID v1 and UUIDv4 supported via `z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/)`. This regex also prevents shell injection.

9. **Field whitelist** — `decrypt` command only accepts `"password" | "username" | "url" | "notes" | "totp"`. Prevents injection via field parameter.

10. **Process argument safety** — Skill/hook commands must never put credentials in process arguments (visible via `ps`). Use `curl --config -` or pipe-based approaches. Suppress stderr to prevent credential leaks in error messages.

11. **`PSSO_AGENT_SOCK` environment propagation** — Like `SSH_AUTH_SOCK`, this env var propagates to child processes. Any process running as the same user with this env var can connect to the agent socket. The agent validates `mcpTokenId` against server-side DelegationSession for every request, so unauthorized requests are rejected even if socket access is obtained.

12. **Username PII** — `list_credentials` returns username to LLM. Needed for credential selection. Future: opt-in at consent time.

## User Operation Scenarios

### Scenario 1: Claude Code with Agent (Primary)

```bash
# Shell profile (.zshrc) — one-time setup
eval $(passwd-sso agent --decrypt --eval)
# → "Master passphrase: " (first terminal open of the day)
# → Agent running. PSSO_AGENT_SOCK exported.
```

1. User opens browser → Delegation UI → selects "GitHub" and "AWS" → TTL 30min → Create
2. Claude Code calls MCP `list_credentials` → `[{id: "abc", title: "GitHub", username: "user@example.com"}, ...]`
3. Claude: "GitHub にログインします" → Bash tool:
   ```bash
   passwd-sso decrypt abc --field password --mcp-token X \
     | curl --config - -u user@example.com https://api.github.com/user 2>/dev/null \
     && echo "Login successful" || echo "Login failed"
   ```
4. Agent: checks server → DelegationSession active, "abc" ∈ entryIds → 200 OK
5. Agent: fetches encrypted blob → decrypts → returns password to `passwd-sso decrypt` stdout
6. curl reads password from stdin → executes API call → succeeds
7. Claude sees: "Login successful" — **never saw the password**

### Scenario 2: Delegation Expired

1. Claude calls `passwd-sso decrypt abc ...` after TTL expired
2. Agent checks server → 403 (session expired)
3. `passwd-sso decrypt` exits with code 1, stderr: "Delegation expired"
4. Claude: "Delegation session expired. Please create a new delegation in the browser."

### Scenario 3: Agent Not Running

1. Claude tries Bash: `passwd-sso decrypt abc ...`
2. `$PSSO_AGENT_SOCK` not set → exit 1, stderr: "Agent not running"
3. Claude: "Please start the decrypt agent: `eval $(passwd-sso agent --decrypt --eval)`"

### Scenario 4: Other MCP Client (Metadata Only)

1. Non-Claude-Code MCP client with `credentials:list` scope
2. Can call `list_credentials`, `search_credentials` → sees metadata
3. Cannot use credentials (no Skill/hook mechanism)
4. Must instruct user to manually copy credentials when needed
