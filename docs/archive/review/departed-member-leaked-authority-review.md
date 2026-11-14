# Plan Review: departed-member-leaked-authority

Date: 2026-11-14
Review round: 1

## Changes from Previous Round

Initial review.

## Functionality Findings

- **F1 [Major, design]** C1/C6 rely on `SECURITY DEFINER`, which does not get past FORCE RLS on RDS.
  The repo records this itself in the `20261102000000_share_creator_admitted` header. C1 fails
  open, and C6 silently skips under `deleteUser`'s bypass grant.
- **F2 [Major, design]** The C1 invariant overclaims. Accept legitimately admits a currently
  departed invitee.
- **F3 [Major, design]** The C4 "departed now" predicate refuses legitimately re-admitted actors,
  and it is applied only on the invitation channel. Members POST and approve are not covered
  (R48).
- **F4 [Major]** C5 acceptance 1 (PENDING) contradicts the DEPARTED branch, which commits
  EXPIRED. The response for an already-active member is not unchanged.
- **F5 [Major, prose]** C3 cites `20261102000000` as its base. The live body is
  `20261108000000`, which carries the #996 and #998 rules.
- **F6 [Major, design]** SCIM hold-raise and `returnToTenant` advance `admitted_at`, which
  permanently kills shares (C3) and webhooks (C6).
- **F7 [Major, design]** Member sets are incomplete: the bootstrap-tenant migration
  (`auth.ts:770`), the `deleteUser` cascade, and misattributed INSERT writers.
- **F8 [Minor]** A delivery success clears C6's `creator_inactive` marker.
- **F9 [Minor]** The team-deletion cascade is claimed as covered but has no test.
- **F10 [Minor]** The C5 forbidden pattern can never match, and the C2 pattern blocks reads.
- **F11 [Minor]** The `team-member-display.ts` `joinedAt` reader was not considered.

## Security Findings

- **S1 [Major, design]** Same as F1. It is also over-privilege (R14), and a superuser CI hides the
  failure (R16).
- **S2 [Major, design]** C6 has a TOCTOU at webhook create: the permission check runs outside the
  transaction.
- **S3 [Major, design]** The NULL-creator residual for existing webhooks is unbounded in time.
  The "no backfill" argument contradicts the self-granted-bypass precedent
  (`20261109162613`, `20261110000000`).
- **S4 [Major, design]** C6 ignores demotion below `TEAM_UPDATE`.
- **S5 [Major, design]** Same as F3 (R42/R48).
- **S6 [Major, design]** C3 leaves past shares of already re-admitted members open.
- **S7 [Major, prose]** Same as F5.
- **S8 [Minor]** The C1 definer helper is a PUBLIC-callable oracle, and the manifest delta is
  misstated.
- **S9 [Minor]** Same class as F2; C7 overstates.
- **S10 [Minor]** C7 misstates the role scope of `rls_backfill_rerun` and the available evidence.
- **S11 [Minor, adjacent]** Same as F4.
- **S12 [Minor, adjacent]** Same as F6, for `returnToTenant`.
- **S13 [Minor, adjacent]** Same as F10.

## Testing Findings

- **T1 [Critical, design]** CI cannot see C1/C6 failing open on RDS. It needs an RDS-equivalent
  test, NOSUPERUSER NOBYPASSRLS (same root as F1/S1).
- **T2 [Major]** The C2 INSERT override breaks the raw-SQL fixtures that backdate `created_at`.
- **T3 [Major]** The existing `share-departure` A3 tests pin the opposite of C2/C3.
- **T4 [Major]** C1 breaks existing fixtures: `team-tenant-departure` A9 and the directory-sync
  refusal test.
- **T5 [Major]** C1 does not enforce its stated invariant, and the C4 tests depend on that gap.
- **T6 [Major]** The C4 real-DB tests cannot fail for their reason (RT7). They need unit tests or
  a seeded residue state.
