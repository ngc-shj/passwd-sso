# Code Review: team-lock-busy-error
Date: 2026-11-13
Review round: 1

## Changes from Previous Round
Initial review. Local LLM pre-screen and seeds unavailable (Ollama down); all three experts did a
full-diff review on top of the Phase 2 self-R-check (clean in all three perspectives).

## Functionality Findings
- F1 Minor — `rekey-runner.ts` `busyWaits` is pass-wide and never reset, so sporadic busy answers
  across a long pass can add up to `RETRY_BUDGET_EXHAUSTED`.
- Checklist cross-check: every file in the Implementation Checklist is in the diff. Control flow of
  the three BUSY_WAIT arms, the importer loop, all consumer branches, confirm-key outcome order and
  the bulk-import abort verified.

## Security Findings
No findings. Every TEAM_BUSY arm returns before any write or audit row; authorization precedes the
lock everywhere; `parseJsonBodyOnce` is used only on error paths, keyed weakly; server codes reach
the UI only as i18n keys; client retries are bounded.

## Testing Findings
- T1 Minor — the red-proof record omitted the admin-reset/SCIM pins, the runner budget and clamp
  cells, the importer cells, the CLI/extension memo cells and the integration cells.
- T2 Minor — the bulk-import "later entry times out" cell cannot show entry 1's rollback (service
  mocked); no real-DB variant.
- T3 Minor — `teamAuditRows` (integration) has no positive control.
- T4 Minor [Adjacent] — the importer test's `setTimeout` spy compares delays exactly; robust today.

## Adjacent Findings
- T4 (above).

## Quality Warnings
None.

## Recurring Issue Check
### Functionality expert
- R1, R3, R5, R10, R17, R21, R30: checked — no issue (F1 is a design note under R10/R38).
- All other R1–R57: N/A for this diff (no schema, migration, enum, env, auth or crypto change).

### Security expert
- R1, R2, R3, R5, R9, R12, R13, R17, R38, R42, R43, R52: checked — no issue.
- R19, R25, R40, R48: N/A.
- RS2, RS3, RS4: checked — no issue. RS1, RS5, RS6: N/A.
- All other R items: N/A.

### Testing expert
- R3, R17, R19, R21, R50: checked — no issue. R7: N/A.
- RT1, RT2, RT3, RT5, RT6, RT8, RT9, RT10, RT11: checked — no issue. RT4: N/A.
- RT7: T1.
- All other R items: N/A for the test-strategy scope.

## Environment Verification Report
- VE1 (lock-timeout cells need a second connection holding `teams`): `verified-local` —
  `npm run test:integration` with the compose workers stopped, plus
  `ANCHOR_TEST_S3_ENDPOINT=http://127.0.0.1:9000` for the MinIO suites; 150/150 files pass across
  the two runs (deviation log, "Verification (Phase 2-4)").

## Resolution Status
### F1 Minor — busy budget is pass-wide — Accepted
- **Anti-Deferral check**: acceptable risk.
- **Justification**: the plan fixes `MAX_BUSY_WAITS` as pass-wide, the same shape as `rateWaits`.
  Only a `FOR NO KEY UPDATE` holder (a rotation, or the retention prune's ~31 ms hold) makes these
  requests time out, so ten 3 s timeouts in one pass mean the team was being rotated repeatedly —
  stopping and reporting is the useful outcome. Worst case: a pass over a team rotated many times
  stops with `RETRY_BUDGET_EXHAUSTED` and the admin re-runs it (the pass is resumable). Likelihood:
  low. Cost to fix: ~15 min, but it would remove the bound that stops a pass from waiting out an
  unbounded series of rotations.
- **Orchestrator sign-off**: accepted; per-entry reset is not adopted.

### T1 Minor — red-proof gaps — Fixed
- Action: ran the missing mutations on scratch copies (runner counter merge, `>=`, clamp removal;
  importer widen/remove; admin-reset arm → `teamBusy()`); every targeted cell failed and every
  unmutated control passed. Recorded in the deviation log, "Red-proof additions".
- Modified file: `docs/archive/review/team-lock-busy-error-deviation.md`.

### T2 Minor — no real-DB "later entry" bulk-import cell — Accepted
- **Anti-Deferral check**: acceptable risk.
- **Justification**: a real-DB variant needs the stand-in lock to start between two entries of one
  request, which `withRotationStandIn` cannot schedule. Rollback of earlier entries is the
  transaction's own behaviour once the error leaves `withTeamTenantRls`, and the unit cell pins
  that the error does leave it (no further service call, no audit, 409 TEAM_BUSY); the real-DB
  first-entry cell pins that the transaction writes nothing. Worst case: a regression that catches
  TEAM_BUSY inside the transaction would commit earlier entries — the unit cell fails on that
  shape. Likelihood: low. Cost to fix: a new harness hook (>30 min) for a path the unit cell
  already pins.
- **Orchestrator sign-off**: accepted.

### T3 Minor — `teamAuditRows` positive control — Accepted
- **Anti-Deferral check**: acceptable risk.
- **Justification**: `teamAuditRows` filters `audit_outbox` on `payload.teamId`, the same key the
  file's existing `keyDistributeAudits` helper uses and that team audits write; the bulk-import
  and PUT cells also assert no new rows, so a leaked write is caught independently of the audit
  check. A positive control would need a successful write whose post-commit `logAuditAsync`
  enqueue the test must await, adding timing dependence. Worst case: an audit row written under a
  different payload key goes unseen. Likelihood: low. Cost to fix: ~20 min plus a flake risk.
- **Orchestrator sign-off**: accepted.

### T4 Minor — importer delay equality — No change
- The reviewer recommends keeping it as is; the spy is restored in `afterEach`.
