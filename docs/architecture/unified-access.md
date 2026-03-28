# Unified Access: AI Agent Identity & MCP Gateway

## Overview

passwd-sso's Unified Access feature enables AI agents and automated systems to interact with the password vault alongside human users, while preserving the zero-knowledge encryption model.

Inspired by [1Password's Unified Access](https://1password.com/product/unified-access), this feature introduces non-human identities as first-class entities with scoped access, approval workflows, and unified audit tracking.

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
     │                           Unified Access → Access Requests
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
- `client_secret` hashed with SHA-256 (same as SA tokens)
- Code exchange wrapped in `prisma.$transaction` to prevent replay
- Redirect URIs restricted to `https://` or `http://localhost` (RFC 8252)

### Tools

| Tool | Required Scope | Returns |
|------|---------------|---------|
| `list_credentials` | `credentials:list` | Encrypted overviews (metadata) |
| `get_credential` | `credentials:read` | Encrypted blob (full entry) |
| `search_credentials` | `credentials:list` | Encrypted overviews for client-side search |

All tools return **encrypted data only** — the server never decrypts. This preserves the zero-knowledge model.

### E2E Encryption Strategy

| Phase | Approach | Status |
|-------|----------|--------|
| Phase 3 (current) | Encrypted data only — AI agents receive ciphertext | Implemented |
| Phase 5 (future) | Delegated Decryption — human unlocks vault, browser relays plaintext to MCP session | Planned |

**Why not decrypt server-side?** The server has never had access to plaintext passwords — that's the core security guarantee. Breaking this would require storing the encryption key server-side, which defeats zero-knowledge.

**Delegated Decryption** solves this by keeping decryption in the browser: the human user unlocks their vault, and the browser-side code selectively shares plaintext entries with the MCP session — with explicit per-entry consent.

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
| `McpAccessToken` | MCP access token (1-hour expiry) |

## Connecting with Claude Desktop

### Step 1: Register MCP Client

Tenant Settings → Unified Access → MCP Clients → **Register MCP Client**

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
| List entries (encrypted overviews) | ✅ Working |
| Get entry (encrypted blob) | ✅ Working |
| Read plaintext passwords | ❌ Requires Delegated Decryption (Phase 5) |
| Create/update entries | ❌ Not yet implemented |
| Team vault access | ❌ Requires ECDH key distribution to SA |
