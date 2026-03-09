# Code Review: tenant-access-restriction
Date: 2026-03-10T01:00:00+09:00
Review round: 2

## Changes from Previous Round
Initial review

## Functionality Findings

### F1 [Major] Null clientIp silently bypasses access restriction
- File: src/proxy.ts:71-88, 170-185
- Problem: When `extractClientIp()` returns null, the access restriction check is skipped entirely
- Impact: In environments where IP cannot be determined, restrictions are bypassed
- Recommended: Deny access when IP is null and tenant has restrictions configured
- Also flagged by: Security expert (S1)

### F2 [Major] Bearer/APIv1/SCIM routes not subject to access restriction
- File: src/proxy.ts:106-138
- Problem: Plan requires these routes to have access restriction in route handlers, but implementation only covers session-authenticated routes
- Impact: Token-based access bypasses network restrictions entirely
- Recommended: Add `withAccessRestriction` wrapper to route handlers for these paths
- Also flagged by: Security expert (S2)

### F3 [Minor] tailscaleEnabled:true requires tailscaleTailnet in same request
- File: src/app/api/tenant/policy/route.ts:145-148
- Problem: Sending only `{ tailscaleEnabled: true }` fails if tailscaleTailnet not included, even when DB already has it
- Recommended: Check DB for existing value if tailscaleTailnet not in request

### F4 [Minor] Client-side CIDR validation is less strict than server-side
- File: src/components/settings/tenant-access-restriction-card.tsx:34
- Recommended: Show server error message or add stricter client validation

### F5 [Minor] Tenant resolution overhead for non-restricted tenants
- File: src/proxy.ts:220-227
- Recommended: Acceptable, cached. Monitor later.

## Security Findings

### S3 [Minor] Tailscale WhoIs cache FIFO eviction susceptible to poisoning
- File: src/lib/tailscale-client.ts:34-41
- Recommended: Consider LRU or separate positive/negative caches

### S4 [Minor] Raw user input reflected in CIDR error response
- File: src/app/api/tenant/policy/route.ts:134
- Recommended: Truncate reflected value

### S5 [Minor] Invalid TRUSTED_PROXIES entries silently dropped
- File: src/lib/ip-access.ts:15-27
- Recommended: Log warning for unparseable entries

## Testing Findings

### T1 [Major] extractClientIp has zero test coverage
- File: src/__tests__/lib/ip-access.test.ts
- Recommended: Add comprehensive unit tests for rightmost-untrusted, trusted proxy, normalization

### T2 [Major] Self-lockout detection path (409) untested
- File: src/__tests__/api/tenant/tenant-policy.test.ts
- Recommended: Add tests for 409 response and confirmLockout override

### T3 [Major] Proxy access restriction integration untested
- File: src/__tests__/proxy.test.ts
- Recommended: Add tests for 403 on denied IP, tenant resolution, null clientIp handling

### T4 [Minor] checkAccessRestrictionWithAudit untested
- File: src/__tests__/lib/access-restriction.test.ts
- Recommended: Add audit log emission verification

### T5 [Minor] Tailscale cache eviction and invalid JSON untested
- File: src/__tests__/lib/tailscale-client.test.ts
- Recommended: Add edge case tests

### T6 [Minor] isValidCidr mock in tenant-policy test is oversimplified
- File: src/__tests__/api/tenant/tenant-policy.test.ts:57-58
- Recommended: Use real implementation instead of mock

## Resolution Status

### F1 [Major] Null clientIp silently bypasses access restriction
- Action: Changed `checkAccessRestriction` to accept `string | null` clientIp; denies when null and restrictions are active. Removed `if (clientIp)` guard in proxy.ts.
- Modified files: src/lib/access-restriction.ts, src/proxy.ts

