# Plan Review: departed-member-followups
Date: 2026-11-16
Review round: 1

## Changes from Previous Round
Initial review. Local LLM pre-screening unavailable (Ollama down); manual merge.

## Functionality Findings
- **FN-F1 Major (design, R42)** — C1 claimed one emitter per action, so the action-scoped
  `check-critical-audit-atomic` pins each site; `TEAM_ROLE_UPDATE` has two (member PUT transfer and
  role change). Merged with SEC-F1 and TEST-T4.
- **FN-F2 Minor (design)** — `buildMemberRoleResponse`'s parameter type and the PUT test mocks need
  `admittedAt` once the field is required.
- **FN-F3 Minor (design, R29)** — C3 harness gaps (scripts placeholder, new counts, exemption
  fixtures); the `.mjs` grep checked the wrong extension (the gate scans `.ts`); "fixture exclusion as
  today" was inaccurate; `.sh` scripts are unseen. Merged with TEST-T5 and SEC-F4.
- **FN-F4 Minor (design)** — the NULL-setting classifier must anchor on `SET … deactivated_at = NULL`;
  every writer's `WHERE` also contains NULL.
- **FN-F5 Minor (design)** — invitations POST's callback names `_tenantId`; the in-tx audit makes an
  outbox failure roll the change back, unstated.
- **FN-F6 Minor (design)** — transfer `previousRole` is pre-transaction and unguarded. Merged with
  SEC-F5.

