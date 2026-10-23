# Code Review: verify-sentinel-audit-chain
Date: 2026-10-23
Review round: 1
Diff: `origin/main...HEAD` (4 commits), fresh reviewers.

## Findings and disposition

| ID | Source | Sev | Disposition |
|----|--------|-----|-------------|
| F1 | Functionality | Major (R38) | Fixed — `alerts.md` states that enabling the chain on `__system__` is one-way until the purge watermark exists: TAMPER after the first retention sweep past 365 days, RANGE_INCOMPLETE once every chained row is purged; the disable SQL is presented as "stop chaining new rows", not a recovery; the same applies to any once-chained tenant. Verify-every-tick (C3) unchanged |
| F2 | Functionality | Minor (R29) | Fixed — the retention section points to the new block instead of "fix the verify's start sequence first" |
| F3 | Functionality | Minor (R37) | Fixed — the anchor row-count arm has its own message; runbook names both arms (D5) |
| T-1 | Testing | Minor (RT1/RT7) | Fixed — stub `$1` check case-insensitive, fixtures keyed by label; the normalisation mutation now goes red at `BYPASS_SCOPE_VIOLATION` (D5) |
| T-2 | Testing | Minor (RT8) | Fixed — the sentinel cell's anchor branch asserts `ok` and no reason when within the cap, `TRUNCATED` above it |
| — | Security | — | No findings: no grant widening (R43), precondition and row checks fail closed, no row content in errors |

Found outside the reviewers: pre-pr failed `check-bypass-rls` and `check-rls-read-context` on the
committed code (D5); fixed.

## Recurring Issue Check

Functionality: R29 F2; R38 F1; R42 24 grants confirmed; R48 OK; others OK or N/A.
Security: R43 no widening; R50/R52/R54 OK; RS1–RS6 N/A or OK.
Testing: RT1/RT7 T-1; RT8 T-2; RT3, RT5, RT10, RT11 OK.