- **T7 [Major]** Same as F4.
- **T8 [Major]** The C5 rollback test has no defined rollback trigger, so it is vacuous.
- **T9 [Major]** The accept unit tests break, and the plan does not plan their replacement (RT1).
- **T10 [Major]** The invitation-create unit tests default to a guest inviter (RT10).
- **T11 [Major]** No test covers the producer of `created_by_id`, and C6 tests a column flip
  rather than delivery.
- **T12 [Major]** C1 acceptance does not pin the deferral, and its guest case is vacuous.
- **T13 [Minor]** C2 writer coverage and trigger-condition mutations.
- **T14 [Minor]** C6 allow cells and the cascade path.
- **T15 [Minor]** A10b must include the replaced function's migration.
- **T16 [Minor]** The forbidden patterns are inconsistent, and the C5 one cannot match.
- **T17 [Minor]** Gate specifics: the critical-audit `ALL` array and the manifest delta.
- **T18 [Minor]** The C6 trigger wording is garbled.

## Adjacent Findings

- **T1:** design fix in the Security/Functionality scope.
- **T2, T3:** whether INSERT or `returnToTenant` should set `admitted_at` (Functionality).
- **S11, S12, S13:** routed to Functionality and Testing.

## Quality Warnings

None (merge done by hand; Ollama unavailable).

## Disposition (applied in plan revision 2)

**Root cause of F1/S1/T1/T4/T5/T12/S8/S9.** Triggers and functions that read or write *other*
tables under FORCE RLS. Revision 2 removes every such trigger.

- **C1 (constraint trigger):** withdrawn.
  - Recurrence of SC5 is held by the existing fail-closed gate `check-team-rotation-input-lock`,
    which pins every write of `tenant_members.deactivated_at`.
  - The bootstrap-tenant migration (F7) is recorded as deliberate: the user moves tenants and
    keeps their bootstrap teams.
- **C2:** a same-row `BEFORE UPDATE` trigger. It advances `admitted_at` only on re-activation.
  INSERT leaves NULL (T2). It is used only by the actor predicate (C4), so F6/S12/T3 no longer
  apply to shares or webhooks.
- **C3:** now "refused when the creator departed the tenant after creating the share". It reads
  departure stamps, not admission, inside the existing invoker function with its call-scoped
  bypass.
  - It covers the past residue (S6) with no backfill.
  - `returnToTenant` keeps today's behaviour, so the A3 tests stay (T3).
  - The base is `20261108000000` (F5/S7).
- **C4:** one locked actor predicate ("departed after the actor's admission") on invitation
  create, accept (inviter), members POST and approve (F3/S5).
- **C5:** acceptance restated to EXPIRED (F4/T7/S11), with an injected rollback (T8) and the unit
  tests rewritten (T9/T10).
- **C6:** a delivery-time check in the worker. The creator must be an active member with
  `TEAM_UPDATE`.
  - This covers demotion (S4), the create-time TOCTOU (S2) and every membership-ending path
    (F7), by construction.
  - `created_by_id` is backfilled from `WEBHOOK_CREATE` with the self-granted bypass precedent
    (S3).
  - The worker gains a column-level `SELECT` on `team_members` (R14 stated).
- **F8, F9, F10, T12, T14, T16, T18:** moot after these changes, or folded into the revised
  acceptance.
- **F11:** out of scope (display), SC entry.
- **S10:** wording corrected.

## Recurring Issue Check

