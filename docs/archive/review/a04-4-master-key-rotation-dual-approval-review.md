# Plan Review: a04-4-master-key-rotation-dual-approval

Date: 2026-05-23
Review rounds: 1, 2

## Round 2 — Changes from Previous Round
Plan v2 incorporated Round 1 findings (TTL constants, cross-tenant CAS guard, integration test contract, manual-test commitment, Zod schemas, etc.). Round 2 evaluated the scope expansion and reported 28 new findings (0 Critical, 6 Major, 11 Minor, 4 Info, 2 self-downgraded). All Round 1 findings verified resolved.

## Round 2 New Findings (summary — see plan v3 for resolution)

### Major (6)
- F15 — NotificationType enum + i18n strings + RLS wrapper for FR10 createNotification not enumerated (overlaps S13).
- F16 — System-wide vs tenant-scoped share-revocation semantics needs explicit NF4 statement.
- F18 — `ROTATION_EXECUTE_TTL_MS = 5min` falsely claims "mirrors AdminVaultReset" — existing `EXECUTE_TTL_MS = 60min`. Either align or justify the divergence.
- S13 — FR10 notification spec under-specified (NotificationType, body content, email channel, i18n) — see F15.
- S14 — Initiator deactivation between initiate and approve leaves rotation row valid; needs explicit decision (strict vs permissive).
- T11 — `expect.objectContaining` shape assertion is one-sided; CAS WHERE field removal would pass test. Need exact-key-set assertion.
- T12 — C9 I2/I3 (self-approval + cross-tenant DB CAS tests) currently serial; should also race against valid second-actor.

### Minor (11)
- F19 — Eval-pattern invariant: `reason` must NOT appear in initiate response (already by construction; documented).
- F20/T17 — ≥15 cases per helper is excessive for execute/revoke; replace with "exhaustive cartesian product".
- F24 — Audit emit on CAS count===0 path must also fire (FR11 wording).
- F25 — FR10 wording: "after the CAS commits" → "after the create commits" (initiate has no CAS).
- F26 — FR10 single-operator-tenant edge case (notification recipient list empty; rotation undeapprovable — by design).
- S15 — Operational logging (getLogger.warn) for distinct sub-cause of RACE_LOST_OR_TERMINAL.
- S16 — 5-min execute window UX note: bounded cost of expired execute.
- S17 — RLS wrapper choice per route: `withTenantRls` for master_key_rotations; `withBypassRls` for PasswordShare execute only.
- T13 — C9 iteration warmup + winnerCount distribution note.
- T14 — FR10 notification test assertions (recipient list, exclusion of initiator, fail-safe).
- T15 — `feedback_pre_pr_iteration_targeted.md` note in Testing Strategy.
- T16 — Manual test step 5 audit-row verification.

### Info (4)
- F21 — C9 50-iter for I4 over-prescribed (acceptable as-is).
- F22 — tenantId NOT NULL precludes future system-actor rotation (one-line OOS note).
- F23 — Legacy `MASTER_KEY_ROTATION` docs at `audit-log-reference.md` + `admin-tokens.md` should be updated.
- S18 — Execute re-validation TOCTOU: microsecond gap, accepted residual risk.
- S19 — Audit dead-letter fallback: existing behavior, acceptable.
- T18 — Adversarial scenarios in C10 need step-by-step expansion.
- T19 — Legacy 410 endpoint audit emission decision (silent — access-log only).
- T20 — Snapshot tests declined (per typescript/testing.md).

## Round 1 — Initial Review

## Functionality Findings

### F1 Major — targetVersion sanity check missing from initiate spec
Plan FR1 does not require the existing safeguard from the legacy route (`targetVersion === getCurrentMasterKeyVersion()` and `getMasterKeyByVersion(targetVersion)` succeeds). Without it, an operator can stage a rotation referencing a version the server cannot encrypt with, and execute would revoke all old-version shares without a replacement key actually installed.

