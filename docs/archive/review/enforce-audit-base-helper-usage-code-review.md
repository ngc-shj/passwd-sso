# Code Review: enforce-audit-base-helper-usage
Date: 2026-04-19
Review round: 1

## Changes from Previous Round
Initial review of refactor/enforce-audit-base-helper-usage branch (commit `f62bb988`, 43 files +376 -215).

## Functionality Findings
No findings. All 7 plan-specific obligations verified via targeted greps:
1. Pattern 5 tenantId preservation on PERSONAL emit (vault/delegation/route.ts:211).
2. Pattern 4 tenantId override on TEAM-scope (vault/admin-reset/route.ts:140).
3. Pattern 6 pre-tx extractRequestMeta deletion (share-links/route.ts:185).
4. Pattern 7 extractClientIp direct-use sites migrated (vault/delegation, vault/delegation/check).
5. Bucket C exceptions unchanged (internal/audit-emit, mcp/register).
6. Override ordering verified across 12 sampled sites.
7. Forensic upgrade exceptions (admin/rotate-master-key, mcp/authorize/consent:152) intentional per plan §Functional 2 EXCEPTION.

## Security Findings

[S1] **Minor**: Theoretical scope-downgrade in share-link audit when `teamId` cannot be resolved
- File: src/app/api/share-links/[id]/route.ts:59-61, src/app/api/share-links/route.ts:184-186
- Evidence: New gate `teamPasswordEntryId && teamId ? teamAuditBase(...) : personalAuditBase(...)`. Pre-migration: `scope: teamPasswordEntryId ? TEAM : PERSONAL` with `teamId` passed unconditionally.
- Problem: If `share.teamPasswordEntry?.teamId` is ever null while `teamPasswordEntryId` is set, the new code silently falls back to PERSONAL scope; the original would emit TEAM-scope with `teamId=undefined`.
- Impact: Theoretical only — `teamPasswordEntryId` is a FK; referential integrity prevents the missing relation in normal operation. No exploit path; failure mode would be loss of forensic visibility for a single audit row in a DB-corruption scenario.
- Fix: Optional defensive log/throw if `teamPasswordEntryId && !teamId` (FK invariant violation). Not blocking for merge.

## Testing Findings

[T1] **Major**: No isolated unit tests for `personalAuditBase`/`teamAuditBase`/`tenantAuditBase` helpers
- File: src/lib/audit.ts (helpers near end of file)
- Evidence: Greps across `src/__tests__/` and `src/lib/__tests__/` find zero direct invocations. Only mocked in 18 route tests.
- Problem: The plan introduces these helpers as the canonical entry point for ~40 routes. Mocked-only coverage means a regression in the helper would not be caught.
- Fix: Added `src/__tests__/lib/audit-helpers.test.ts` (10 tests) asserting scope value, required field presence, and forensic-meta propagation including `acceptLanguage`.

[T2] **Minor**: Helper mocks omit `acceptLanguage`, diverging from real helper output shape
- File: 18 modified test files (e.g., src/app/api/admin/rotate-master-key/route.test.ts:37-39)
- Evidence: Real helper returns `{scope,userId,[teamId|tenantId],ip,userAgent,acceptLanguage}` — mocks returned only `{...,ip,userAgent}`.
- Problem: No production code asserts `acceptLanguage` today, but a future test asserting full audit body via deep equality would falsely pass.
- Fix: Added `acceptLanguage: null` to each helper mock across all 18 files.

[T3] **Minor**: Dead `extractRequestMeta:` mock in routes fully migrated to helpers
- File: 16 test files (e.g., src/app/api/admin/rotate-master-key/route.test.ts:36)
- Evidence: Production route.ts files no longer reference `extractRequestMeta`, so the mock entry was unused.
- Fix: Removed `extractRequestMeta` mock entries from 16 files. Also removed the unused `mockExtractRequestMeta` hoisted variable from `mcp/authorize/consent/route.test.ts`.

## Adjacent Findings
None.

## Quality Warnings
None.

## Recurring Issue Check

