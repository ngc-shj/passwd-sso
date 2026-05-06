# Security Credential Issuance Hardening Manual Test

Date: 2026-05-06
Branch: `fix/security-network-gates`

## Scope

Tier-2 security changes verified in this branch:

- proxy-enforced tenant access restriction for session-based issuance routes
- recent-session step-up for sensitive credential issuance
- CSRF fail-closed behavior without canonical origin config
- SSRF rejection for hex-form IPv4-mapped IPv6 loopback/private targets

## Manual Test Matrix

1. Session-based issuance routes from allowed tenant network
   Expected:
   - `/api/mcp/authorize`
   - `/api/mcp/authorize/consent`
   - `/api/mobile/authorize`
   proceed when the user has a valid recent session and the request originates from an allowed client IP.

2. Session-based issuance routes from blocked tenant network
   Expected:
   - the same routes return `403 ACCESS_DENIED`
   - proxy audit path records the denial

3. Sensitive issuance after stale session
   Targets:
   - MCP authorize / consent
   - mobile authorize
   - extension bridge-code
   - extension legacy token issuance
   - API key creation via session auth
   - SCIM token creation
   - service-account token creation
   - operator token creation
   - MCP client creation
   - access-request approve
   Expected:
   - returns `403 SESSION_STEP_UP_REQUIRED`
   - operator tokens specifically return `403 OPERATOR_TOKEN_STALE_SESSION`
   - no token / secret / authorization artifact is minted

4. Service-account token listing with stale session
   Expected:
   - `GET /api/tenant/service-accounts/:id/tokens` remains readable for authorized users
   - no step-up prompt is required

5. API key creation via extension token auth
   Expected:
   - creation still succeeds for valid extension-token auth
   - recent-session step-up is not applied because there is no browser session to step up

6. CSRF origin without canonical app origin
   Setup:
   - unset `APP_URL` and `AUTH_URL`
   Expected:
   - mutating cookie-auth routes fail closed with `403 INVALID_ORIGIN`
   - spoofed `Host` or `x-forwarded-proto` headers do not restore access

7. External delivery SSRF guard
   Targets:
   - direct URL literals such as `https://[::ffff:7f00:1]/...`
   - DNS answers such as `::FFFF:7F00:1` and `::ffff:7f00:0001`
   Expected:
   - requests are rejected before fetch with private-IP errors

## Evidence

- Automated route/unit coverage was expanded for all paths above.
- Added real-DB contract test:
  - `src/__tests__/db-integration/require-recent-session.integration.test.ts`