### F2 Major — AUDIT_ACTION_VALUES update not in plan deliverables
The const array used by audit-i18n-coverage tests (`AUDIT_ACTION_VALUES` near audit.ts:205-) was not enumerated as a required edit in C2.

### F3 Major — Plan misidentifies audit.ts ADMIN-group line locations
Plan says "audit.ts:258 region" for `AUDIT_ACTION_GROUPS[ADMIN]`; line 258 is inside `AUDIT_ACTION_VALUES`. Actual groups: `AUDIT_ACTION_GROUPS[ADMIN]` at 563-578; `AUDIT_ACTION_GROUPS_TENANT[ADMIN]` at 596-617.

### F4 Major — AUDIT_ACTION_GROUPS_PERSONAL[AUTH] and AUDIT_ACTION_GROUPS_TEAM[ADMIN] coverage undecided
Existing MASTER_KEY_ROTATION appears only in `AUDIT_ACTION_GROUPS[ADMIN]` + `AUDIT_ACTION_GROUPS_TENANT[ADMIN]`. ADMIN_VAULT_RESET_* also appears in PERSONAL[AUTH] and TEAM[ADMIN]. The new MASTER_KEY_ROTATION_* actions need an explicit decision matching one of these patterns.

### F5 Major — Migration GRANT block — AdminVaultReset migration is NOT the right template
AdminVaultReset migration predates the `passwd_app` role split. The plan must reference the `operator_tokens` migration (migrations/20260427105115_add_operator_token/migration.sql lines 58-62) for the correct `DO $$ ... GRANT ... TO passwd_app ... END $$` template.

### F6 Major — RLS strategy under-specified for nullable-tenant table
Without an `ENABLE ROW LEVEL SECURITY + FORCE + tenant_isolation policy`, a future code path that forgets `withBypassRls` will leak cross-tenant rows. Match operator_tokens RLS template.

### F7 Major — Dual-emit of MASTER_KEY_ROTATION + MASTER_KEY_ROTATION_EXECUTE breaks audit-chain hash linearity assumption
Doubles webhook delivery, increases audit-chain row count, contradicts the pre-1.0 break license in FR8.

### F8 Minor — Self-revoke audit metadata distinguisher conflicts with second-actor revoke
Plan only specifies `cause: "INITIATOR_SELF_REVOKE"`; second-actor case needs explicit `cause: "SECOND_ACTOR_REVOKE"`.

### F9 Minor — Consumer 1 (script) reads `status` but C4.AC1 removes the status field
Contradiction between Consumer 1 narrative ("reads { rotationId, status }") and C4.AC1 ("No status field").

### F10 Minor — Rate-limit key collision risk between phase rate limiters
Plan key `rl:admin:rotate:<phase>` is global; should be per-actor `rl:admin:rotate:<phase>:<auth.subjectUserId>`.

### F11 Minor — ExpiresAt cap for approve missing
AdminVaultReset narrows expiresAt on approve to `min(createdAt + RESET_TOTAL_TTL_MS, now + EXECUTE_TTL_MS)`. Plan does not specify approve-time refresh.

### F12 Minor — pre-pr.sh execute-CAS guard #2 over-restrictive regex
`grep -qE "approvedAt:\s*\{\s*not:\s*null"` rejects valid alternative `NOT: { approvedAt: null }` form.

### F13 Info — R10 helper-module path discrepancy
Plan places helper at `src/lib/admin-rotation/`; existing analogue at `src/lib/vault/`. Both defensible.

### F14 Info — User onDelete: Restrict vs Cascade choice differs from AdminVaultReset
AdminVaultReset uses Cascade; plan uses Restrict. Trade-off: forensic stability vs ability to delete users.

## Security Findings

### S1 Major — `expiresAt` TTL is unspecified
Concrete TTL constants and approve-time narrowing not specified. AdminVaultReset uses 24h initiate + 5min execute-narrow.