### Functionality expert
- R1 F1 (share_creator_admitted call-scoped bypass pattern not reused); departedAt/lockTenantRows reused
- R2 OK (creator_inactive literal → constant)
- R3 F3
- R4 OK
- R5 OK
- R6 F9, F7
- R7 N/A
- R8 N/A
- R9 OK
- R10 N/A
- R11 OK
- R12 OK
- R13 N/A
- R14 F1
- R15 OK
- R16 F1
- R17 F3
- R18 F1
- R19 N/A
- R20 N/A
- R21 N/A
- R22 F3
- R23 N/A
- R24 OK
- R25 F11
- R26–R28 N/A
- R29 F5, F1
- R30 OK
- R31 N/A
- R32 N/A
- R33 N/A
- R34 F7
- R35 VE2 justified
- R36 N/A
- R37 creator_inactive localize
- R38 F4, F8
- R39 N/A
- R40 F4
- R41 F1
- R42 F7, F6
- R43 OK
- R44 N/A
- R45 N/A
- R46 N/A
- R47 F10
- R48 F3
- R49 F2, F1
- R50 F1, F10
- R51 OK
- R52 F6
- R53 OK
- R54 F1
- R55 OK
- R56 N/A
- R57 N/A

### Security expert
- R1 OK
- R2 S4 if implemented
- R3 S5
- R4 OK
- R5 S2
- R6 OK
- R7 N/A
- R8 N/A
- R9 OK
- R10 N/A
- R11 OK
- R12 OK
- R13 N/A
- R14 S1, S8
- R15 OK
- R16 S1
- R17 S5
- R18 N/A
- R19 N/A
- R20 N/A
- R21 N/A
- R22 S1
- R23 N/A
- R24 OK
- R25 N/A
- R26 N/A
- R27 N/A
- R28 N/A
- R29 S3, S7, S10
- R30 N/A
- R31 N/A
- R32 N/A
- R33 N/A
- R34 S3, S6
- R35 N/A
- R36 OK
- R37 OK
- R38 S3
- R39 N/A
- R40 N/A
- R41 S1
- R42 S4, S5, S6
- R43 OK
- R44 N/A
- R45 N/A
- R46 N/A
- R47 N/A
- R48 S5
- R49 S1, S9
- R50 S1
- R51 OK
- R52 S1
- R53 N/A
- R54 S1
- R55 OK
- R56 N/A
- R57 N/A
- RS1 N/A
- RS2 N/A
- RS3 OK
- RS4 OK
- RS5 N/A
- RS6 N/A

### Testing expert
- R1 N/A
- R2 OK
- R3 T13
- R4 T11
- R5 T8
- R6 T14
- R7 N/A
- R8 N/A
- R9 T8
- R10 N/A
- R11 OK
- R12 T17
- R13 N/A
- R14 T1, T17
- R15 OK
- R16 T1
- R17 N/A
- R18 T17
- R19 T9, T10
- R20 N/A
- R21 N/A
- R22 T1
- R23 N/A
- R24 OK
- R25 N/A
- R26 N/A
- R27 N/A
- R28 N/A
- R29 T5, T7
- R30 N/A
- R31 N/A
- R32 N/A
- R33 T17
- R34 OK
- R35 N/A
- R36 OK
- R37 not assessed
- R38 N/A
- R39 N/A
- R40 T11
- R41 T11
- R42 T2, T4
- R43 N/A
- R44 N/A
- R45 N/A
- R46 N/A
- R47 T16
- R48 adjacent (report vs contain script predicates)
- R49 T1, T5
- R50 T1
- R51 N/A
- R52 N/A
- R53 OK
- R54 adjacent T16
- R55 N/A
- R56 N/A
- R57 N/A
- RT1 T9
- RT2 T7, T8
- RT3 OK
- RT4 N/A
- RT5 T1, T11, T12, T13
- RT6 isDepartedFromTenant unit test
- RT7 T6, T8, T12
- RT8 T8
- RT9 N/A
- RT10 T10, T12, T14
- RT11 OK

---

# Round 2

Date: 2026-11-14. Subject: plan revision 2.

## Round-1 status

All Critical items and the definer-related items are resolved by the redesign. The rest are
resolved, moot, or partially resolved, as recorded per expert below.

## Functionality findings (round 2)

- **N1 Major:** C6 delivers to residue creators, so C7 overclaims.
- **N2 Major:** a silent stop, with skipped events lost.
- **N3 Major:** removing the pre-check makes an active SCIM-managed member return
  `SCIM_MANAGED_MEMBER`.
