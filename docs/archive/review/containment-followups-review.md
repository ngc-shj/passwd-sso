# Plan Review: containment-followups
Date: 2026-11-17
Review round: 1

## Changes from Previous Round
Initial review. Local LLM pre-screen unavailable (Ollama down); merge done manually from the three
experts' json indexes.

## Functionality Findings
- FF1 Major design R40/R3 — share links can exceed the 100-id containment cap (quota 1000). → C5: every lister takes at most `MEMBER_CONTAINMENT_MAX_IDS`; `moreFootholds` counts the rest; dialog says so.
- FF2 Major design R12/R11 — `SHARE_REVOKE` in the tenant ADMIN group duplicates the tenant-webhook SHARE group. → C5: tenant SHARE and SEND groups instead; webhook groups unchanged.
- FF3 Major design R49/R29 — the activity view excludes PERSONAL scope and includes agent actors; copy overstated it. → C7/C8 state the scope; label "Actions by".
- FF4 Major design R49 — `containmentScope` copy must keep the NULL-creator / re-activated / other-tenant caveats. → C5 copy + C9 doc (merged with SF3).
- FF5 Minor design R1/R48 — shared filter helper was "tx-less" but validates teamId; new download 400 unnamed. → C7 split.
- FF6 Minor design R5 — PATCH single-transaction order unstated. → C4 order stated.
- FF7 Minor design R29 — field-reference feasibility deferred. → spiked (see C5).
- FF8 Minor design R18/R3 — file list / gate list incomplete. → Files section, Static line.
- FF9 Minor design R38 — C6 placement. → superseded by C6 redesign (claim-time).
- FF10 Minor prose R8 — raw path for the link. → `@/i18n/navigation` Link.

## Security Findings
- SF1 Major design R49/R43/R56 — C6 FAILED-drain lets any delivery manager erase the unsent SIEM tail without a record; deactivation called "narrowing". → C6 redesigned: rows stay PENDING, excluded at claim, resume on re-activation; C4 gates deactivation too.
- SF2 Minor design R42/R47 — FK-less creator derivation by `*ById` name is surface-form. → C2 name-agnostic over FK-less uuid scalars with a keyed non-creator list.
- SF3 Minor design R49 — NULL-creator targets are not containable. → merged into FF4.
- SF4 Minor prose R3 — `updateManyAndReturn` without `select`. → C5 selects.
- SF5 Minor design R57 — no id tiebreak in list/download ordering. → C7.
- SF6 Minor prose R49 — "Activity of" overstates. → merged into FF3.
- SF7 Minor design R38 — check placement vs `outbox_purged`. → superseded by C6 redesign.

## Testing Findings
- TF1 Major design RT1/RT10/RT7 — C6 only unit-proved; fixtures lack `isActive`. → fixtures explicit + real-DB worker cell.
- TF2 Major design R38/RT10 — re-activation behaviour unpinned. → cell: inactive rows not claimed; claimed and delivered after re-activation.
- TF3 Major design RT10/RT5 — team-link gate row; PATCH denial and race cells. → added.
- TF4 Major design R42/R29/RT10 — derivation unmeasured, no allow fixtures. → measured (19 candidates, listed in C2); allow fixtures + stale check.
- TF5 Major design RT8/RT10 — containment denial cells (foreign / non-live ids), boundaries, parity. → added.
- TF6 Major design RT10/RT8 — audit-log filter positive controls, cross-tenant teamId, audit metadata. → added.
- TF7 Major design RT7 — red-proofs only for the member-set test. → one named mutation per new cell family.
- TF8 Major design RT6/RT1 — new exports untested. → helper / builder / validator tests; settings GET keeps unmocked helper.
- TF9 Minor design RT10 — backfill untouched / idempotent / valid-uuid control. → added.
- TF10 Minor prose RT3/R19 — fake timers, paired params, link attrs. → added.
- TF11 Minor prose RT11 — FK-order cleanup. → added.
- TF12 Minor prose RT7 — sentinel-seeded forbidden fields. → added.

## Adjacent Findings
- TF2 / testing → security: re-activation replay of a parked backlog. Resolved by SF1's redesign (replay to the re-activated target is now the intended behaviour; re-activation is gated, C4).
- Testing asked security to confirm the team-link create path is gated: it is (the gate precedes the single create, after the entry-type branch; C3 row added).