### Functionality expert
- R3 (pattern propagation): Verified — all 22 modified route.ts files in diff align with Bucket B inventory.
- R10 (override ordering): Verified across 12 sampled sites — all helper-spread first, overrides after.
- R12 (action group coverage): N/A — no new audit actions.
- R1-R2, R4-R9, R11, R13-R30: N/A or verified clean.

### Security expert
- R3 (pattern propagation): Verified — every Bucket B route migrated.
- R-multi-tenant isolation: Sample-checked admin/rotate-master-key, scim/v2/Users/[id], vault/admin-reset — no cross-tenant ID swaps.
- R-anonymous actor (share-links/verify-access): ANONYMOUS_ACTOR_ID + ACTOR_TYPE.ANONYMOUS correctly placed AFTER helper spread.
- R-system actor (Pattern 2): ACTOR_TYPE.SYSTEM after helper spread in all 7 Batch-1 sites.
- R-Bucket C: internal/audit-emit and mcp/register unchanged; no security regression.
- R-Pattern 5 dual-emit: tenantId preserved on PERSONAL emit.
- R-forensic upgrade sites: userAgent ADDITION only behavior change.
- R-CSRF/origin, R-rate-limit ordering: Preserved.
- R29: No new spec citations.
- RS1-RS3: metadata sanitization unchanged; no new sensitive fields.

### Testing expert
- R19/RT1 (mock alignment): Verified across 18 files; T2 acceptLanguage divergence FIXED.
- RT2 (test coverage): Pattern 5 covered, D3 admin-reset test correct.
- RT3 (regression risk): D3 change correctly preserves coverage via `lastCall?.teamId).toBeUndefined()`.
- T1 (helper unit tests): FIXED — added src/__tests__/lib/audit-helpers.test.ts.

## Resolution Status

### [T1] Major: No isolated unit tests for *AuditBase helpers — FIXED
- Action: Added `src/__tests__/lib/audit-helpers.test.ts` with 10 tests covering scope value, field presence, ip/userAgent/acceptLanguage propagation from request headers, and absence of cross-scope fields (e.g., teamId on PERSONAL).
- Modified file: src/__tests__/lib/audit-helpers.test.ts (new file, 96 lines)

### [T2] Minor: Helper mocks omit acceptLanguage — FIXED
- Action: Added `acceptLanguage: null` to each of personalAuditBase/teamAuditBase/tenantAuditBase mock returns in all 18 test files.
- Modified files: 18 test files under src/__tests__/api/share-links/ and src/app/api/

### [T3] Minor: Dead extractRequestMeta mock — FIXED
- Action: Removed dead `extractRequestMeta:` mock entries from 16 test files where the migrated production routes no longer reference the function. Also removed `mockExtractRequestMeta` hoisted variable from mcp/authorize/consent/route.test.ts.
- Modified files: 16 test files + mcp/authorize/consent/route.test.ts (3 line removals beyond the mock entry)

### [S1] Minor: Theoretical scope-downgrade in share-link audit — Skipped
- **Anti-Deferral check**: "acceptable risk" — DB FK invariant prevents the failure mode in normal operation.
- **Justification**:
  - Worst case: One audit row mis-scoped (PERSONAL instead of TEAM with teamId=undefined) for a corrupted share record. Forensic visibility loss for that single row.
  - Likelihood: Very low — `teamPasswordEntryId` is a foreign key with referential integrity to `TeamPasswordEntry`, which has a non-null `teamId`. Reaching the failure mode requires direct DB tampering or schema corruption.
  - Cost to fix: ~10 LOC defensive log/throw in two files (share-links/route.ts and share-links/[id]/route.ts). Low.
  - Decision: Original code had identical fragility (would have written `teamId: undefined` which is functionally identical for the persisted column — `null`). The new code's `PERSONAL` fallback is arguably MORE correct in the corrupted-data case (no broken TEAM-scope row in audit_logs). No regression introduced; the flaw is pre-existing.
- **Orchestrator sign-off**: Confirmed acceptable risk per quantification above. Not introduced by this PR; pre-existing fragility under DB-corruption scenarios. Low cost-to-fix tracked but not addressed in this PR scope (refactoring) — a separate hardening PR could add the defensive check across all share-link mutations.