- **N4 Major:** the C4 member set omits confirm-key, role change and ownership transfer.
- **N5 Major:** C1 overstates the gate (`team-departure.ts` is skipped).
- **N6 Major:** the runbook predicate disagrees with C4.
- **N7 Minor:** `Timestamptz(3)`.
- **N8 Minor:** worker imports, explicit select, tenant filter.
- **N9 Minor:** the dead `dispatchWebhook`.
- **N10 Minor:** C3's departure definition and the `returnToTenant` interaction.
- **N11 Major (adjacent):** the residue seed recipe.
- **N12 Minor:** approve's own `findFirst`.

## Security findings (round 2)

- **N1 Major:** the C4 member set (PUT, confirm-key).
- **N2 Major:** NULL creator for new rows; the outbox and rollout sources.
- **N3 Major:** C1 overclaims the gate.
- **N4 Minor:** shared bypass grant widened.
- **N5 Minor:** residue creators deliver.
- **N6 Minor:** `dispatchWebhook`.
- **N7 Minor:** silent suppression.
- **N8 Minor:** backfill spec pins.
- **N9 Minor:** manifest delta.
- **N10 Minor:** SCIM group removal plus approve revives shares.

## Testing findings (round 2)

- **N1 Major:** the rollback test's mutation is uncatchable as stated.
- **N2 Major:** the residue seed recipe.
- **N3 Major:** C6 deny cells versus the error path; the worker principal.
- **N4 Major:** the cross-team cell.
- **N5 Major:** unlisted unit tests.
- **N6 Minor:** A10b and A10 refusal cells.
- **N7 Minor:** the C3 departures arm and pinning acceptance 1's path.
- **N8 Minor:** C2 supplied-value cells and the `clock_timestamp` proof.
- **N9 Minor:** the backfill test pattern.
- **N10 Minor:** gate specifics (rls-dml, manifest, column privileges).

## Disposition (plan revision 3)

- C4 extended to six sites, with approve's read stated (func N4/N12, sec N1).
- C5: SCIM guard, audit before `deleteMany`, rollback by a temporary trigger (func N3, test N1).
- C6:
  - the `NOT VALID` CHECK and outbox backfill (sec N2);
  - dedicated bypass grant and explicit select (sec N4, func N8);
  - visibility through GET and the card (func N2, sec N7);
  - residue creators assigned to the runbook (func N1, sec N5);
  - `dispatchWebhook` removed (func N9, sec N6);
  - cells for the worker principal, cross-team, and resume (test N3/N4);
  - backfill pattern and column privileges (test N9/N10, sec N8).
- C1 restated with limits; gate extension moved to SC5 (func N5, sec N3).
- C2: `Timestamptz(3)`, supplied-value and `clock_timestamp` cells (func N7, test N8).
- C3: `GREATEST` definition, the restore and SCIM-group semantics stated (SC6), the departures-arm
  cell, A10/A10b refusal cells (func N10, sec N10, test N6/N7).
- C7: runbook predicates switched to `COALESCE` (func N6).
- C4 residue seed recipe fixed (func N11, test N2).
- Unit test adjust list completed (test N5); gate specifics restated (test N10, sec N9).

## Recurring Issue Check (round 2)

Each expert's R/RS/RT statuses are recorded in their reports. Summary of the flags:
- Functionality: R1, R3, R6, R14, R17, R22, R29, R34, R38, R40, R41, R42, R48, R49, R52.
- Security: R3, R4, R14, R17, R24, R29, R34, R38, R42, R47, R49, R52, R54, R55.
- Testing: R3, R5, R6, R9, R14, R16, R18, R19, R29, R40, R41, R42, R49, R50, RT1, RT2, RT5, RT7,
  RT8, RT10.

All other rules: OK or N/A.

---

# Round 3