## Quality Warnings
None.

## Recurring Issue Check
### Functionality expert
R1 FF5 | R2 ok | R3 FF1, FF8 | R4 ok | R5 FF6 | R6 ok | R7 n/a | R8 FF10 | R9 ok | R10 n/a | R11 FF2 | R12 FF2, FF8 | R13 ok | R14 ok | R15 ok | R16 ok | R17 ok | R18 FF8 | R19 ok | R20–R23 n/a | R24 ok | R25 FF4 | R26 n/a | R27 ok | R28 n/a | R29 FF7 (D1–D6 reproduce) | R30 n/a | R31 ok | R32 ok | R33 n/a | R34 ok | R35 n/a | R36 ok | R37 n/a | R38 FF9 | R39 n/a | R40 FF1 | R41 n/a | R42 ok | R43–R47 n/a | R48 FF5 | R49 FF3, FF4 | R50 ok | R51–R56 n/a | R57 n/a
### Security expert
R1 ok | R2 ok | R3 SF4 | R4 n/a | R5 ok | R6 n/a | R7–R8 n/a | R9 ok | R10–R11 n/a | R12 ok | R13 n/a | R14 ok | R15 n/a | R16 n/a | R17 ok | R18–R23 n/a | R24 ok | R25–R28 n/a | R29 SF2 | R30–R35 n/a | R36 ok | R37 n/a | R38 SF7 | R39 n/a | R40 ok | R41 n/a | R42 SF2 | R43 SF1 | R44–R46 n/a | R47 SF2 | R48 ok | R49 SF1, SF3, SF6 | R50–R53 n/a | R54 ok | R55 SF3 | R56 SF1 | R57 SF5 | RS1 n/a | RS2 ok | RS3 ok | RS4–RS6 n/a
### Testing expert
R1 TF8 | R2–R11 ok | R12 ok (test to add) | R13 ok | R14 ok | R15–R18 ok | R19 TF1, TF10 | R20–R28 ok | R29 TF4 | R30–R37 ok | R38 TF2 | R39–R41 ok | R42 TF4 | R43–R47 ok | R48 TF6 | R49–R57 ok | RT1 TF1, TF8 | RT2 ok | RT3 TF10 | RT4 ok | RT5 TF3 | RT6 TF8 | RT7 TF1, TF7, TF12 | RT8 TF1, TF3, TF5, TF6 | RT9 ok | RT10 TF1–TF6, TF9 | RT11 TF11

---

# Plan Review: containment-followups
Date: 2026-11-17
Review round: 2

## Changes from Previous Round
Plan rewritten for all round-1 findings: C6 claim-time exclusion, C4 two-direction gate, C2
name-agnostic FK-less uuid derivation, C5 cap / selects / tenant SHARE+SEND groups / caveat copy,
C7 split filter + id tiebreak, D7 field-reference spike, per-family red-proofs.

## Functionality Findings
- FG1 Major design R38/R56 — parked PENDING rows have no age bound and pin outbox rows; D4 wording. → C6 expiry step + D4 corrected (merged with SG1).
- FG2 Minor design R40/R3 — `moreFootholds` has no carrier in the passkeys GET route. → C5 + Files.
- FG3 Minor design R29 — D7/D3 reproducibility; `check-bypass-rls` acceptance of field refs unverified. → D7 command + fallback branch.
- FG4 Minor design R47/R42 — derivation is uuid-typed only. → accepted boundary stated in C2 (every user reference is uuid; widening would key names / URLs / hashes).

## Security Findings
- SG1 Major design R56/R38 — same as FG1 (retention pin, stale replay on late re-activation). → C6 expiry: rows older than the outbox retention window → FAILED + `AUDIT_DELIVERY_DEAD_LETTER` (loss record).
- SG2 Minor prose R49 — re-enabled-row caveat cannot occur (re-activation keeps the creator). → clause dropped.

