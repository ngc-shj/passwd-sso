# Plan Review: scim-team-admission-approval
Date: 2026-11-03
Review round: 1

## Changes from Previous Round
Initial review of plan v1 (pending admission + pending role elevation). Pre-screen: the
tenant-return path and the key-distribution readers — both answered in v1.

## Findings (merged)
- F1 / S1 / T2 [Critical] The pending-role CHECK aborts tenant departure
  (`endTeamMemberships` deactivates without clearing the pending role): offboarding
  rolls back and the user keeps access.
- F2 / S2 / T3 [Major] `replaceScimGroup`'s current-member set excludes pending rows: a
  PUT never withdraws a pending request; every PUT re-adds and re-audits it.
- F3 [Major] A pending role has no group-membership semantics; the IdP's "move" sequence
  removes the member.
- F4 [Major] A user in two groups of one team flaps into recurring approvals.
- F5 [Major] Approval can demote an OWNER or override a manual role change.
- F6 / S6 [Major] No reject path.
- F7 / S8 [Major] Two more SCIM group-member readers in `Groups/route.ts`.
- F8 [Major] Members API consumers unspecified (display types, list page, transfer page).
- F9 / T4 [Major] Audit registration incomplete; the SCIM group is excluded from team
  webhooks; service results lack per-user transitions.
- S3 [Major] SCIM removal/demotion of approvers invisible at team scope; residual
  colluder risk unstated.
- S4 [Major] Audit durability unspecified; key-granting operations need `logAuditInTx`.
- T1 [Major] A3 statuses: pending and non-member approvers answer 404, not 403; denial
  cells must assert no state change.
- T5 / F11 [Major] Forbidden patterns match existing reads; no enforcement.
- T6 [Major] Existing tests that change meaning not listed.
- T8 [Major] A1 routes unnamed; positive controls missing.
- T10 [Major] Missing cells (concurrent approve, races, 404 variants, re-add, reject).
- Minors: S5/F13 (CAS, holds-key predicate), S7 (token id in audit, SC3 rationale),
  F10/T7 (gate counts), F12 (mark-pending flags), F14 (no eligible approver), T9 (outbox
  assertions), T11 (red-proofs), T12 (UI test); Adjacent: memberCount, members/search.

## Recurring Issue Check
Functionality: R1/R3 (F7), R12 (F9), R5/R9 (F13), R7/R8 (F8), R38 (F5, F6), R42 (F1, F5),
R48 (F3, F7), R53 (F10). Security: R42 (S1, S2, S8), R49 (S3), R29 / R43 / R54 clean.
Testing: RT4 (races), RT5 (T8), RT7 (T5, T11), RT8 (T1), RT10 (T8), RT11 (T9).

## Resolution Status (plan v2)
- F1/S1/T2, F3, F4, F5: the pending-role mechanism is removed. SCIM role changes of
  active members keep today's behaviour (they already hold key and data), with
  TEAM-scope visibility (C4); the residual colluder risk is stated in Objective.
- F2/S2/T3, F7/S8: one shared reader and PUT current set include pending rows; removal
  deletes a pending row; PENDING audited only on the transition.
- F6/S6: reject route (C3).
- F8: C5 lists the consumers. F9/T4, S4, S7: C4 (TEAM group, `logAuditInTx`, token id).
- S3: removals and role changes audited at TEAM scope; residual risk stated.
- T1, T8, T10: acceptance A1-A11 with statuses, positive controls, races.
- T5/F11: patterns scoped to writes and enforced by a gate rule. T6, T11: listed.
- S5/F13, F12, F14 (SC5), F10/T7, T12: specified.

---

Review round: 2 (plan v2)

## Findings (merged)
- S-R2-1 / F1 [Major] Approve CAS not pinned to the role the approver saw; a pending
  role raise is unaudited.
- T13 [Major] The gate cannot see a raw INSERT admission or raw marker writes, and
  nothing catches a create without the marker.
- T14 [Major] One shared reader cannot serve both the response reader (active-tenant
  filter) and the PUT current set (departed users); rewrite list incomplete.