Date: 2026-11-14. Subject: plan revision 3.

## Findings

- **Critical** (functionality F3-R3-1, security S3-1 Major, testing T1). The `NOT VALID` CHECK on
  `team_webhooks.created_by_id` is enforced on every UPDATE. Legacy NULL rows fail the worker's
  success and failure health updates: redelivery, no auto-disable, and the secret migration
  fails. This was introduced by the round-2 fix for security N2.
- **Functionality:**
  - F3-R3-2 Major: confirm-key lock budget, timeout and conflict mapping.
  - F3-R3-3 Minor: C3 `>` vs equality.
  - F3-R3-4 Minor: runbook departures arm.
  - F3-R3-5 Minor: two deciders.
  - F3-R3-6 Minor: not-applied list; accept residue recipe.
- **Security:**
  - S3-2 Minor: outbox payload keys and statuses.
  - S3-3 Minor: C6 depends on C1; option to use C4.
  - S3-4 Minor: two deciders.
- **Testing:**
  - T2 Major: Prisma always selects `id`.
  - T3 Major: audit read table; the mutation was misnamed.
  - T4 Major: C4 DB cells deny-only; seeds not otherwise entitled; no re-admitted allow cell.
  - T5 Major: adjust list.
  - T6 Major: equality operator.
  - T7 Minor: rollback trigger scope.
  - T8 Minor: residue seed assertion.

## Disposition (plan revision 4)

- **Critical.** The database guard was withdrawn rather than replaced. Per the
  self-seeding-rounds lesson, the creator column is protected by its single writer plus a unit
  test, and NULL means legacy. Legacy-row health is pinned by C6 cell 6. T5's seeders are
  unaffected.
- **F3-R3-2:** confirm-key form, budget, timeout, mapping and contention cell.
- **F3-R3-3, T6:** `>=` in C3 and C4, with the outcomes stated and an equality cell.
- **F3-R3-4:** the runbook uses both arms (`GREATEST`).
- **F3-R3-5, S3-4:** one `webhookCreatorAuthorized` predicate, plus an agreement cell.
- **F3-R3-6:** the not-applied list is completed; the accept residue recipe is stated.
- **S3-2:** camelCase keys, statuses, and the seed through `buildOutboxPayload`.
- **S3-3:** the dependency is recorded, not adopted (it would widen the worker grant).
- **T2:** `id` is added to the grant and to cell 9.
- **T3:** audit read from `audit_outbox`; the mutations are named correctly.
- **T4:** positive twins, entitled seeds, and the real-DB re-admitted allow cell.
- **T5:** the adjust list is completed.
- **T7:** a row trigger with `WHEN`, plus a seeded key.
- **T8:** the seed runs as superuser and asserts one row.

## Recurring Issue Check (round 3)

Flags as reported:
- Functionality: R3, R6, R17, R22, R38, R40, R41, R42, R49, R52.
- Security: R3, R14, R17, R29, R42, R49, RS2.
- Testing: R3, R9, R14, R16, R19, R29, R42, R49, RT1, RT2, RT5, RT7, RT8, RT10.

All others: OK or N/A.

---

# Round 4 and saturation

Date: 2026-11-14. Subject: plan revision 4. One combined reviewer covered all three perspectives.

- **Round 3:** every finding is resolved, as verified against the code.
- **No new Critical or Major.** Minor items:
  - N4-1: the legacy arm of the predicate, and an agreement cell at risk of tautology;
  - N4-2: C3 NULL semantics;
  - N4-3: `lockActorThenTeam` returns void;
  - N4-4: the grant purpose is unnamed;
  - N4-5: the cost wording.
  All five were applied in place.
- **Saturation call** (Step 1-6):
  - at least two rounds completed (four);
  - no Critical or Major open in any category;
  - no finding against the design;
  - the remaining Minors were fixed rather than carried.
- **Carried-forward findings:** none. The Go/No-Go gate is locked.