## Testing Findings
- TN1 Major design RT10/RT7 — retry-state rows and parked-row interaction with purge. → retry row cell; expiry cells incl. outbox release.
- TN2 Major design RT10/RT8 — PATCH reorder unpinned. → three route cells + red-proof.
- TN3 Major design RT1/RT9 — predicate parity under a mock lacking `.fields`. → literals kept (check-bypass-rls reads only call-site literals); mock carries a sentinel `fields.maxViews` both where clauses must contain; real-DB cell is the behavioural proof.
- TN4 Minor design RT10 — cap boundary. → 100 / 101 / uncapped-kind cells.
- TN5 Minor prose RT7 — missing named red-proofs. → added.

## Quality Warnings
None.

## Recurring Issue Check
### Functionality expert
R3 FG2 | R29 FG3 | R38 FG1 | R40 FG2 | R42 FG4 | R47 FG4 | R56 FG1 | all others ok / n/a
### Security expert
R38 SG1 | R49 SG2 | R56 SG1 | all others ok / n/a; RS1–RS6 ok / n/a
### Testing expert
R38 TN1 | RT1 TN3 | RT7 TN1, TN5 | RT8 TN2 | RT9 TN3 | RT10 TN1, TN2, TN4 | all others ok / n/a

---

# Plan Review: containment-followups — Rounds 3–6
Date: 2026-11-17

Narrow incremental rounds, each verifying only the previous round's edits. Every finding below was
raised against text the previous round added; none reopened a contract.

| Round | Expert | ID | Severity / label | Finding → resolution |
|---|---|---|---|---|
| 3 | Func | H1 | Major design R14/R54 | expiry ran under `OUTBOX_RETENTION_PURGE`, which cannot see targets → grant + positive join |
| 3 | Sec | H1 | Minor design R5 | multi-worker duplicates → SKIP LOCKED pick + RETURNING-driven dead-letter rows |
| 3 | Sec | H2 | Minor prose R49 | generic dead-letter alerting → `error: "target inactive"`, own `_logType` |
| 3 | Test | F1–F3 | Minor design RT7/RT10/RT4 | due retry rows; injected cutoff, boundaries, idempotence, bound; no replay after expiry |
| 4 | Func | I1 | Minor design R51 | re-activation between pick and update → superseded in round 5 |
| 4 | Sec | J1 | Minor design R14/R54 | shared purge grant widened → dedicated `OUTBOX_DELIVERY_EXPIRY` |
| 4 | Test | G1 | Major design RT4/RT10 | overlap cell promised but absent → race-helpers cell |
| 4 | Test | G2 | Minor design RT7 | cutoff signature; positive-join red-proof → added |
| 5 | Sec | K1 | Minor prose R29 | repeated predicate shares the statement snapshot → predicate dropped |
| 5 | Func | K1 | Minor design RT7 | repeated predicate untestable → same resolution |
| 5 | Test | H1 | Major design RT7/RT10/R51 | no ordering against re-activation → `FOR SHARE OF t` + held-re-activation cell |
| 5 | Test | H2 | Minor design RT4 | overlap vacuity → seed > limit, B non-empty, union check |
| 6 | Sec | — | — | No findings |
| 6 | Func | L1 | Minor prose R14/R29 | `FOR SHARE` needs UPDATE (held) → wording |
| 6 | Test | J1–J3 | Minor | COMMIT / ROLLBACK pairing; `waitForBackendBlockedBy` before release; J3 = L1 |

## Recurring Issue Check (rounds 3–6, changed parts only)
### Functionality expert
R14 H1, L1 | R29 L1 | R38 ok | R50 ok | R51 I1 | R54 H1 | R56 ok | others ok / n/a
### Security expert
R5 H1 | R14 J1 | R29 K1 | R38 ok | R49 H2 | R54 J1 | R56 ok | R57 ok | others ok / n/a; RS1–RS6 n/a
### Testing expert
RT4 F2, G1, H2, J2 | RT5 J3 | RT7 F1, G2, H1 | RT10 F2, F3, G1, H1, J1 | others ok / n/a

## Saturation call (round 6)
- Six rounds completed (≥ 2).
- No Critical or Major open in any category. The round-3, 4 and 5 Majors are resolved in the plan text.
- No open finding against the design. Round 6 produced one prose Minor and three Minors on acceptance-cell wording, all folded into the plan.
- No remaining finding needs an Anti-Deferral entry, so the plan carries no `## Carried-Forward Plan Findings` section.
- Character of rounds 3–6: each round's findings were about the mechanism the previous round had just added, which is the saturation pattern. Phase 2 proceeds.