### S2 Major — Execute CAS does not enforce `expiresAt > now` per the static guard
pre-pr.sh guard for execute only checks `approvedAt` + `executedAt`; misses `expiresAt: { gt: now }` and `revokedAt: null`.

### S3 Major — Cross-tenant approval is structurally permitted but not explicitly decided
CAS WHERE excludes tenantId. Plan should pin either (A) same-tenant required or (B) cross-tenant by design with audit visibility.

### S4 Major — Execute does not re-validate `targetVersion` against current env config
If env rolls back between initiate and execute, executed targetVersion may not equal currentVersion.

### S5 Major — Initiate Zod schema not specified; `reason` length cap absent
Per RS3 and common/security.md, every user-supplied string must be length-bounded at the Zod boundary.

### S6 Major — Approver hierarchy check is weaker than AdminVaultReset's pattern
Plan accepts any OWNER/ADMIN as approver; AdminVaultReset requires `isTenantRoleAbove(actor, target)`. Decision required: same-tier acceptable, or require approver ≥ initiator.

### S7 Minor — Dual-emit at execute doubles webhook delivery without explicit deduplication
Subscribers receive both rows. Either document or suppress.

### S8 Minor — Failed cross-tenant approval has no forensic-audit emission path defined
Distinct `cause` strings needed for each rejection reason.

### S9 Minor — No notification to other operators that a rotation is pending
Defense-in-depth gap. AdminVaultReset notifies the target user; rotation should notify other OWNER/ADMINs.

### S10 Info — Pre-pr.sh guard C7.1 only matches one specific WHERE-clause syntax
Brittle grep; alternate Prisma syntax `NOT: { initiatedById: ... }` would bypass.

### S11 Info — Initiator self-revoke is allowed; consider whether this defeats dual-control
Acceptable but worth a one-line rationale.

### S12 Info — `expiresAt: { gt: now }` uses JS `new Date()` — clock-skew across replicas
Worth a note for multi-replica deploys.

## Testing Findings

### T1 Critical — Race scenario named in user scenarios has NO concurrent test
Scenario F is described but the test plan defers integration tests. AdminVaultReset has a 50-iteration race test (`src/__tests__/db-integration/admin-vault-reset-dual-approval.integration.test.ts:156-203`). A04-4 inherits the same threat surface but skips the proof.

### T2 Critical — C1.AC3 invariant has no concrete test implementation
"`revokedShares` is written ONLY at execute" is asserted but has no scheduled test or static guard. The forbidden-pattern regex is labelled "Enforced informally".

### T3 Major — CAS WHERE clause coverage gap — execute and revoke have no eligibility helper
Approve has `computeApproveEligibility`; execute and revoke lack equivalent pure helpers, leaving state-machine logic duplicated in route handlers without pure-function tests.

### T4 Major — Scenarios A-F not mapped to test IDs
Cross-cutting scenarios (especially Expiry — Scenario D requires time-mocking) are easy to skip without a traceability matrix.

### T5 Major — audit.test.ts extension is under-specified vs the existing T4 pattern
Plan does not specify group ABSENCE assertions (PERSONAL.AUTH, TEAM.ADMIN should NOT include rotation actions).

### T6 Major — R35 Tier-2 manual-test doc deferred without commitment criteria
"Post-implementation" is ambiguous. AdminVaultReset's manual-test doc is 442 lines, committed in the same PR.

### T7 Major — RT5: execute route test must verify CAS WHERE shape, not just the count branch
Combination of "fully mocked Prisma + no shape assertions + only grep guards + no integration test" leaves the CAS WHERE provable only by code review.

### T8 Minor — C8.AC1 "+30 test cases minimum" is unmeasurable
Replace with explicit scenario→test mapping or drop the number.

### T9 Minor — pre-pr.sh guard 1 misses the helper invocation, only checks the import
`grep -qE "computeApproveEligibility"` matches even if the route imports but never calls. Tighten to `\(`.

