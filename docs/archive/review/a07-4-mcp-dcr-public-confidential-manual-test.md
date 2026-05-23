# A07-4 — Manual smoke test plan

Run these after deploying A07-4 to verify end-to-end behaviour. Each step
includes the expected DB / response state.

## Prerequisites

- Dev stack running: `npm run docker:up` + dev server (`npm run dev`).
- `curl` and `jq` available.
- Pre-1.0 dev DB: no migration to run; the public/confidential split is
  enforced at the API layer only.

## Step 1 — CLI public DCR end-to-end

```bash
# Wipe any cached credentials so the CLI re-registers.
rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/passwd-sso"

passwd-sso login
# Browser opens; complete OAuth consent.
```

**Expected**:
- CLI writes `$XDG_DATA_HOME/passwd-sso/credentials` (mode 0o600).
- File contains `"access_token": "mcp_..."` and `"refresh_token": "mcpr_..."`.
- File does NOT contain `"client_secret"` (public client).
- DB: `mcp_clients` row created via DCR has `client_secret_hash = ''` and
  `is_active = true`.

## Step 2 — Confidential DCR rejection (the core A07-4 hardening)

```bash
curl -sS -X POST http://localhost:3000/api/mcp/register \
  -H "Content-Type: application/json" \
  -d '{
    "client_name": "Smoke-Test-Confidential",
    "redirect_uris": ["http://localhost:9999/callback"],
    "token_endpoint_auth_method": "client_secret_post"
  }' | jq
```

**Expected**:
- HTTP `400`.
- Body: `{ "error": "invalid_client_metadata", "error_description": "token_endpoint_auth_method must be 'none' (DCR issues public clients only — RFC 9700 §4.14)", "issues": [...] }`.
- DB: no new `mcp_clients` row.

## Step 3 — Wrong-shape rejection (defense-in-depth)

```bash
# Absent field
curl -sS -X POST http://localhost:3000/api/mcp/register \
  -H "Content-Type: application/json" \
  -d '{"client_name":"X","redirect_uris":["http://localhost:9999/cb"]}' | jq .error

# Wrong case
curl -sS -X POST http://localhost:3000/api/mcp/register \
  -H "Content-Type: application/json" \
  -d '{"client_name":"X","redirect_uris":["http://localhost:9999/cb"],"token_endpoint_auth_method":"None"}' | jq .error
```

**Expected**: Both return `"invalid_client_metadata"`.

## Step 4 — Admin console confidential client create

1. Sign in to `/dashboard/tenant/mcp-clients` as a tenant OWNER or ADMIN.
2. Click "Create MCP client" (or equivalent UI control).
3. Complete step-up reauth (passkey) if prompted.
4. Confirm the response includes `client_secret` (only shown once).

**Expected**:
- DB: `mcp_clients` row with `client_secret_hash != ''`, `is_dcr = false`,
  `is_active = true`, `tenant_id` = current tenant.
- Subsequent token exchange via `POST /api/mcp/token` with
  `client_secret_post` succeeds.

## Step 5 — DCR claim flow still works post-A07-4

1. Register a public DCR client via Step 1 (or `curl` Step 2 minus the bad
   field).
2. Initiate the authorize flow:
   `GET /api/mcp/authorize?client_id=<the-dcr-client_id>&redirect_uri=...&...`.
3. After login, complete the consent form. The consent route claims the
   unclaimed DCR client to the current tenant (`tenantId` set, `dcrExpiresAt` may
   be cleared or kept).

**Expected**:
- DB: `mcp_clients` row's `tenant_id` flips from `NULL` to the current tenant.
- Consent succeeds (no `invalid_client` error).
- This confirms that adding `isActive: true` to `/api/mcp/authorize`'s
  `validateOAuthRequest` does NOT regress the claim flow (`is_active` defaults
  to `true` on creation).

## Step 6 — Defense-in-depth: deactivate confidential client

1. Use the admin client created in Step 4. Call `POST /api/mcp/token` to
   issue a token successfully.
2. As admin, flip `is_active = false` for that client (via UI or directly
   in DB).
3. Repeat any MCP JSON-RPC request with the previously-issued access token.

**Expected**:
- After deactivation, the JSON-RPC request returns `invalid_token`
  immediately (no TTL wait). This validates the new `validateMcpToken`
  `isActive` check (third McpClient lookup site, per CS-M1 fix).
- New authorize/token attempts for the same `client_id` return
  `invalid_request` / `invalid_client` envelopes.

## Acceptance

All 6 steps pass with the expected responses. Record any divergence in this
file under a "Findings" section before merging.
