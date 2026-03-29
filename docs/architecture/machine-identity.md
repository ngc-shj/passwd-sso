# Machine Identity: AI Agent Identity & MCP Gateway

## Overview

passwd-sso's Machine Identity feature enables AI agents and automated systems to interact with the password vault alongside human users, while preserving the zero-knowledge encryption model.

Inspired by [1Password's Unified Identity](https://1password.com/product/unified-access), this feature introduces non-human identities as first-class entities with scoped access, approval workflows, and cross-actor audit tracking.

## Architecture

### Identity Model

```
┌──────────────────────────────────────────┐
│                 Tenant                    │
│                                          │
│  ┌─────────┐  ┌──────────────────┐       │
│  │  Human   │  │ Service Account  │       │
│  │  Users   │  │  (Non-human ID)  │       │
│  └────┬─────┘  └───────┬──────────┘       │
│       │                │                  │
│  Session / API Key  SA Token (sa_)        │
│  Extension Token    MCP Token (mcp_)      │
│       │                │                  │
│       └────────┬───────┘                  │
│           authOrToken()                   │
│           Unified Audit                   │
└──────────────────────────────────────────┘
```

### Authentication Pipeline

The `authOrToken()` dispatcher uses Bearer token prefix to route:

| Prefix | Handler | Identity Type |
|--------|---------|--------------|
| (none/session) | `auth()` | Human (session) |
| `api_` | `validateApiKey()` | Human (API key) |
| `sa_` | `validateServiceAccountToken()` | Service Account |
| `scim_` | (dedicated routes) | System (SCIM) |
| `mcp_` | `validateMcpToken()` | Human or SA (via OAuth) |
| (opaque) | `validateExtensionToken()` | Human (browser extension) |

### Token Hashing

All bearer tokens use SHA-256 (unsalted) hashing — consistent with the existing API Key, Extension Token, and SCIM Token patterns. High-entropy random tokens (256-bit) make salting unnecessary (same approach as GitHub, Stripe).

## Service Accounts

### Lifecycle

1. **Create** — Tenant admin creates SA via UI or API
2. **Token issuance** — Admin issues scoped `sa_` tokens with expiration
3. **Usage** — SA authenticates via Bearer token on allowed endpoints
4. **Deactivation** — Toggle `isActive` to immediately reject all tokens
5. **Deletion** — Hard delete with cascade (tokens, access requests removed)

### Scope Model

SA tokens use an enumerated allowlist validated by `z.array(z.enum(SA_TOKEN_SCOPES))`:

| Scope | Purpose |
|-------|---------|
| `passwords:read` | Read encrypted entries |
| `passwords:write` | Create/update entries |
| `passwords:list` | List entry metadata |
| `tags:read` | Read tags |
| `vault:status` | Check vault initialization |
| `folders:read` / `folders:write` | Folder operations |
| `team:passwords:read` / `team:passwords:write` | Team vault access |
| `access-request:create` | Self-service JIT access request |

Forbidden scopes (`vault:unlock`, `vault:setup`, `vault:reset`) are structurally excluded.

### v1 API Access

SA tokens authenticate on `/api/v1/*` endpoints but cannot access personal vault data (SA has no `userId`). Only `vault/status` returns data; password/tag endpoints return 403 with a message to use MCP Gateway.

## Just-in-Time (JIT) Access

### Workflow

```
SA (sa_ token)                    Admin (browser session)
     │                                    │
     │ POST /api/tenant/access-requests   │
     │ scope: access-request:create       │
     │ body: { requestedScope, justification }
     │──────────────────────────────────►  │
     │                                    │
     │                           Reviews request in UI
     │                           Machine Identity → Access Requests
     │                                    │
     │                     POST /approve  │
     │  ◄─────────────────────────────────│
     │  JIT token (sa_ prefix, short TTL) │
     │                                    │
     │ Uses JIT token for expanded access │
     │ Token auto-expires after TTL       │
```

### Atomicity

- Approval uses `prisma.$transaction` with optimistic lock (`WHERE status='PENDING'`)
- Double-approval returns 409 Conflict
- Token count enforced within transaction (`MAX_SA_TOKENS_PER_ACCOUNT = 5`)
- Scope re-validated at approval time via `parseSaTokenScopes()` (defense against scope deprecation)

### Tenant Policy

| Column | Default | Purpose |
|--------|---------|---------|
| `jitTokenDefaultTtlSec` | 3600 (1h) | Default JIT token lifetime |
| `jitTokenMaxTtlSec` | 86400 (24h) | Maximum JIT token lifetime |
| `saTokenMaxExpiryDays` | 365 | Maximum SA token expiration |

## MCP Gateway

### Native OAuth Flow (Dynamic Client Registration)

Claude Code and Claude Desktop connect with just a URL.

**Claude Code CLI:**

```bash
claude mcp add passwd-sso --transport http https://sso.example.com/api/mcp
```

**Claude Desktop (`claude_desktop_config.json`):**

```json
{ "mcpServers": { "passwd-sso": { "url": "https://sso.example.com/api/mcp" } } }
```

> **Base path**: If the app is served under a base path (e.g. `NEXT_PUBLIC_BASE_PATH=/passwd-sso`),
> include it in the URL: `https://sso.example.com/passwd-sso/api/mcp`

#### Reverse Proxy Setup

The MCP spec requires the OAuth discovery endpoint at `/.well-known/oauth-authorization-server` on the **domain root** — not under the base path. When using a reverse proxy with `NEXT_PUBLIC_BASE_PATH`, this root-level path must be explicitly forwarded to the Next.js backend.

> **Note**: Replace `$BASE_PATH` with your `NEXT_PUBLIC_BASE_PATH` value (e.g. `/passwd-sso`).
> Replace `$BACKEND` with your Next.js server address (e.g. `https+insecure://localhost:3001` or `https://backend:3001`).

**Tailscale Serve:**

```bash
# App proxy (existing)
tailscale serve --bg --set-path $BASE_PATH $BACKEND$BASE_PATH

# OAuth discovery — must be at domain root (MCP spec requirement)
tailscale serve --bg --set-path /.well-known/oauth-authorization-server \
  $BACKEND$BASE_PATH/api/mcp/.well-known/oauth-authorization-server
```

**Apache:**

```apache
# OAuth discovery — add BEFORE the app ProxyPass
ProxyPass        /.well-known/oauth-authorization-server $BACKEND$BASE_PATH/api/mcp/.well-known/oauth-authorization-server
ProxyPassReverse /.well-known/oauth-authorization-server $BACKEND$BASE_PATH/api/mcp/.well-known/oauth-authorization-server
```

If the app is served at the domain root (no base path), the discovery endpoint is already accessible at the correct path and no additional proxy rule is needed.

#### Flow

1. Client discovers `/.well-known/oauth-authorization-server` → gets `registration_endpoint`
2. Client POSTs to `/api/mcp/register` (RFC 7591) → receives `client_id`; public clients omit `client_secret` by sending `token_endpoint_auth_method: "none"`
3. Client opens browser to `/api/mcp/authorize` with PKCE params
4. User sees consent screen at `/{locale}/mcp/authorize`, clicks Allow — **claiming happens here** (the DCR client is bound to the user's tenant at Allow time, not on page load; clicking Deny leaves the client unclaimed so the user can retry)
5. Client receives authorization code, exchanges for `access_token` + `refresh_token`
6. Client uses `access_token` for MCP requests, `refresh_token` for renewal

> **Client types**: Both public clients (`token_endpoint_auth_method: "none"`, e.g. Claude Code CLI) and confidential clients (`client_secret_post`) are supported. Public clients skip `client_secret` at registration and token exchange. Same-name re-registration (e.g. Claude Code retrying) issues a new `client_id` each time — unclaimed duplicates expire after 24h.

#### Refresh Token Rotation

- Each refresh token exchange issues a new access + refresh token pair
- Tokens are grouped by `familyId` for efficient bulk revocation
- Replay detection: if a rotated refresh token is reused, the entire family is revoked
- Refresh tokens expire after 7 days; access tokens after 1 hour

#### DCR Client Lifecycle

- DCR-registered clients start with `tenantId = null` (unclaimed)
- At consent time, the client is "claimed" — bound to the user's tenant
- Unclaimed clients expire after 24 hours (auto-cleanup)
- Rate limited: 20 registrations per IP per hour (IPv6 uses /64 prefix)
- Global cap: 100 unclaimed clients system-wide

### Transport

MCP Server implemented as Next.js API route at `/api/mcp`:
- **POST** — JSON-RPC 2.0 dispatch (initialize, ping, tools/list, tools/call)
- **GET** — SSE endpoint discovery

Rate limited: 60 requests/minute per `client_id`.

### OAuth 2.1 Flow

```
MCP Client                    passwd-sso                      User
    │                              │                            │
    │ GET /api/mcp/authorize       │                            │
    │ + client_id, redirect_uri    │                            │
    │ + code_challenge (S256)      │       Login if needed      │
    │ + scope, state               │ ◄──────────────────────── │
    │──────────────────────────►   │                            │
    │                              │ Redirect with ?code=       │
    │ ◄───────────────────────────────────────────────────────  │
    │                              │                            │
    │ POST /api/mcp/token          │                            │
    │ + code, code_verifier        │                            │
    │ + client_id, client_secret   │                            │
    │──────────────────────────►   │                            │
    │                              │                            │
    │ { access_token: mcp_... }    │                            │
    │ ◄──────────────────────────  │                            │
```

- PKCE S256 required (no plain)
- `client_secret` hashed with SHA-256 (same as SA tokens); omitted for public clients
- Code exchange wrapped in `prisma.$transaction` to prevent replay
- Redirect URIs restricted to `https://` or `http://localhost` / `http://127.0.0.1` (RFC 8252; both localhost forms accepted)

### Tools

| Tool | Required Scope | Returns |
|------|---------------|---------|
| `list_credentials` | `credentials:list` | Metadata only (title, username, urlHost, tags) |
| `search_credentials` | `credentials:list` | Metadata filtered by keyword |

Legacy `credentials:decrypt` scope is expanded to `credentials:list + credentials:use` at consent time.

All tools require an **active delegation session**. The human user selects entries to delegate in the browser, which sends only non-secret metadata (title, username, urlHost, tags) to the server. **Passwords, notes, and full URLs are never sent to the server.**

### Zero-Knowledge Architecture (Phase 7)

| Actor | Responsibility | What it holds | What it never sees |
|-------|---------------|---------------|-------------------|
| Human (Delegation UI) | Decides which entries to allow, for how long | Full vault access | — |
| Server (DelegationSession) | Answers "is this request authorized?" | Metadata + entryIds allowlist | Vault key, plaintext passwords |
| Agent daemon (CLI) | Decrypts when authorized | Vault key in memory | Authorization decisions |
| AI (Claude Code) | Uses credentials via Skill/hook | Metadata + operation results | Plaintext passwords |

**Credential usage flow (Claude Code specific):**
1. Claude Code calls `list_credentials` via MCP → receives metadata only
2. Claude invokes a Bash command (Skill/hook) that pipes the credential through stdin
3. `passwd-sso decrypt` connects to the agent daemon via Unix socket
4. Agent checks authorization with server (`GET /api/vault/delegation/check`)
5. If authorized: agent decrypts locally and returns the field value
6. The credential is consumed in the pipe — **never appears in Claude's conversation context**

### E2E Encryption Strategy

| Phase | Approach | Status |
|-------|----------|--------|
| Phase 3 | Encrypted data only — AI agents receive ciphertext | Implemented |
| Phase 5 | Delegated Decryption — browser relays metadata to MCP session | Implemented |
| Phase 7 | Zero-Knowledge CLI Decrypt — agent daemon, no plaintext to server or AI | Implemented |

**Why not decrypt server-side?** The server has never had access to plaintext passwords — that's the core security guarantee. Phase 7 extends this: even the MCP client (AI) never sees plaintext. Decryption happens in the CLI agent daemon process, and credentials are consumed in Unix pipes without reaching the LLM context.

## Unified Audit

### Actor Types

| ActorType | When |
|-----------|------|
| `HUMAN` | Session, API key, extension token actions (default) |
| `SERVICE_ACCOUNT` | SA token actions |
| `MCP_AGENT` | Reserved for future MCP-specific tracking |
| `SYSTEM` | Reserved for system-initiated actions |

### Schema Extension

```sql
ALTER TABLE audit_logs ADD COLUMN actor_type TEXT NOT NULL DEFAULT 'HUMAN';
ALTER TABLE audit_logs ADD COLUMN service_account_id UUID NULL;
CREATE INDEX idx_audit_logs_actor_type ON audit_logs(actor_type, tenant_id, created_at DESC);
```

Existing audit logs are unaffected — `DEFAULT 'HUMAN'` handles backfill.

### Filtering

Tenant audit log UI includes an actor type filter dropdown. The API accepts an optional `actorType` query parameter with allowlist validation.

## Security Considerations

1. **E2E encryption maintained** — MCP Gateway returns encrypted data only
2. **Scope validation** — SA token scopes use enumerated allowlist; forbidden scopes structurally excluded
3. **Auth dispatch safety** — Prefix table prevents unknown token types from falling through
4. **OAuth 2.1 compliance** — PKCE S256, code replay prevention via $transaction, redirect URI scheme restriction
5. **Rate limiting** — Per client_id on MCP endpoints, per tenant on approve/deny, per SA on JIT requests
6. **Tenant isolation** — All models carry `tenantId`; RLS defense-in-depth on MCP client routes
7. **Token lifecycle** — Deactivation immediately rejects all tokens; hard delete cascades
8. **JIT atomicity** — Single transaction + optimistic lock prevents double-approval

## Database Models

| Model | Purpose |
|-------|---------|
| `ServiceAccount` | Non-human identity (tenant-scoped) |
| `ServiceAccountToken` | Bearer token for SA auth (SHA-256 hashed) |
| `AccessRequest` | JIT access request (PENDING → APPROVED/DENIED/EXPIRED) |
| `McpClient` | OAuth 2.1 client registration |
| `McpAuthorizationCode` | PKCE authorization code (5-min expiry) |
| `McpAccessToken` | MCP access token (1-hour expiry); cascade-deletes associated `DelegationSession` records on client deletion |

## Connecting with Claude Desktop

### Step 1: Register MCP Client

Tenant Settings → Machine Identity → MCP Clients → **Register MCP Client**

- **Name:** `claude-desktop`
- **Redirect URIs:** `http://localhost:3000/callback`
- **Scopes:** `credentials:list`, `credentials:read`

Save the displayed `clientId` (`mcpc_...`) and `clientSecret`. The secret is shown only once.

### Step 2: Generate PKCE Pair

```bash
CODE_VERIFIER=$(openssl rand -base64 32 | tr -d '=/+' | head -c 43)
CODE_CHALLENGE=$(echo -n "$CODE_VERIFIER" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')
echo "verifier: $CODE_VERIFIER"
echo "challenge: $CODE_CHALLENGE"
```

Example output:

```
verifier: dzL9LSiSzjPKnpty5wHM7kRWzlsV4ocdsJ1O31TTeI
challenge: 1QqV6dforNv_7P9vVt611sRQDJ3SnU6jHJAbSV6bBuU
```

### Step 3: Authorize (Browser)

Open this URL in a browser where you are logged into passwd-sso:

```
https://<your-server>/api/mcp/authorize?\
  client_id=mcpc_<your-client-id>&\
  redirect_uri=http://localhost:3000/callback&\
  response_type=code&\
  scope=credentials:list%20credentials:read&\
  code_challenge=<CODE_CHALLENGE>&\
  code_challenge_method=S256&\
  state=test
```

The browser redirects to `http://localhost:3000/callback?code=<AUTH_CODE>&state=test`. Copy the `code` value from the URL.

### Step 4: Exchange Code for Token

```bash
curl -k -X POST https://<your-server>/api/mcp/token \
  -H "Content-Type: application/json" \
  -d '{
    "grant_type": "authorization_code",
    "code": "<AUTH_CODE>",
    "redirect_uri": "http://localhost:3000/callback",
    "client_id": "mcpc_<your-client-id>",
    "client_secret": "<your-client-secret>",
    "code_verifier": "<CODE_VERIFIER>"
  }'
```

Response:

```json
{
  "access_token": "mcp_7Ui7VGT...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "scope": "credentials:list,credentials:read"
}
```

### Step 5: Configure Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `~/.config/Claude/claude_desktop_config.json` (Linux):

```json
{
  "mcpServers": {
    "passwd-sso": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://<your-server>/api/mcp",
        "--header",
        "Authorization: Bearer mcp_<your-access-token>"
      ],
      "env": {
        "NODE_TLS_REJECT_UNAUTHORIZED": "0"
      }
    }
  }
}
```

> **Note:** `NODE_TLS_REJECT_UNAUTHORIZED=0` is needed for self-signed certificates. Remove in production with a valid TLS certificate.

Restart Claude Desktop. The MCP tools panel should show 3 tools:

- `list_credentials` — List encrypted credential entries
- `get_credential` — Get a single encrypted entry by ID
- `search_credentials` — Search encrypted overviews

### What You Can Do

Claude can query your vault metadata (entry count, folder distribution, timestamps) but **cannot read plaintext passwords** — all data is E2E encrypted. This is by design.

| Capability | Status |
|-----------|--------|
| List delegated entries (plaintext) | ✅ Working |
| Get delegated entry (plaintext) | ✅ Working |
| Read plaintext passwords | ✅ Via Delegated Decryption (requires active delegation session) |
| Create/update entries | ❌ Not yet implemented |
| Team vault access | ❌ Requires ECDH key distribution to SA |
