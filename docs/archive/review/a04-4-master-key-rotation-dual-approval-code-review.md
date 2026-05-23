# Code Review: a04-4-master-key-rotation-dual-approval

Date: 2026-05-23
Review round: 1 (Phase 3)

## Changes from Previous Round
Initial Phase 3 review. Plan v3 + Round 1+2 plan findings already applied in Phase 2.

## Functionality Findings

### F1 Major — `master_key_rotations` missing from `scripts/rls-cross-tenant-tables.manifest` + `rls-cross-tenant-seed.sql`
Migration enables FORCE RLS + tenant_isolation policy but the discovery-vs-manifest cross-check is missing. Plan C1.AC5 mandates both files updated.

### F2 Major — C9 real-DB integration test missing
`src/__tests__/db-integration/master-key-rotation-dual-approval.integration.test.ts` does not exist. Race-safety claims (parallel approve / parallel execute / self-approval / cross-tenant CAS) have no real-DB validation. **Disposition: defer with explicit Out-of-Scope entry — too large for this PR; documented in plan v3 OOS section + tracked as follow-up.**

### F3 Major — Initiate route hardcodes notification title/body strings inline
Plan C12 mandates notification copy lives in `notification-messages.ts`; the entry was added but route never uses it (dead code). Two sources of truth for the same copy.

### F4 Minor — `ROTATION_TOTAL_TTL_MS` constant not added; route reuses `RESET_TOTAL_TTL_MS`
Plan C11.AC1 mandates a new constant. Numeric value identical today; future divergence risk.

### F5 Minor — Missing Vitest tests: expiry (D), approved→revoked (C), `.strict()` on approve/revoke
Plan C8 scenario→test mapping rows D and C have no tests; `.strict()` rejection only tested on initiate.

### F6 Minor — Stale `check-bypass-rls.mjs` allowlist entry for legacy 410 endpoint
The legacy route is now 410 Gone with no `withBypassRls` call; the allowlist entry is dead.

### F7 Minor — Approve route parses body but discards `reason`
Body schema accepts `reason` but value is never propagated to audit metadata. Asymmetry with revoke (which carries reason).

### F8 Info — `requireMaintenanceOperator` returns 400, not 403 (pre-existing AdminVaultReset inheritance)
Plan claims 403; real return is 400 (VALIDATION_ERROR). Out of scope for A04-4 (pre-existing across all maintenance routes).

### F9 Minor — Approve/revoke body parser content-length-gated
Chunked-encoding clients (no Content-Length header) bypass the Zod `.strict()` check. Surface tiny because only `reason?: string` in schema.

## Security Findings

### S1 Major — Same as F1 (RLS manifest + seed-SQL missing)
Cross-referenced with F1.

### S2 Major — Execute route silently drops `MASTER_KEY_ROTATION_EXECUTE` audit if `passwordShare.updateMany` throws
CAS commits `executedAt = now` first; then `withBypassRls(passwordShare.updateMany)` runs. If that throws, the rotation row is in `executed` state with NO audit row. Forensic gap on the most destructive action's error path.

### S3 Minor — `FORBIDDEN_CROSS_TENANT` forensic-audit branch is unreachable under RLS
`findFirst` under `withTenantRls(actor.tenantId, ...)` filters by RLS, so a cross-tenant rotationId returns null → route 404s before reaching the eligibility helper. The promised 403 + FORBIDDEN_CROSS_TENANT audit only fires if RLS regresses. Manual-test step A1 (cross-tenant op_* replay) actually produces 404.

### S4 Minor — Same as F4 (ROTATION_TOTAL_TTL_MS missing)

### S5 Minor — Same as F3 (notification strings inlined)

### S6 Info — Same as F9 (content-length-gated parse)

### S7 Info — Execute route's `revokedShares` row update uses unguarded `update` instead of CAS
Earlier CAS already guarantees uniqueness; the unguarded write is safe by construction. Cosmetic.

## Testing Findings

### T11-FU Major — Notification recipient-enumeration failure not asserted
`notifyOtherAdmins` wraps `tenantMember.findMany` in try/catch. No test forces `mockTenantMemberFindMany.mockRejectedValueOnce(...)` and asserts the route still returns 201. Future refactor that removes the try/catch would silently break R9 fire-and-forget contract.

### T-CT Major — Execute and revoke routes lack CROSS_TENANT-branch route tests
Only approve has the cross-tenant test. Execute and revoke each have dedicated CROSS_TENANT branches with audit emission, but no end-to-end mock test.

### T-EX-UP Minor — `mockUpdate` (record-revokedShares-on-row) is never asserted in execute test
The route's second `tx.masterKeyRotation.update(...)` call inside its own try/catch is untested in both success and failure paths.

### T-S15 Minor — Sub-cause warn-log contract (`subCause: "race_or_terminal"`) has no test
Logger is mocked as fresh per-invocation, can never be captured. Plan v3 S15 promises operational logging — unmonitored.

### T-C9-Deferral Info — C9 deferral not listed in plan's Out-of-Scope block
Doc nit; cross-references F2.

## Adjacent Findings
None — no [Adjacent] tags reported.

## Quality Warnings
None — all findings have file:line, evidence, and concrete fix.

## Recurring Issue Check
### Functionality expert
- R9 fire-and-forget in tx: OK
- R10 circular import: OK
- R11 display vs subscription group: OK
- R12 action coverage: OK
- R13 delivery-failure loop: N/A
- R14 DB role + RLS: F1
- R15 hardcoded env values: OK
- R29 external standard citation: N/A
- R34 Anti-Deferral: F2 (deferred — documented)
- R35 manual-test for security change: OK

### Security expert
- R9-R15, R29: same as Functionality
- R34 Anti-Deferral: OK
- R35: OK
- RS1 timing-safe comparison: N/A
- RS2 rate limit on new routes: OK (per-actor + failClosedOnRedisError)
- RS3 input validation at boundaries: F9/S6 (content-length gating)
- RS4 personal-identifying data in artifacts: OK (placeholders in C10)

### Testing expert
- R1-R37: see test review
- RT1 mock-reality alignment: OK
- RT2: OK
- RT3 no shared mutable state: OK
- RT4 race vacuous-pass guard: F2 (C9 deferred)
- RT5 test call-path includes primitive: OK

## Resolution Status
(Updated after Phase 3 fixes — see below)