- T17 [Major] Reject's pending predicate has no cell or red-proof; cross-team memberId.
- Minors: S-R2-2 (self-raise), S-R2-3 / F4 (withdraw audit), S-R2-4 (404 before 409),
  S-R2-5 / F7 (departure-marked row of an active tenant user), S-R2-6 (owner route
  comment), F2 (departed pending user fails PATCH), F3 (invitation accept re-check),
  F5 (where in-tx audits are emitted), F6 (two-group effects), F8 (reject needs no key),
  T15 (race park points), T16 (A7 red-proof), T18 (Groups route reader), T19 (A11 real
  DB, UI cells), T20 (confirm-key negatives, gate coverage), T21 (A9 cells), T22 (SC6
  cells).

## Recurring Issue Check
Functionality: R42 (F3), R38 (F2, F7), R12 (F1, F4), R5/R9 (F1), R48 (F6).
Security: R42, R49 (S-R2-3), R5 (S-R2-1). Testing: RT1 (T14, T19), RT4 (T15, T16),
RT5 (T17), RT6 (T14, T18, T19), RT7 (T13, T16-T18), RT11 (T20).

## Resolution Status (plan v3)
- S-R2-1/F1: approve takes `expectedRole`, CAS pins the role (409), raise audited
  (PENDING with `previousRole`), A12.
- T13: `deactivatedAt: new Date()` via Prisma; rule 7 is positive (marker required),
  refuses unreadable data and raw writes, with listed self-tests; count changes explained.
- T14: two readers in one module; rewrite list extended; A13 cells.
- T17: A8 cells, red-proof.
- S-R2-2 Objective; S-R2-3/F4 `TEAM_MEMBER_SCIM_PENDING_WITHDRAW`; S-R2-4 C3 order;
  S-R2-5/F7 C2; S-R2-6 C5; F2 C2 + A13; F3 C6 + A14; F5 C2/C4 (route emits, tx-only
  service); F6 SC6 + transition counts; F8 C3; T15 A6/A7 park points; T16, T18 red-proofs;
  T19 A11; T20 A10 + gate; T21 A9; T22 A13.

---

Review round: 3 (plan v3)

## Findings (merged)
- SR3-1 / TR3-4 [Major] SCIM removal not serialised with approve/reject (removed users
  not advisory-locked, team lock `FOR SHARE` on both sides, id-only removal writes):
  a just-approved member can be deleted, or a false WITHDRAW audited.
- TR3-1 / FR3-2 [Major] A6 park point unreachable: departure locks only teams with an
  active membership.
- TR3-2 / FR3-5 [Major] A3 "approver as target" cell unreachable.
- TR3-3 [Major] A1 negative can pass via the ECDH-key / `keyDistributed` filters.
- TR3-5 [Major] Reject (and role-pin) red-proofs turn nothing red while the locked
  target read keeps the predicate.
- Minors: FR3-1 (invitation claim committed on refusal), FR3-3 / TR3-7 (CAS form vs
  admission count), FR3-4 (target user id before locking), FR3-6 (departed unmark
  transition), FR3-7 (audit target id), FR3-8 (reader shape for the batch query), TR3-6 /
  SR3-2 (rule 7 blind spots), TR3-8 (rewrite list), TR3-9 (one error code for two rows),
  SR3-3 (existing memberships invisible), SR3-4 (pending invariants in the schema).

## Recurring Issue Check
Functionality: R5/R9 (FR3-1), R42 (FR3-6), R53 (FR3-3). Security: R5/R9 (SR3-1), R42
(SR3-2, SR3-4). Testing: RT4 (TR3-1, TR3-4), RT5 (TR3-3), RT7 (TR3-5, TR3-6, TR3-7),
RT10 (TR3-2, TR3-8).

## Resolution Status (plan v4)
- SR3-1/TR3-4: `lockGroupWrite` locks add ∪ remove users (PUT: requested + pre-read,
  locked re-read refuses an unlocked user); every removal write a CAS; transitions from
  write results; A7b cells and red-proof.