### F2 [Major] Bearer/APIv1/SCIM routes not subject to access restriction
- Action: Created `enforceAccessRestriction()` helper and applied it to all 27 handler functions across 11 route files (passwords, v1/passwords, v1/tags, v1/vault/status, vault/status, vault/unlock/data, scim/v2/Users, scim/v2/Groups).
- Modified files: src/lib/access-restriction.ts, 11 route handler files + corresponding test files

### F3 [Minor] tailscaleEnabled:true requires tailscaleTailnet in same request
- Action: When `tailscaleTailnet` is undefined in request body, now queries DB for existing value before rejecting.
- Modified file: src/app/api/tenant/policy/route.ts

### F4 [Minor] Client-side CIDR validation is less strict than server-side
- Action: Deferred — server-side validation is authoritative; client shows server error messages on failure. Low risk.

### F5 [Minor] Tenant resolution overhead for non-restricted tenants
- Action: Deferred — acceptable with caching. Monitor in production.

### S3 [Minor] Tailscale WhoIs cache FIFO eviction susceptible to poisoning
- Action: Deferred — FIFO is acceptable for initial release. Cache size (100) limits impact. Can upgrade to LRU later.

### S4 [Minor] Raw user input reflected in CIDR error response
- Action: Truncated reflected CIDR value to 45 characters in error response.
- Modified file: src/app/api/tenant/policy/route.ts

### S5 [Minor] Invalid TRUSTED_PROXIES entries silently dropped
- Action: Added `console.warn` for unparseable TRUSTED_PROXIES entries.
- Modified file: src/lib/ip-access.ts

### T1 [Major] extractClientIp has zero test coverage
- Action: Added 7 comprehensive unit tests covering: null when no headers, x-real-ip fallback, rightmost untrusted from XFF, trusted proxy skip, all-trusted leftmost, IPv4-mapped normalization, single IP XFF.
- Modified file: src/__tests__/lib/ip-access.test.ts

### T2 [Major] Self-lockout detection path (409) untested
- Action: Added 2 tests: 409 when wouldIpBeAllowed returns false, 200 with confirmLockout override.
- Modified file: src/__tests__/api/tenant/tenant-policy.test.ts

### T3 [Major] Proxy access restriction integration untested
- Action: Added 4 tests: 403 on denied API route, 200 on allowed, skip when no tenant, 403 on denied dashboard route.
- Modified file: src/__tests__/proxy.test.ts

### T4 [Minor] checkAccessRestrictionWithAudit untested
- Action: Added 3 tests: audit log emitted on denial, no audit on allow, denial + audit when clientIp is null.
- Modified file: src/__tests__/lib/access-restriction.test.ts

### T5 [Minor] Tailscale cache eviction and invalid JSON untested
- Action: Deferred — low risk edge cases. Can be added incrementally.

### T6 [Minor] isValidCidr mock in tenant-policy test is oversimplified
- Action: Replaced simplified regex mock with real implementation via `vi.importActual`.
- Modified file: src/__tests__/api/tenant/tenant-policy.test.ts

## Round 2 Findings

### R2-F1 [Minor] IPv6 socket trust check uses incorrect CIDR format
- File: src/lib/ip-access.ts:257
- Problem: Socket trust check joined 16 individual bytes with `:` instead of using `formatCidr()` for proper IPv6 notation
- Impact: IPv6 trusted proxies (e.g., `::1`) not recognized, XFF walking skipped
- Action: Replaced inline formatting with `formatCidr(cidr)` call
- Modified file: src/lib/ip-access.ts
- Also flagged by: Security expert

### R2-S1 [Minor] Self-lockout detection skips when clientIp is null
- File: src/app/api/tenant/policy/route.ts:185
- Problem: When `clientIp` is null, self-lockout check is skipped entirely
- Impact: Admin in proxy environment with unknown IP could lock themselves out
- Action: Fixed — now returns 409 SELF_LOCKOUT when clientIp is null and restrictions are being set
- Modified file: src/app/api/tenant/policy/route.ts
- Test added: src/__tests__/api/tenant/tenant-policy.test.ts (409 when clientIp null)
