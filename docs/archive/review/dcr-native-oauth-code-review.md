# Code Review: dcr-native-oauth
Date: 2026-03-29
Review rounds: 4

## Summary

4 rounds of expert review (functionality, security, testing) with real-world Claude Code testing.

### Round 1 — Initial review
- Critical 6, Major 7, Minor 15
- Key fixes: atomic CAS claiming, TOCTOU in DCR register, consent CSRF, empty scope guard, IP rate limit for both grants, refresh token audit logs, scope-parser flat scopes

### Round 2 — NIL_UUID unification + audit fixes
- Unified NIL_UUID constant across 6 files
- Fixed DCR_CLAIM audit (only on actual claim, not already_claimed)
- Fixed replay audit tenantId/familyId from exchangeRefreshToken result
- Replaced custom CSRF with assertOrigin()

### Round 3 — Public client + real-world testing
- Fixed refresh_token grant for public clients (client_secret optional)
- CSP form-action localhost only in dev
- Added public client tests (T-14, T-15), replay audit test (T-13)
- README: added MIGRATION_DATABASE_URL

### Round 4 — Final review
- No Critical/Major/High findings
- Minor: jest.Mock type leak, IP rate limit mock coverage, ROTATE audit test gap

### Post-review (real-world testing)
- basePath support for all MCP endpoints (serverAppUrl, withBasePath, BASE_PATH)
- Tailscale Serve + Apache reverse proxy discovery setup
- DCR redirect_uri: accept localhost (Claude Code uses it)
- Public client support (token_endpoint_auth_method: "none")
- CSP form-action for OAuth callback redirect
- authorize redirect using serverAppUrl (not req.url internal origin)
- Claiming moved from page load to Allow click (deny → retry works)
- Same-name DCR client reuse (Claude Code registers per attempt)
- DelegationSession onDelete: Cascade (FK constraint on client delete)
- i18n: consent page error messages, ボールト → 保管庫

## Deferred (Low)
- S-16: Loopback port range validation (1-65535)
- S-18: APP_URL startup validation
- F-11: Admin API localhost/127.0.0.1 alignment with DCR

## Resolution Status
All Critical, Major, and High findings resolved. Remaining Low items deferred.
