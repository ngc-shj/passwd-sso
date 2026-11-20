# Plan Review: team-key-recipient-binding
Date: 2026-11-19
Review round: 1

## Changes from Previous Round
Initial review. Local LLM pre-screen raised only Minors (name the setup route file; list the DELETE
and wrap-untouched UPDATE cells), both applied before Round 1.

## Functionality Findings

| ID | Sev | Label | Finding | Disposition |
|----|-----|-------|---------|-------------|
| FN1 | Major | design | Column + NULL refusal in one migration: old instances' writes 500 during the rolling deploy (R24) | Accepted with cost stated — plan Considerations "Rolling deploy window": fail-closed, no data written, client retries; a split release would leave NULL writers unchecked for a release |
| FN2 | Minor | design | `users.ecdh_public_key` writer set derived from `src` only; e2e `seedUser` upsert is a `P→P'` path | Fixed — C7 re-derived over `src scripts e2e prisma`; `seedUser` stops rewriting the key |
| FN3 | Minor | design | Issue's member-key "writer" dropped silently; route is GET-only, CLAUDE.md stale | Fixed — C7 states it; CLAUDE.md row corrected |
| FN4 | Minor | design | C8's `check-bypass-rls` premise wrong; C3 bypass use unstated | Fixed — C8 rewritten; C3 states its scoped bypass |
| FN5 | Minor | prose | i18n path is `messages/{en,ja}/ApiErrors.json` | Fixed |
| FN6 | Minor | design | Trigger order / 23514 mapping precedence unstated | Fixed — C2 "Trigger order", C5 precedence |
| FN7 | Minor | design | Dedicated rotation toast redundant; stale-bundle messages misleading | Fixed — generic arm used; stale-bundle messages accepted in C4 |
| FN8 | Minor | prose | Probe not reproducible; READ COMMITTED argument overstated | Fixed — probe committed with command; isolation argument restated |
| FN9 | Minor | design [Adjacent] | Rotate-key reaches the trigger only after reset+setup+redistribution | Fixed — C5 and the rotate-key test sequence |
| FN10 | Minor | prose | C1 invariant stronger than C2 enforces | Fixed — reworded |

## Security Findings

| ID | Sev | Label | Finding | Disposition |
|----|-----|-------|---------|-------------|
| S1 | Major | design | C2+C3 do not close the class: a `P→NULL` writer that does not first delete keys leaves a row bound to the retired key (reproduced, `scratchpad/sec/race.cjs`) | Fixed — FR2/C3 `ecdh_key_change_with_keys`: no key change while key rows or `key_distributed = true` exist; rationale lines corrected |
| S2 | Major | design | No contracted `search_path` pin; app role can shadow `users` with a temp table (verified) | Fixed — pin + schema-qualified names in both functions, forbidden pattern, verify-SQL assertion, red cell |
| S3 | Minor | prose | Objective claims a wrap binding; the control checks a client-claimed fingerprint | Fixed — Objective restated; SC1 cross-referenced |
| S4 | Minor | design | Wrap rewrite can inherit OLD's fingerprint; fingerprint-only UPDATE binds a legacy row | Fixed — `fingerprint_rebind` arm; inherited-fingerprint safety argued from FR2 in C2 |
| S5 | Minor | design | Column-list firing is surface-form; lock read can match zero rows silently | Fixed — plain `BEFORE UPDATE` + value test; scoped bypass + `NOT FOUND` raise |
| S6 | Minor | prose [Adjacent] | Raw-SQL ecdh writers missed; member-key route unreconciled | Fixed — with FN2/FN3 |

No Critical; no escalation.

## Testing Findings