### T10 Minor — Plan does not commit to `feedback_run_migration_on_dev_db.md` step pre-merge
Not in any acceptance criterion.

## Adjacent Findings
None.

## Recurring Issue Check
### Functionality expert
- R1-R8: N/A
- R9 (fire-and-forget in tx): OK
- R10 (circular import): OK (F13 notes path only)
- R11 (display vs subscription group): F4
- R12 (action in groups + i18n + tests): F2, F3, F4
- R13 (delivery-failure loop): OK
- R14 (DB role permissions + RLS): F5, F6
- R15 (hardcoded env values): OK
- R16-R36: see expert output for full list (F7-F14 mapped above)

### Security expert
- R1-R8: N/A
- R9: OK
- R10: OK
- R11: OK
- R12: OK
- R13: OK
- R14: OK
- R15: OK
- R29: N/A
- R34 Anti-Deferral: enforced
- RS1: N/A
- RS2: OK
- RS3: S5
- RS4: OK

### Testing expert
- R1-R10: OK
- R11 (display vs subscription): T5
- R12 (action coverage): T5
- R29: N/A
- R35: T6
- RT1 (mock-reality): OK
- RT2: OK
- RT3: OK
- RT4 (race vacuous-pass guard): T1
- RT5 (test call-path includes primitive): T7

## Resolution Plan (orchestrator)

Plan v2 will incorporate Critical + Major + the cheap Minor fixes (F8, F9, F10, S7, T8, T9, T10). Info findings (F13, F14, S10, S11, S12) recorded as accepted-with-rationale below.

### Accepted Info findings (no plan edit)

#### F13 Info — Helper module path
- Anti-Deferral check: out of scope (different feature) — naming preference, not a defect.
- Justification: `src/lib/admin-rotation/` keeps the directory name aligned with the route directory `/api/admin/rotate-master-key/`, vs `src/lib/vault/` which would imply vault-scoping when rotation is system-wide. TODO marker not required (preference, not bug).
- Orchestrator sign-off: confirmed — naming choice documented in plan v2 Considerations.

#### F14 Info — onDelete: Restrict vs Cascade
- Anti-Deferral check: acceptable risk
- Worst case: User deletion blocked until forensic rows pruned (operator UX, no security impact).
- Likelihood: low (departing-operator scenarios are rare relative to in-flight rotations).
- Cost to fix: 0 LOC — either decision is one line. Plan v2 will switch to SetNull on `initiatedById` (nullable) for forensic-row persistence past user deletion, matching the audit-trail convention (preserve evidence even after subject leaves).
- Orchestrator sign-off: plan v2 adopts SetNull + nullable initiatedById (F14 resolved, not skipped).

#### S10 Info — Pre-pr.sh guard regex brittleness
- Anti-Deferral check: acceptable risk + addressed at plan v2.
- Worst case: alternate-syntax CAS bypasses the static check.
- Likelihood: low (implementer following the contract sample will use the standard form).
- Cost to fix: ~1 line per guard. Plan v2 documents the canonical CAS syntax convention.
- Orchestrator sign-off: plan v2 enforces canonical syntax via documentation; T9 covers the related invocation-vs-import check.

#### S11 Info — Initiator self-revoke rationale
- Anti-Deferral check: out of scope (no defect, documentation enhancement).
- Justification: plan v2 adds a sentence to FR5 documenting the asymmetry rationale.
- Orchestrator sign-off: resolved in plan v2 (not skipped).

#### S12 Info — Clock-skew note
- Anti-Deferral check: acceptable risk.
- Worst case: CAS comparison uses app-server clock; in multi-replica deployments, NTP drift could cause expiry to fire early/late.
- Likelihood: low (NTP standard on production servers; max drift typically <1s).
- Cost to fix: 1 line in Considerations.
- Orchestrator sign-off: plan v2 adds a Considerations note; no behavioral change.
