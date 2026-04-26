# Code Review: audit-log-purge-action-and-dryrun-audit
Date: 2026-04-27
Review round: 1 (terminated — all experts returned No findings)
Branch: feat/audit-log-purge-action-and-dryrun-audit

## Changes from Previous Round
Initial code review.

## Summary

3 expert agents (functionality / security / testing) reviewed in parallel against the plan and `git diff origin/main`. All returned "No findings".

## Functionality Findings
No findings. All plan requirements correctly implemented.

Verification confirmed:
- Migration file contains exactly `ALTER TYPE "AuditAction" ADD VALUE 'AUDIT_LOG_PURGE'` (no unrelated drift).
- Constants module: `AUDIT_ACTION`, `AUDIT_ACTION_VALUES`, `AUDIT_ACTION_GROUPS_TENANT.ADMIN` all updated, SIEM-orientation comment present.
- F2 verified: `TENANT_WEBHOOK_EVENT_GROUPS.ADMIN` references `AUDIT_ACTION_GROUPS_TENANT.ADMIN` directly (line 618), so webhook subscription propagates automatically.
- i18n labels present in both en + ja AuditLog.json.
- `purge-audit-logs/route.ts` emits `AUDIT_LOG_PURGE` for both real and dryRun paths with correct metadata (operatorId, purgedCount, matched, retentionDays, targetTable, systemWide, dryRun).
- `purge-history/route.ts` emits `HISTORY_PURGE` for both paths (correct — entry-history purge).
- Tests updated per plan: T1 (full block), T2 (line preserved), T4 (`expect.objectContaining` at both levels), T7 (test rename).
- R3 propagation: no remaining incorrect `HISTORY_PURGE` usages.
- R9 (async tx boundary): `logAuditAsync` outside any `withBypassRls` transaction in both routes.
- R12 (enum coverage gap): all required registrations present; intentional omissions from PERSONAL.HISTORY / TEAM.HISTORY match plan.
- R13 (re-entrant dispatch loop): `WEBHOOK_DELIVERY_FAILED` and `TENANT_WEBHOOK_DELIVERY_FAILED` already in `OUTBOX_BYPASS_AUDIT_ACTIONS`; no loop possible.

## Security Findings
No findings.

Verification confirmed:
- Audit attribution: `tenantAuditBase` correctly attributes events to operator's tenant; no sensitive data leakage in metadata.
- R13: dispatch loop guard intact via existing `OUTBOX_BYPASS_AUDIT_ACTIONS`.
- S5 (rate limiter): documenting comments added to both routes; shared dryRun+real key preserved (security posture).
- Audit chain: action-agnostic; new enum value doesn't affect chain logic.
- Migration: single `ALTER TYPE ADD VALUE` statement, no table-level drift.
- R9: `withBypassRls` transactions close before `logAuditAsync` calls.
- RS1-RS3 / R29: not applicable to this PR.
- S1 (SIEM orientation comment): present at constants definition site, explains semantic boundary.

## Testing Findings
No findings.

Verification confirmed:
- All plan-targeted test edits implemented correctly (T1/T2/T4/T7/F2).
- 148 tests pass across 7 affected files (audit constants, i18n coverage, audit-query, tenant-webhook-card, purge-audit-logs, purge-history).
- RT1 (mock-reality alignment): mock argument shapes match production `logAuditAsync` calls.
- RT3 informational: test assertions use string literals consistent with pre-existing pattern; not a regression.
- R3 (test propagation): all `HISTORY_PURGE` / `AUDIT_LOG_PURGE` test references map to correct actions.
- T3 (i18n exhaustiveness): both `audit-i18n-coverage.test.ts` and `i18n/audit-log-keys.test.ts` pass.
- R19: no new exports to mocked modules.

## Adjacent Findings
None.

## Quality Warnings
None.

## Recurring Issue Check

### Functionality expert
- R3 (pattern propagation): Checked — no incorrect HISTORY_PURGE references.
- R9 (async tx boundary): Pass.
- R12 (enum coverage): Pass.
- R13 (webhook loop): Pass via existing OUTBOX_BYPASS_AUDIT_ACTIONS.
- R21 (verification): Spot-checked — implementation matches plan.
- R24: N/A (additive ALTER TYPE only).
- All others: N/A or no issue.

### Security expert
- R3, R9, R13: Pass (see above).
- R29 (citation): Acceptable — paraphrase only.
- RS1: N/A (no credential comparison).
- RS2: Pass (existing limiter unchanged).
- RS3: Pass (no new input surface).

### Testing expert
- R3 (test propagation): Pass.
- R19 (mock alignment): N/A — no new exports.
- R21: Spot-checked.
- R24: N/A.
- RT1 (mock-reality): Pass.
- RT2 (testability): Pass — all paths unit-testable.
- RT3 (shared constants): Informational — consistent with pre-existing pattern.

## Resolution Status
No findings to resolve. All plan requirements implemented; all CI gates pass:
- 148 targeted tests pass
- pre-pr.sh: 11/11 checks pass
- TypeScript build: pass
- Lint: pass