| ID | Sev | Label | Finding | Disposition |
|----|-----|-------|---------|-------------|
| T1 | Critical | design | Setup race cell always passes; no cell detects removing C3's `FOR UPDATE` (reset masks it) | Fixed — races rebuilt: raw app-role NULL vs guarded insert (both orders, witnessed waits, mutation→cell map); setup race dropped |
| T2 | Major | design | Twin vector checks a copy of the SQL, not the trigger; seed helper could share it | Fixed — vector through the trigger with the production JS function, non-ASCII byte; helper uses the production function |
| T3 | Major | design | No endpoint→client-fingerprint round trip for confirm-key/rotation; caller mocks tautological | Fixed — endpoint round-trip cells; escrow doubles compute from their argument |
| T4 | Major | design | Missing allow/axis cells (cross-tenant guest, bypass restore, upsert update branch, per-column, same-value, legacy seeding) | Fixed — all listed in Testing |
| T5 | Major | design | Setup mapping tested only against hand-built flat errors | Fixed — real-route integration cell; nested adapter fixture |
| T6 | Major | design | Adopter set misclassified; route-body class and stale #1074 red-proof rows missed | Fixed — C7 two classes with derivations; idempotent helper; rows refreshed |
| T7 | Major | design | Red-proof plan lists no rows | Fixed — 19 rows listed |
| T8 | Major | design | RT8 side effects only for confirm-key | Fixed — rotate-key and creation side effects listed |
| T9 | Minor | design | C3 no-added-lock acceptance undecided, no positive control | Fixed — `lock_timeout` with `55P03` control |
| T10 | Minor | prose | Probe control wrong, sleep-judged, not in repo | Fixed — control is a key change with the trigger disabled, judged by `pg_stat_activity`, committed |
| T11 | Minor | design | Fixture cleanup unspecified | Fixed — `finally` + helper-registered cleanup |
| T12 | Minor | question | E2E `seedUser` upsert vs C3 | Fixed — with FN2 |

## Adjacent Findings
FN9 (routed to Testing: rotate-key sequence) and S6 (routed to Functionality: member sets) — both
applied.

## Quality Warnings
None (every finding carried file evidence or an executed probe).

## Recurring Issue Check

### Functionality expert
R1 checked (reuse `pgErrorCode`, generalise parser); R2 checked; R3 checked (FN6 precedence); R4 N/A;
R5 checked; R6 N/A; R7 checked; R8 FN7; R9 N/A; R10 checked; R11 N/A; R12 N/A; R13 N/A; R14 checked
(`passwd_app` UPDATE on `users`, INSERT/UPDATE on `team_member_keys`); R15 checked; R16 checked; R17
checked (FN2); R18 FN4; R19–R21 N/A; R22 checked; R23 N/A; R24 FN1; R25 checked (write-only); R26–R28
N/A; R29 FN4/FN5/FN8 (other claims re-derived by execution); R30 checked; R31–R33 N/A; R34 checked;
R35–R36 N/A; R37 checked; R38 checked (no wedge); R39 N/A; R40 checked (byte-identical serving);
R41 checked; R42 FN2/FN3; R43–R46 N/A; R47 checked; R48 checked; R49 checked; R50 FN8; R51 checked;
R52 checked; R53 N/A; R54 checked; R55 checked; R56–R57 N/A.

### Security expert
R1 checked; R2 checked; R3 checked (S4); R4 N/A; R5 checked; R6 N/A (S1); R7–R11 N/A; R12 N/A (no
durable emit on a refusal arm); R13 N/A; R14 checked (`db-grants-manifest.json` users UPDATE for
`passwd_app`; retention prune is DEFINER DELETE); R15 N/A; R16 checked; R17 checked; R18 checked
(S2); R19–R21 N/A; R22 S1; R23 N/A; R24 checked; R25 N/A; R26–R28 N/A; R29 S1 (other citations
verified: `audit-db-grants.mjs:47,99`, READ COMMITTED, nesting guard); R30–R33 N/A; R34 checked
(S3); R35–R36 N/A; R37 checked (user text must avoid ECDH/fingerprint); R38 checked; R39 N/A; R40
checked; R41 N/A; R42 S1/S6; R43 checked; R44–R46 N/A; R47 checked (S5a); R48 checked; R49
S1/S3/S4; R50 checked; R51 checked; R52 checked; R53 N/A; R54 checked (S2 is the real leak); R55
checked; R56–R57 N/A. RS1 N/A (public value); RS2 checked; RS3 checked (Zod + CHECK); RS4 checked;
RS5–RS6 N/A.

