# Code Review: stepup-ci-guard
Date: 2026-06-27
Review round: 1 (initial)

## Changes from Previous Round
Initial review of the uncommitted guard diff (3 experts: functionality / security / testing).

## Functionality Findings
- **No findings.** Detection completeness independently grep-verified (no hard-delete path the signal set misses — at the time of review, before S2); false-positive set confirmed (soft-deletes/history/attachments not matched); step-up grep correctly requires a CALL; bash 3.2 robustness, exempt parsing, and anti-drift all verified by running.

## Security Findings
- **S2 (Low, real class gap) — FIXED.** `/api/teams/[teamId]` DELETE hard-deletes ALL team password entries via cascade (`team.delete()` → `TeamPasswordEntry.team @relation(onDelete: Cascade)`) — more destructive than bulk-purge — but the signal set keyed only on entry-table primitives, so the cascade-via-parent class was structurally invisible. Added `team.delete(` (boundary-anchored to avoid `teamMember.delete`/`teamFolder.delete` false-positives). The route already has step-up, so the guard now covers it and passes.
- **S4 (Low) — FIXED.** The exempt-list reason-comment was convention-only (parser stripped it). Now enforced: a non-comment exempt line without a ≥10-char trailing `# reason` fails with `EXEMPT_NO_REASON`, raising the bar on the guard's one bypass surface from code-review-vigilance to a CI gate.
- **S1 (Low, accepted parity) — documented.** The gate is file-level (any step-up call in the file satisfies it, regardless of method/branch) — same granularity as the existing fail-closed guard. Holds today because every matched route is single-purpose; added a header note that multi-handler routes need manual confirmation.
- **S3 (Info).** `vault/admin-reset` exemption verified correct (dual-admin one-time token ceremony, initiator≠target — stronger than session-recency step-up).
- **S5 (Info) — FIXED in doc.** Class-7 prose now notes team-cascade is machine-enforced too.
- No Critical/High; nothing to escalate.

## Testing Findings
- **T1 (Low, parity gap) — FIXED (exceeded).** No sibling route-grep guard has a self-test, but a security backstop warrants one. Added `scripts/__tests__/check-permanent-delete-stepup.test.mjs` (11 cases) driving the guard against fixtures via new `STEPUP_GUARD_*` env overrides: pass/soft-delete/missing-stepup/prefixed-rename/bare-import/team-cascade/false-positive-guard/exempt-with-reason/exempt-no-reason/stale-exempt(×2). Sets a better precedent than the un-tested siblings.
- Verified: guard passes clean (exit 0), catches MISSING_STEPUP + STALE_EXEMPT (both branches); runs in CI's always-on static-checks job via `PRE_PR_STATIC_ONLY=1`; failure message is actionable.

## Resolution Status
All findings (S2, S4, T1 + S1/S5 doc) resolved. The guard now covers the cascade-destruction class, enforces exempt justification, documents its file-level granularity, and has an 11-case self-test. `pre-pr.sh` exit 0 (Passed: 39, guard ✓, self-test green in the suite). No Critical/Major remained.

## Recurring Issue Check (consolidated)
- R1 (reuse): PASS — follows the established grep-guard + run_step + exempt-allowlist pattern.
- R3 (propagation/completeness): the guard IS the completeness fix; S2 closed the one structurally-uncovered destruction class (cascade). The signal set + anti-drift + reason-enforcement keep the bypass surface honest.
- Guard-completeness / false-assurance: file-level granularity disclosed (S1); single-purpose-route assumption documented.
- Self-test: present (T1) — exceeds sibling-guard parity.
