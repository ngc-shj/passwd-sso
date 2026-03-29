# Coding Deviation Log: dcr-native-oauth
Created: 2026-03-29

## Deviations from Plan

### D-1: Public client support (token_endpoint_auth_method: "none")
- **Plan description**: DCR generates client_secret for all clients; token exchange requires client_secret
- **Actual implementation**: Support `token_endpoint_auth_method: "none"` — no secret generated, token exchange skips secret validation for public clients (clientSecretHash === "")
- **Reason**: Claude Code uses public client OAuth (no client_secret). Discovered during real-world testing
- **Impact scope**: register/route.ts, token/route.ts, oauth-server.ts (exchangeCodeForToken, exchangeRefreshToken), discovery endpoint

### D-2: localhost accepted in redirect_uris (not just 127.0.0.1)
- **Plan description**: DCR redirect_uris accept `http://127.0.0.1:PORT/` only (RFC 8252 §7.3)
- **Actual implementation**: Accept `http://localhost:PORT/`, `http://127.0.0.1:PORT/`, and `http://[::1]:PORT/`
- **Reason**: Claude Code sends `http://localhost:PORT/callback`. RFC 8252 recommends 127.0.0.1 but real clients use localhost
- **Impact scope**: register/route.ts (LOOPBACK_REDIRECT_RE), proxy.ts (CSP form-action)

### D-3: DCR claiming moved from page render to consent POST
- **Plan description**: Claiming happens in consent page (page.tsx) at render time
- **Actual implementation**: Claiming happens in POST /api/mcp/authorize/consent (Allow action only)
- **Reason**: Page-render claiming caused deny → retry to fail with name_conflict (client already claimed by first attempt's page render)
- **Impact scope**: page.tsx (simplified), consent/route.ts (claiming logic added)

### D-4: Same-name DCR client reuse
- **Plan description**: Name uniqueness enforced; conflict returns error
- **Actual implementation**: If a same-name DCR client already exists in the tenant, the new unclaimed duplicate is deleted and the existing one is reused for authorization
- **Reason**: Claude Code registers a new client on each auth attempt with the same name. Without reuse, every retry after deny would fail
- **Impact scope**: consent/route.ts (reuse logic in claiming transaction)

### D-5: MCP_CLIENT_DCR_CLEANUP audit action (not in plan)
- **Plan description**: Plan listed 6 new audit actions
- **Actual implementation**: Added 7th action MCP_CLIENT_DCR_CLEANUP for the maintenance endpoint
- **Reason**: Consistency with other maintenance endpoints that log their operations
- **Impact scope**: audit.ts, schema.prisma (AuditAction enum), i18n

### D-6: DelegationSession onDelete changed from Restrict to Cascade
- **Plan description**: Not covered in plan
- **Actual implementation**: Changed DelegationSession.mcpAccessToken FK from onDelete: Restrict to Cascade
- **Reason**: MCP client deletion failed with FK constraint violation (delegation_sessions referenced mcp_access_tokens)
- **Impact scope**: schema.prisma, migration 20260329110000

### D-7: CSP form-action localhost only in dev mode
- **Plan description**: Not covered in plan
- **Actual implementation**: `form-action 'self' http://localhost:* http://127.0.0.1:* http://[::1]:*` only in non-production mode
- **Reason**: OAuth callback redirects to localhost (Claude Code's local server). In production, the consent form redirects to the client's registered redirect_uri which is on localhost — but CSP form-action also governs the POST target and redirect chain. Production clients use HTTPS redirect_uris
- **Impact scope**: proxy.ts