### Testing expert
R1 T6; R2 checked; R3 T6; R4 N/A; R5 checked; R6 N/A; R7 checked; R8–R13 N/A; R14 adjacent (C8);
R15 checked; R16 checked; R17 T6; R18 checked; R19 T3/T5; R20–R21 N/A; R22 checked; R23 N/A; R24
checked; R25–R28 N/A; R29 T10 (counts re-derived: 3 writers, 3 escrow callers, reset importers);
R30–R32 N/A; R33 checked (seed in ci.yml, suite in ci-integration.yml); R34 checked; R35–R39 N/A;
R40 T3; R41 N/A; R42 T6; R43–R46 N/A; R47 checked; R48 checked; R49 checked; R50 T10; R51 N/A;
R52 T4a; R53 N/A; R54 T4b; R55 checked; R56–R57 N/A. RT1 T3/T5; RT2 checked; RT3 T2; RT4 T1; RT5
T2/T3; RT6 checked; RT7 T1/T7; RT8 T8; RT9 T2; RT10 T4; RT11 T11.

---

# Review round 2 (incremental)
Date: 2026-11-19

## Changes from Previous Round
Round-1 fixes applied (plan rewritten). All round-1 findings verified resolved by their experts
(FN1 accepted; its cost argument corrected in round 2).

## Findings and dispositions

| ID | Sev | Label | Finding | Disposition |
|----|-----|-------|---------|-------------|
| S2-F1 / FN2-F1 / T2-N3 | Major (converged, 3 experts) | design | C3's keys/flag check ran on `NULL → P`: vault setup refused (unmapped 500, wedge) for users holding pre-fix residue; breaks `departed-member-leaked-authority` `setEcdhKey` after seeding and the helper order | Fixed — C3 step 2: `NULL → P` takes no lock and no read; step 3 only for `P → NULL`; residue repaired by new C9 |
| S2-F2 | Minor | prose | FR2's flag half holds only because every flag writer takes KEY SHARE | Fixed — closure argument in FR2; flag-writer member set in C7 |
| S2-F3 | Minor | design | `ecdh_key_change_with_keys` unmapped | Fixed — C5: unreachable from routes, rethrown |
| FN2-F2 | Minor | design | Setup's lock upgrade adds a deadlock edge | Fixed — removed with S2-F1 (setup takes no upgrade); edge documented for `P → NULL` |
| FN2-F3 | Minor | prose | Wrong reason why reset passes C3 | Fixed |
| FN2-F4 | Minor | prose | FN1 cost argument overstated; failure limiter omitted | Fixed |
| FN2-F5 | Minor | design [Adjacent] | Helper must set keys before memberships | Resolved by S2-F1 (no longer an ordering constraint) |
| T2-N1 | Major | design | Red-proof rows 8/9 mis-mapped | Fixed — row→cell map rewritten (row 6 outcome, row 7, 8 both races, 9 three cells) |
| T2-N2 | Major | design | Row 13 unobservable, row 19 no cell, row 12 evaluator unnamed, no C3 restore row | Fixed — 13a/13b, trigger-order cell, evaluator named, 11a/11b |
| T2-N4 | Major | design | Mismatched-key-with-row fixtures unreachable under FR2 | Fixed — `writeRefusedState` named; per-column tokens stated |
| T2-N5 | Minor | question | `seedUser` keeping the public key while rewriting the private key | Fixed — `seedUser` fails loudly on an existing keyed user |
| T2-N6 | Minor | prose | Probe header/trigger shape stale | Fixed — header rewritten, plain `BEFORE UPDATE`, re-run (same result) |