- TR3-1/FR3-2: A6 uses a second team T2 parked `FOR NO KEY UPDATE`; T2 also A9's control.
- TR3-2/FR3-5: cell dropped; self-approval recorded as structurally impossible.
- TR3-3: mark-pending sets `keyDistributed: false`; A1 preconditions; A2 same user.
- TR3-5: red-proofs drop the predicate from both read and CAS; A7 variant added.
- FR3-1: in-tx refusal throws (claim rolls back), A14 asserts PENDING. FR3-3/TR3-7: CAS
  pinned to Prisma `updateMany` with literal data; deltas stated. FR3-4: unlocked
  pre-read. FR3-6: departed-unmark transition audited. FR3-7: target = user id. FR3-8:
  fragments. TR3-6/SR3-2: rule 7 extended + self-tests. TR3-8: list corrected. TR3-9:
  `SCIM_APPROVAL_PENDING`. SR3-3: C7 operator listing + follow-up. SR3-4: two CHECKs,
  Zod `expectedRole`.

---

Review round: 4 (plan v4)

## Findings (merged)
- FR4-1 [Major] PATCH remove of a user with no row (after reject/withdraw) throws and
  rolls back the whole PATCH, blocking de-provisioning on every retry.
- FR4-2 [Major] Per-row CAS plus per-user in-tx audits can exceed the 10 s transaction
  timeout on large syncs; the 409 retry repeats the same timeout.
- SR4-1 [Major] Gate method lists omit `createManyAndReturn` / `updateManyAndReturn`.
- TR4-1 [Major] PUT locked re-read refusal had no cell or red-proof.
- TR4-2 [Major] A9 CHECK cells asserted SQLSTATE only.
- TR4-3 [Major] Rule 7 raw scan would skip the gate's `IMPLEMENTATIONS` files.
- TR4-4 [Major] Rule 7 marker requirement missed `upsert.create` / nested creates.
- Minors: FR4-3 (add-path role update not a CAS), FR4-4 (unbounded lock set, unnamed
  refusal), SR4-2 (C7 listing mixes approved rows; empty under `passwd_app`), TR4-5
  (quoted key, `Prisma.sql`), TR4-6 (A7b red-proof failure mode), TR4-7 (A7b PATCH
  status), TR4-8 ("no stale keys" can never fail).

## Recurring Issue Check
Functionality: R38 (FR4-1), R5/R9 (FR4-3), performance (FR4-2). Security: R42 (SR4-1).
Testing: RT5 (TR4-2), RT7 (TR4-1, TR4-3, TR4-4, TR4-5, TR4-8), RT9 (TR4-8).

## Resolution Status (plan v5)
- FR4-1: absent remove is a no-op; A5b. FR4-2: set-based CAS writes,
  `logAuditBulkInTx` (one `createMany`), request bounds, A7e at the max. SR4-1: method
  lists extended + self-tests. TR4-1/FR4-4: refusal replaced by "skip users outside the
  locked set" (no error class), A7c + red-proof; bounds checked before locking.
  TR4-2: constraint name per cell, positive control, CHECK red-proof. TR4-3: raw scan
  before the skip + self-test. TR4-4/TR4-5: every creating payload; self-tests incl.
  quoted key, `Prisma.sql`; runtime-assembled names a known limit. FR4-3: role CAS per
  previous role, A7d. SR4-2: listing excludes approved rows, table-owner connection,
  non-empty dev run. TR4-6/7/8: red-proof note, A7b statuses, seeded-keys A5.

---

Review round: 5 (plan v5, one combined reviewer)

## Findings
- R5-1 [Major] "No tenant row keeps 400" leaves the FR4-1 failure open after SCIM
  DELETE /Users. R5-2 [Major] A7e wall-clock bound cannot fail for a per-row regression.
- Minors: R5-3 (PUT bound wedges large groups), R5-4 (new PATCH cap unmeasured), R5-5
  (critical-audit gate cannot see bulk actions), R5-6 (inverting unit cell unnamed).
- Verified: every writer of a pending row holds the user's advisory lock;
  `updateManyAndReturn` available (Prisma 7.10.1) through the proxy and under RLS.

## Resolution Status (plan v6)
- R5-1/R5-6: absent-team-row remove is always a no-op; A5b variant; cell listed.
- R5-2: A7e is a call-count cell (N-independent) with a red-proof.
- R5-3/R5-4: lock only pending/departed remove candidates; no new request cap.
- R5-5: bulk call shape specified; gate extended with self-tests.