## Security Findings
- **SEC-F1 Major (design, R42/R29/R49, escalate: false)** — = FN-F1.
- **SEC-F2 Major (design, R29/R49, escalate: false)** — the SC4 trigger rationale ("closes every
  limit at once") overstated: write skew without locks, a residue wedge of directory-sync/SCIM
  batches, tenant-row DELETE uncovered, RLS context at commit.
- **SEC-F3 Minor (design)** — C4's worst case understated (key material to a departed user); the
  SC4 issue was not filed.
- **SEC-F4 Minor (design, R42)** — migrations, `.sh`/`.sql` and runbook SQL unscanned; say so.
- **SEC-F5 Minor (design)** — = FN-F6.
- **SEC-F6 Minor (design, adjacent)** — member DELETE's removal audit stays post-commit (SC3, `#1047`).
- **SEC-F7 Minor (prose)** — the lost structured log line and the invitee email in metadata are not
  acknowledged.

## Testing Findings
- **TEST-T1 Critical (design, RT7/RT10/RT1)** — the C1 rollback cell (deferred trigger on the mutated
  table) stays green with the fix reverted: the commit fails before a post-commit `logAuditAsync`
  runs. Invert the fault: a `BEFORE INSERT` trigger on `audit_outbox`; with `logAuditAsync` the change
  commits and the cell fails.
- **TEST-T2 Major (design, RT1/R19)** — audit mock factories lack `logAuditInTx`; the `tx` the mocks
  hand the callback is the `prisma` singleton, so "received `tx`" cannot discriminate.
- **TEST-T3 Major (design, RT7)** — PUT refusal cells asserting `logAuditAsync` not called become
  vacuous; one POST success assertion goes stale.
- **TEST-T4 Major (design, R57/RT7)** — = FN-F1.
- **TEST-T5 Major (design, RT10/R19)** — = FN-F3, plus missing deny/allow pairs (order, scope,
  Prisma spelling, `.delete`, `deleteUser` in implementation files, allow cell for the departure-record
  arm).
- **TEST-T6 Major (design, RT1)** — C2's real-DB cell must drive the members GET route with
  `admitted_at` ≠ `created_at`.
- **TEST-T7 Minor (design, RT8)** — success-cell filter (tenant, action, targetId); trigger keying.
- **TEST-T8 Minor (prose)** — confirm the integration file runs in CI.

## Adjacent Findings
- SEC-F6 (to `#1047`'s scope). FN adjacent note on the rollback cell = TEST-T1.

## Quality Warnings
None.

## Recurring Issue Check
### Functionality expert
R1–R4 OK · R5–R8 N/A · R9 OK · R10, R11 N/A · R12 N/A (registration exists) · R13–R28 N/A ·
R29 FN-F3 · R30–R41 N/A · R42 FN-F1 · R43–R57 N/A
### Security expert
R1–R28 N/A · R29 SEC-F2/F3 · R30–R41 N/A · R42 SEC-F1/F4 · R43 Clean · R44–R48 N/A · R49 SEC-F1/F2 ·
R50–R57 N/A · RS1, RS2 Clean · RS3–RS6 N/A
### Testing expert
R1–R18 OK · R19 TEST-T2/T5 · R20–R56 OK · R57 TEST-T4 · RT1 TEST-T1/T2/T6 · RT2–RT6 OK ·
RT7 TEST-T1/T3/T4 · RT8 TEST-T7 · RT9 OK · RT10 TEST-T5 · RT11 OK

## Resolution Status (round 1)
- FN-F1 / SEC-F1 / TEST-T4: `IN_TX_ONLY_ACTIONS` with pinned in-tx emitter counts and no async
  emitter (C1, Gate). Plan C1.
- TEST-T1: atomicity cell inverted to an `audit_outbox` fault trigger. Plan C1 Acceptance.
- TEST-T2 / TEST-T3: sentinel `tx`, `logAuditInTx` in the factories, re-pointed refusal cells with
  positive controls. Plan C1 Acceptance.
- TEST-T6 / FN-F2: route-driven C2 cell; helper type and mocks. Plan C2.
- FN-F3 / TEST-T5 / SEC-F4: harness items, arm table, corrected scope wording, unseen file types.
  Plan C3.
- FN-F4: anchored regex and a NULL-anchor deny cell. Plan C3.
- FN-F5 / SEC-F7: `tenantId` rename; accepted changes stated. Plan C1.
- FN-F6 / SEC-F5: the promoting `updateMany` gains `role: target.role`. Plan C1.
- SEC-F2: decision section reworded (candidate, not equivalent; open questions); `#1060` filed with
  them. Plan "Decision on the gate items".
- SEC-F3: worst case restated; `#1060` cited. Plan C4.
- TEST-T7: filter and fault keying specified. Plan C1. TEST-T8: integration job runs the config.

### SEC-F6 Minor Member DELETE removal audit after the commit — Out of scope
- **Anti-Deferral check**: out of scope (different feature).
- **Justification**: `#1047` (branch `fix/session-revocation-failure-surfaces`, plan C4) rewrites the
  member DELETE handler and puts the post-commit tombstone failure count in `TEAM_MEMBER_REMOVE`.
  Changing that handler here would conflict with it. TODO(departed-member-followups): `#1047` to
  decide an in-transaction `TEAM_MEMBER_REMOVE` row (with the count in a separate outcome row).
- **Orchestrator sign-off**: tracked by `#1047`; noted in the PR body.

---

# Round 2
Date: 2026-11-16
Review round: 2 (incremental, Revision 2)

## Changes from Previous Round
All round-1 findings applied (Revision 2); `#1060` filed for SC4.

## Functionality Findings
- **G1 Major (design, R42/R29)** — "unreadable async params refused" would fail the real tree:
  non-literal (ternary or identifier) actions in `logAuditAsync`, mapped `logAuditBulkAsync` arrays,
  and the `logAuditAsyncBothScopes` helper body.
- **G2 Minor (prose, R29)** — the single-line grep cited as evidence proves nothing; cite the gate run.
- **G3 Minor (design)** — = TEST-R2-1.
- **G4 Minor (design)** — which in-tx emitter forms count toward the pin.

## Security Findings
- **N1 Minor (design, R49)** — the pin is a count, not a site identity.
- Round-1 SEC findings verified resolved; `#1060` text accurate.

## Testing Findings
- **R2-1 Major (design, RT1/RT7)** — the handlers rethrow an audit-insert failure (`handleAuthError`,
  `throw e`, `withRequestLog`); the cell must assert rejection, not a 500.
- **R2-2 Minor** — default SQLSTATE; assert by message.
- **R2-3 Major (design, RT7/R19)** — the existing `check-critical-audit-atomic` baseline cells emit one
  in-tx call per action and assert "all 22"; a pin of 2 breaks them.
- **R2-4 Minor** — define the counted emitter forms; separate deletion and revert cells.
- **R2-5 Minor** — the sentinel `tx` must delegate to the prisma mock.
- **R2-6 Minor** — no cell for no-audit on `ALREADY_SENT` / `INVITER_GONE`.
- **R2-7 Minor** — name the NULL-anchor pair.

## Recurring Issue Check (round 2)
- Functionality: R9 OK, R12 OK, R29 G2, R42 G1, rest OK/N/A.
- Security: R29, R42, R43 Clean; R49 N1; RS1, RS2 Clean; rest N/A.
- Testing: R19 R2-3; RT1 R2-1/R2-2/R2-5; RT7 R2-1/R2-3/R2-7; RT8 R2-6; RT10 R2-4; rest OK.

## Resolution Status (round 2)
- G1 / G2 / G4 / R2-4 / N1: the async rule is a subtree scan for the listed `AUDIT_ACTION.<NAME>`;
  identifier-valued actions are a stated limit; only direct literal `logAuditInTx` calls count; the
  count-not-identity limit is stated with the unit cells as the site pin; evidence is the gate run.
  Plan C1 Gate.
- R2-1 / G3 / R2-2: rejection with the trigger's message, default SQLSTATE. Plan C1 Acceptance.
- R2-3: harness emits the pinned count; the count string follows `ALL`; revert cells name their
  action. Plan C1 Acceptance.
- R2-5 / R2-6: delegating sentinel; no-audit cells with positive control; propagation cell.
- R2-7: one named pair in the C3 table.

---

# Round 3
Date: 2026-11-16
Review round: 3 (incremental, Revision 3)

## Findings
- Functionality: No findings (G1–G4 resolved; the subtree rule finds no listed action inside an
  async-emit call once C1 lands; the existing gate prints `OK (all 22 …)` today).
- **SEC-N2 Minor (design, R49)** — the gate was still labelled fail-closed though identifier-valued or
  out-of-subtree actions pass. Merged with **TEST-R3-2 Minor (prose, R57)**.
- **TEST-R3-1 Minor (design, RT10/RT7)** — no cell guards prefix matching
  (`TEAM_MEMBER_INVITE` vs `_CANCEL` / `_ACCEPT`).

## Recurring Issue Check (round 3)
- Functionality: R9, R12, R29, R42 OK; rest N/A.
- Security: R29, R42, R43 Clean; R49 SEC-N2; RS1, RS2 Clean; rest N/A.
- Testing: R57 TEST-R3-2; RT7/RT10 TEST-R3-1; rest OK.

## Resolution Status (round 3)
- SEC-N2 / TEST-R3-2: control class relabelled a best-effort tripwire, with what it does not see and
  what carries it. Plan C1 Control class.
- TEST-R3-1: exact equality stated; allow cells for `_CANCEL` async and `_ACCEPT` in-tx. Plan C1.

---

# Round 4
Date: 2026-11-16
Review round: 4 (narrow, Revision 4: C1 control class and two allow cells)

All three experts: No findings. SEC-N2, TEST-R3-1 and TEST-R3-2 verified resolved; R49 clean.

## Termination
All three experts returned "No findings" in round 4. The gate-item decision (rule 8 limits kept,
mechanism split to `#1060`) drew no design finding after round 1's SEC-F2 rewording; the findings of
rounds 2–3 were all inside the new `IN_TX_ONLY_ACTIONS` text and closed by narrowing its claim, not
by adding cases.