No Critical. Recurring Issue Check sections (round 2) — Functionality: R17 F5, R24 F4, R29 F3/F4,
R38 F1, R52 F1, all others checked/N/A as in round 1. Security: R22 F1, R34 (`enforce_tenant_id_from_context`
only reads the bypass — C8 assertion targets `set_config` callers), R38 F1, R49 F2, others as round 1;
RS1–RS6 unchanged. Testing: R3/R17/R42 N3, R29/R50 N6, R38 N3, R54 N2, RT7 N1/N2, RT10 N4, RT11 N5,
others checked.

---

# Review round 3 (incremental)
Date: 2026-11-19

All round-2 findings verified resolved by their experts.

| ID | Sev | Label | Finding | Disposition |
|----|-----|-------|---------|-------------|
| FN3-F1 / S3-N1 | Major / Minor (converged) | design | C9 repair grants itself no RLS bypass: silent no-op for the RDS NOSUPERUSER NOBYPASSRLS owner under FORCE RLS | Fixed — DO block with BACKFILL markers, saves/sets/restores `app.bypass_*` and `app.tenant_id` (nil UUID), exact tables; cell runs as NOBYPASSRLS; rows 21–22 |
| FN3-F2 | Minor | design | Why the repair runs after `CREATE TRIGGER` unstated | Fixed — C9 "Placement" |
| FN3-F3 | Minor | prose | NOTICE counts not printed by `migrate deploy` | Fixed — C9 "Counts"; deployment-notes count query |
| S3-N2 | Minor | prose | C9 safety argument cites an incomplete private-key writer set | Fixed — argued from the sole `P → NULL` writer; rotate-key noted; stale rotate-key flag sentence removed |
| T3-P1 | Major | design | Red-proof rows turn unlisted cells red; row 11b vacuous; comparison operator unpinned | Fixed — rows list required cells; collateral recorded as `+` lines from a Phase-2 dry run (an execution output — saturation condition 4b); 11b uses `P → NULL`; operator pinned |
| T3-P2 | Major | design | Trigger-order cell cannot go red through confirm-key | Fixed — raw app-role INSERT asserting `key_inactive` |
| T3-P3 | Major | design | C9 cell extraction/run procedure | Fixed — `readBackfillBlock` with per-block override, rolled-back app-role run, three fixtures, seeded-id assertions; rows 20/20b |
| T3-P4 | Minor | design | Rows 12/13a outside the runner verdict | Fixed — manual `psql -f` procedure recorded in the deviation log |

No Critical. Recurring Issue Check (round 3) — Functionality: R1/R3/R16/R41/R50 F1, R29 F3, others
checked/N/A. Security: R16/R50/R54 N1, R29 N2, R34 (pre-existing `enforce_tenant_id_from_context`
unpinned; fail-closed via FK), others checked/N/A; RS1–RS6 unchanged. Testing: R16/R17 P3, R50 P4,
R54 P1, RT5 P2, RT7 P1–P4, RT11 P3, others checked.

---

# Review round 4 (incremental)
Date: 2026-11-19

- Functionality: No findings (FN3-F1..F3 verified resolved).
- Security: No findings (S3-N1/N2 verified resolved; C9 DO block vs `rls_bypass_admits`,
  `check-migration-rls-dml`, `rls-cross-tenant-verify` checked).
- Testing: T3-P1..P4 verified resolved; required-cells + recorded-collateral approach judged sound
  (each `+` line's reason must be checked against its mutation in the deviation log).
  - T4-M1 Minor (prose — fails loudly on first execution): C9 active residue user must be seeded via
    `writeRefusedState` → Fixed.
  - T4-M2 Minor (prose — fails loudly on first execution): trigger-order fixture must be an ended
    membership → Fixed.

## Saturation call (round 4)
1. Four rounds completed. 2. No Critical/Major open in any category (round-3 Majors fixed and
verified in round 4). 3. No finding against the design. 4. The two remaining Minors were prose-only
(labelled by the testing expert) and are applied. Phase 1 closes; no Carried-Forward findings.

Recurring Issue Check (round 4): all three experts — every rule checked or N/A, no finding
(Security R43/R54 checked for the C9 block's scoped, restored bypass; Testing RT7 P1–P4 resolved).
