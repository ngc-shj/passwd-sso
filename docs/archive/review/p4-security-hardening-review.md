# Plan Review: p4-security-hardening
Date: 2026-03-26T00:00:00+09:00
Review rounds: 2

## Changes from Previous Round
Round 1: Initial review
Round 2: Addressed https.Agent→undici.Agent, atomic session transaction, IPv4-mapped IPv6, rate limit adjustment, agent lifecycle

## Functionality Findings

### Round 1
- **F1 (Major)**: `https.Agent` incompatible with Node.js `fetch` — must use `undici.Agent` with `dispatcher` option → RESOLVED in plan update
- **F2 (Major)**: API key rate limit key design — DISMISSED (userId scope is correct; API keys are per-user)
- **F3 (Major)**: Session deletion outside transaction → RESOLVED: wrapped in `prisma.$transaction()`
- **F4 (Minor)**: Sends JSDoc duplication → RESOLVED: kept minimal

### Round 2
- **M1 (Minor)**: undici.Agent resource leak — must `agent.close()` in finally block → RESOLVED in plan update

## Security Findings

### Round 1
- **S1 (Major)**: HTTP redirect bypass SSRF → Already mitigated by `redirect: "error"` in existing code
- **S2 (Minor)**: `GET /api/passwords/[id]` rate limit too generous → RESOLVED: reduced to 60/min
- **S4 (Major)**: Session deletion race condition → RESOLVED: atomic transaction
- **S5 (Major)**: IPv4-mapped IPv6 BLOCKED_CIDRS bypass → RESOLVED: `::ffff:0:0/96` added

### Round 2
- **N1 (Minor)**: vault/unlock/data rate limit concern — Out of scope (existing endpoint, separate commit)
- **N2 (Minor)**: undici as transitive dependency — Confirmed available via `require('undici')`
- **N3 (Major)**: TOCTOU DNS rebinding "unresolved" — DISMISSED: expert reviewed existing code, not the planned `undici.Agent` with `connect.lookup` which replaces DNS resolution at connection time

## Testing Findings

### Round 1
- **T1 (Critical)**: No SSRF prevention tests → RESOLVED in plan testing strategy
- **T2 (Major)**: Missing passwords/[id] rate limit tests → RESOLVED in plan testing strategy
- **T3 (Major)**: Session deletion order not tested → RESOLVED in plan testing strategy
- **T4 (Minor)**: No assertPublicHostname unit tests → RESOLVED in plan testing strategy

### Round 2
- T1/T2/T4: Expert reviewed existing code (pre-implementation), not the plan. These tests will be created in Phase 2.
- T3: Audit action name confirmed as `SESSION_REVOKE_ALL` (exists in schema and docs). Call order verification via `vi.fn()` invocationCallOrder noted for implementation.

## Adjacent Findings
None
