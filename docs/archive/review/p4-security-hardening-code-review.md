# Code Review: p4-security-hardening
Date: 2026-03-26T00:00:00+09:00
Review round: 1

## Changes from Previous Round
Initial review

## Functionality Findings
- **F1 (Minor)**: `dispatcher.close()` → `destroy()` for single-use per-attempt dispatcher → RESOLVED
- **F2 (Minor)**: tenant null case could allow sign-in on FK orphan → RESOLVED: strengthened guard to `!existingUser.tenant || !existingUser.tenant.isBootstrap`
- **F3 (Minor)**: Rate limit key shared across session + extension token auth → DISMISSED (intentional per-user design)
- **F4 (Minor)**: Inner `$transaction` atomicity relies on proxy behavior → DISMISSED (informational, correct behavior)

## Security Findings
- **S1 (Minor)**: Invalid IPv4 literal passthrough → DISMISSED (undici rejects at TCP level, no SSRF risk)
- **S2 (Minor)**: DELETE no rate limit → DISMISSED (session-only, intentional design)
- **S3 (Minor)**: @ts-expect-error Node.js API risk → DISMISSED (test coverage detects regressions)

## Testing Findings
- **T1 (Major)**: Rate-limit mock missing in passwords tests → RESOLVED: added mock + 429 tests to both route.test.ts and [id]/route.test.ts
- **T2 (Major)**: SSRF defense test missing → RESOLVED: added 4 test cases (private IP, metadata IP, empty DNS, loopback)
- **T3 (Minor)**: Test naming for transaction order → RESOLVED: renamed to "calls deleteMany before create"

## Adjacent Findings
None

## Resolution Status
### F1 Minor: dispatcher.close() → destroy()
- Action: Changed `await dispatcher?.close()` to `dispatcher?.destroy()`
- Modified file: src/lib/webhook-dispatcher.ts:211

### F2 Minor: tenant null guard strengthened
- Action: Changed condition to also reject when `!existingUser.tenant`
- Modified file: src/app/api/auth/passkey/verify/route.ts:86

### T1 Major: Rate-limit mock + 429 tests
- Action: Added mockRateLimiterCheck + vi.mock + 429 test cases
- Modified files: src/app/api/passwords/route.test.ts, src/app/api/passwords/[id]/route.test.ts

### T2 Major: SSRF defense tests
- Action: Added 4 SSRF defense test cases in new describe block
- Modified file: src/lib/webhook-dispatcher.test.ts

### T3 Minor: Test naming
- Action: Renamed test from "deletes existing sessions before creating new one (within same transaction)" to "calls deleteMany before create"
- Modified file: src/app/api/auth/passkey/verify/route.test.ts