## Process note
Round 5 ran one combined reviewer, not three experts (Step 1-4 core), and returned design
findings (R5-1, R5-2), so saturation does not fire. Round 6 runs the three experts on the
v6 deltas.

---

Review round: 6 (plan v6, three experts)

## Findings (labels as filed)
- S6-1 [design, Major] / F6-2 [design, Minor] Unlocked active-row remove races tenant
  departure; the marker survives and `returnToTenant` restores a membership the IdP
  removed (a defect introduced by the v6 lock narrowing).
- S6-2 [design, Minor] Critical-audit gate is existential; PUT/PATCH sites, scope and
  transition coverage unbound.
- F6-1 [prose] route cell expecting 400 and message wording; F6-3 [prose] pending-row
  writer list incomplete (deleteUser cascade); F6-4 [prose] SCIM spec doc.
- T6-1 [prose] A7e counts; T6-2 [design] A7e host/mock and red-proof; T6-3 [prose]
  ternary self-test vacuous; T6-4 [prose] A5b preconditions.

## Resolution Status (plan v7)
- S6-1/F6-2: lock every remove candidate again (v6 narrowing reverted; R5-3's reason —
  the cap — is gone); A5c race cell + red-proof.
- S6-2: one emitter with an exhaustive transition→action Record, literal TEAM scope;
  A10 per verb, red-proof per verb. A site-scoped companion gate was not added: the
  per-verb integration cells and the compile-time Record cover the same failure.
- F6-1, F6-3, F6-4 (C6b), T6-1..T6-4: folded into the plan.

---

Review round: 7 (plan v7, three experts)

## Findings (labels as filed)
- F7-1 [design, Minor] / S7-1 [design, Minor] A withdraw shortfall cannot be attributed
  (`deleteMany` returns a count); "no transition, no throw" drops real WITHDRAW audits
  and would accept a surviving non-pending row.
- T7-1 [design, Major] A5c park point after the team UPDATE cannot distinguish the fix
  from the red-proof (tuple lock) and needs an unnamed blocker.
- F7-2 [prose] spec Audit section; T7-2 [prose] A7e fixture sizes and write shapes;
  T7-3 [prose] bulk-pass self-test vacuous.
- Verified: S6-1 resolved; S6-2 substitute sufficient (security).

## Resolution Status (plan v8)
- F7-1/S7-1: shortfall throws a 409 conflict (whole request rolls back, retry emits exact
  transitions); unlock wording corrected; unmark ids from the locked re-read.
- T7-1: A5c parks the departure at its team lock, asserts parked and the return's
  transition; red via "write waited on the blocker".
- F7-2, T7-2, T7-3: folded in.

---

Review round: 8 (plan v8, three experts)

## Findings (labels as filed)
- F8-1 [design, Minor] shortfall conflict had no named class or route arm (would be a
  500, or a false rotation message via the shared helper).
- F8-2 [prose] two stale spec Audit lines. T8-1 [prose] A7e groups must grow with N.
  T8-2 [prose] gate pair proves the bulk call is seen, not its action read.
  T8-3 [prose] shortfall cell could not see the rollback.
- Security: no findings (S7-1 verified; no attacker-forced permanent 409; no
  access-bearing survivor).

## Resolution Status (plan v9)
- F8-1: `ScimMembershipChangedError`, own 409 arm in PUT and PATCH, route cell per verb.
- F8-2, T8-1, T8-2, T8-3: folded in.

---

Review round: 9 (plan v9, three experts)

## Findings (labels as filed)
- Functionality: No findings (F8-1, F8-2 verified). Security: No findings.
- T9-1 [prose, Minor] shortfall rollback cell not bound to both verbs; T9-2 [prose,
  Minor] "one previous role" wording for the create group. Both folded into plan v10.

## Saturation call (round 9)
1. Nine rounds completed. 2. No Critical or Major open. 3. No finding against the
design in round 9. 4. The two remaining findings were prose-only and are resolved in
v10. Phase 1 closes; Go/No-Go gate locked. Carried-forward plan findings: none.
