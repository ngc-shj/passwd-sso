# Code Review: dcr-native-oauth
Date: 2026-03-29
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings

### [F-01] Critical: Claiming doesn't enforce MAX_MCP_CLIENTS_PER_TENANT
- File: src/app/[locale]/mcp/authorize/page.tsx:76-98
- Merged with: S-04

### [F-02] Critical: MCP_CLIENT_DCR_CLAIM audit log never dispatched
- File: src/app/[locale]/mcp/authorize/page.tsx:87-98

### [F-03] Critical: MCP_CONSENT_DENY audit log never dispatched (client-side deny)
- File: src/app/[locale]/mcp/authorize/consent-form.tsx:72-77
- Merged with: S-08

### [F-04] Critical: DCR register count+create not in $transaction (TOCTOU)
- File: src/app/api/mcp/register/route.ts:126-158
- Merged with: S-03

### [F-05] Major: team:credentials:read scope rejected by scope-parser allowlist
- File: src/lib/scope-parser.ts:68-94

### [F-06] Major: IP rate limiter not applied to authorization_code grant
- File: src/app/api/mcp/token/route.ts:31-76
- Merged with: S-06

### [F-07] Major: Refresh token exchange doesn't emit audit logs
- File: src/lib/mcp/oauth-server.ts + src/app/api/mcp/token/route.ts

### [F-08] Critical: Claiming race condition — no CAS guard (cross-tenant hijack)
- File: src/app/[locale]/mcp/authorize/page.tsx:76-98
- Merged with: S-01

### [F-09] Major: consent/route.ts doesn't verify DCR client is claimed
- File: src/app/api/mcp/authorize/consent/route.ts:47-57
- Merged with: S-05

### [F-10] Major: Scope descriptions hardcoded English in consent-form.tsx
- File: src/app/[locale]/mcp/authorize/consent-form.tsx:18-22

### [F-11] Minor: localhost vs 127.0.0.1 inconsistency in admin API
- File: src/components/settings/mcp-client-card.tsx:60-69

## Security Findings

### [S-02] Critical: Consent POST has no CSRF protection
- File: src/app/api/mcp/authorize/consent/route.ts

### [S-07] Medium: IPv6 loopback (::1) not supported in DCR redirect_uri
- File: src/app/api/mcp/register/route.ts:31

## Testing Findings

### [T-01] High: refresh_token grant tests completely missing
- File: src/app/api/mcp/token/route.test.ts

### [T-02] High: invalid_client 401 status code untested for refresh_token
- File: src/app/api/mcp/token/route.test.ts

### [T-03-T-07] Medium: Various coverage gaps (revokedAt filter, replacedByHash, DCR null tenant, scope normalization, isDcr UI)

### [T-08-T-11] Low: Minor test improvements

## Resolution Status
Pending fixes.
