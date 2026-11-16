# Plan Review: member-foothold-containment
Date: 2026-11-16
Review round: 1

## Changes from Previous Round
Initial review. Local LLM pre-screening skipped (Ollama unavailable).

## Functionality Findings
- FF1 Major design (R42, R3) — SCIM DELETE (`deactivateScimUser`) departs a user without C4; bootstrap migration (`src/auth.ts`) also deletes a membership. **Merged with SF1.** → C4 adds the call; bootstrap recorded as exemption.
- FF2 Major design (R5, R52) — C4 before the credential lock forms a cycle with containment (credential lock → SA token rows). → C4 runs after `revokeUsersAuthArtifactsInTx` (credential lock → rows on both sides). **Merged with SF9.**
- FF3 Major design (R5) — C5 lacks 409 mapping for `TenantMemberLockTimeoutError` and a lock position; use the locked role for `isTenantRoleAbove`. → C5 specifies first statement, locked role, `isMembershipLockConflict` → 409. **Merged with SF3.**
- FF4 Major design (R40, R29) — claimed DCR MCP clients carry `createdById` of any member; SCIM GET selects `createdBy` not `createdById`; list components unnamed. → C6: DCR → null; components named.
- FF5 Major design (R40) — vault-reset dialog row has only a UUID; LIST grant lacks `user`. → C7 selects `targetUser {name, email}`, LIST grant gains `user`.
- FF6 Minor prose (R12, R17) — files to change not enumerated. → "Files" section.
- FF7 Minor design (R29) — no `deleteManyAndReturn` in Prisma 7.10.1. → read + `deleteMany` with count-equality rollback.
- FF8 Minor prose (R2) — `ADMIN_VAULT_RESET_REVOKE` `targetUserId` meaning drift. → `initiatedById`.
- FF9 Minor prose (R29) — `TenantPermission` type location; C4 counts plumbing; re-creation case. → C1 moves the type; C4 returns void; re-creation handled by C2 departure-record rule (SF8).
- FF10 Minor design (R1) — C8 should use `getTeamMembership`. **Merged with SF10.**

## Security Findings
- SF1 Critical design (R42, R3, R29) — SCIM DELETE omitted from C4; escalate: false (mechanical). → C4 in `deactivateScimUser`, actor plumbed from the route; gate rule pins every departure writer.
- SF2 Major design (R42) — creators who departed before the upgrade are never swept; `returnToTenant` excluded. → C4 also runs in `returnToTenant`; C6 flags SA tokens whose creator lacks authority so pre-upgrade residue is findable; K6 approve requires a current initiator (SF4).
- SF3 Major design (R42, R5) — C5 omits vault-reset approve. → added to C5.
- SF4 Minor design (R49) — demotion leaves K1/K6. → stated in Considerations; approve CAS requires the initiator active with `MEMBER_VAULT_RESET`.
- SF5 Major design (R42, R49, R17) — delivery-reader member set is textual only. → C10 AST member-set test over `tenantWebhook`/`teamWebhook` reads.
- SF6 Minor design (R14, R46) — `check-bypass-rls` and the helper-reached `tenantMember`. → C3 states the reconciliation (run the gate; inline or documented exemption).
- SF7 Minor design (R15, R56) — rollout window mints NULL-creator webhooks; upgrade-time pausing. → Considerations + release note.
- SF8 Minor design (R48) — tenant verdict has no leftover rule. → C2 reads the departure record (`tenant_member_departures`, worker already granted): departed at/after the row's creation ⇒ false.
- SF9 Minor design (R5) — C4 multi-row updates vs containment. → resolved by FF2 ordering.
- SF10 Minor design (R48) [Adjacent] — C8 belongs in `shareLinkManagerOf`; `/api/share-links/mine` still offers access logs. → option on `shareLinkManagerOf`; `mine` fixed.

## Testing Findings
(The expert's full text was cut off by a model safeguard on re-delivery; its delivered summary is recorded.)
- TF1 Major design (RT4, RT5, RT7) — C5 serialization has no real-DB interleave test or mutation-kill. → interleave cell with a wait-observed guard (RT4).
- TF2 Major — tenant-webhook worker/backfill cells unnamed. → `departed-member-leaked-authority.integration.test.ts`.
- TF3 Major — existing tests to extend not listed. → "Tests" list.
- TF4 Major (RT8, RT10) — guards specified deny-only. → paired allow cells, mutation asserted.
- TF5 Major (RT7) — forbidden patterns not enforced; worker bundle smoke. → C10 + `check-worker-bundle-smoke.sh` in acceptance.
- TF6 Major (R14) — grants manifest / check-bypass-rls / grant-evidence not in acceptance. → added.
- TF7 Major — backfill single cell. → one cell per branch.
- TF8 Major — `created_by_id` without FK escapes schema-derived gates. → stated; no FK by design.
- TF9 Major — `team-departure.test.ts` call-site assertions. → added.
- TF10–12 Minor — containment cell names, i18n namespace files, C2 on real rows. → addressed in Tests.

## Adjacent Findings
- SF10 (functional/UI) — merged with FF10.

## Quality Warnings
None.

## Recurring Issue Check
### Functionality expert
R1 F10 | R2 F8 | R3 F1 | R4 ok | R5 F2,F3 | R6 N/A | R7 N/A | R8 ok | R9 ok | R10 ok | R11 N/A | R12 F6 | R13 ok | R14 ok | R15 ok | R16-R21 N/A | R22 ok | R23-R28 N/A | R29 F4,F7,F9 | R30-R39 N/A | R40 F4,F5 | R41 N/A | R42 F1 | R43-R48 N/A | R49 ok | R50-R51 N/A | R52 F2 | R53-R57 N/A

### Security expert
R1 ok | R2 ok | R3 F1,F2 | R4 N/A | R5 F3,F9 | R6-R8 N/A | R9 ok | R10 ok | R11 N/A | R12 ok | R13 ok | R14 F6 | R15 F7 | R16 N/A | R17 F5 | R18 F6 | R19-R23 N/A | R24 ok | R25-R28 N/A | R29 F1 | R30 N/A | R31 ok | R32-R41 N/A | R42 F1,F2,F3,F5 | R43 ok | R44-R45 N/A | R46 F6 | R47 N/A | R48 F8,F10 | R49 F4,F5 | R50-R55 N/A | R56 F7 | R57 N/A | RS1 N/A | RS2 N/A | RS3 ok | RS4 ok | RS5 N/A | RS6 N/A

### Testing expert
Not recoverable (re-delivery cut off by a model safeguard). Findings it cited: RT4, RT5, RT7, RT8, RT10, R14. Round 2 re-runs the full check.

---

# Plan Review: member-foothold-containment
Date: 2026-11-16
Review round: 2

## Changes from Previous Round
Round-1 findings resolved in the plan (C1–C10 rewritten; C10 added). Round 2 is incremental.

## Functionality Findings
- F1-r2 Major design (R3, R5) — approve's initiator check read unlocked. → C5 `alsoLock: [initiatedById]` in one `lockTenantRows` call; verdict from the locked row. (Merged with SEC-2.)
- F2-r2 Major design (R5, R29) — C5 refusals fire after daily limiters are consumed. → routes `clear()` the consumed keys on C5 refusals.
- F3-r2 Major design (R42, R5) — C10 departure rule passes SCIM DELETE vacuously via its existing exemption. → rule 9 second callee, ordered, own `foothold-end::` exemption prefix.
- F4-r2 Minor (R12) — bootstrap exemption residue. → recorded in Considerations.
- F5-r2 Minor prose (R29) — execute/revoke unclassified; role comparison outside tx. → C5 table classifies them; comparisons move into the tx.
- F6-r2 Minor design (R40) — `computeApproveEligibility` lacks the initiator verdict. → added to C5.
- F7-r2 Minor (R1) — C2 vs team helper. → C2 states the team helper is not refactored.

## Security Findings
- SEC-1 Major design (R42, R3) — C5 writes not fenced against containment. → `lockFootholdWriter` takes the credential lock and checks the session row live after the tenant row.
- SEC-2 Minor — merged with F1-r2.
- SEC-3 Minor design (R5) — directory-sync multi-call vs containment SA step deadlock. → documented (40P01, availability only).
- SEC-4 Minor design (R17, R42, R49) — gate order; C5 member set by grep. → rule 9 asserts order; C10 AST writer member set.
- SEC-5 Minor design (R3) — webhook POST not serialized; listing secrets. → webhook POST under C5; listing secret-field test.
- SEC-6 Minor prose (R2) — reuse `departedSince`. → C2 reuses it, cites the SQL mirror.

## Testing Findings
- T-A Major (RT4, RT5) — interleave guard generic. → `race-helpers.ts` with `pg_blocking_pids`, production function held; mirror cell.
- T-B Major (RT5, RT7) — one of four routes on real DB. → SA mint and approve interleaves; approve initiator real-row cells.
- T-C Major (RT5) — dispatcher no real-DB cell. → added.
- T-D Major (RT7, RT10) — red-proofs/allow cells. → red-proof list; C10 positive controls.
- T-E Major (RT4, RT7) — FF2 cell not forced. → forced interleave.
- T-F Minor — unnamed test files. → named.
- T-G Minor (R42, RT10) — C10 per file. → per call site + enclosing function, SQL lexed.

## Adjacent Findings
None.

## Quality Warnings
None.

## Recurring Issue Check
### Functionality expert
R1 F7 | R2 ok | R3 F1 | R4 ok | R5 F1,F2,F3 | R6-R11 ok | R12 F4 | R13-R28 ok | R29 F2,F5 | R30-R39 ok | R40 F6 | R41 ok | R42 F3 | R43-R57 ok
### Security expert
R1 ok | R2 SEC-6 | R3 SEC-1,SEC-5 | R4 ok | R5 SEC-2,SEC-3 | R6-R8 N/A | R9 ok | R10 ok | R11 N/A | R12 ok | R13 ok | R14 SEC-5 | R15 ok | R16 N/A | R17 SEC-4 | R18 ok | R19-R23 N/A | R24 ok | R25-R28 N/A | R29 ok | R30 N/A | R31 ok | R32-R41 N/A | R42 SEC-1,SEC-4 | R43 ok | R44-R45 N/A | R46 ok | R47 N/A | R48 ok | R49 SEC-4 | R50-R55 N/A | R56 ok | R57 N/A | RS1-RS2 N/A | RS3 ok | RS4 ok | RS5-RS6 N/A
### Testing expert
R1-R13 ok | R14 ok | R15-R41 N/A | R42 T-G | R43-R57 N/A | RT1-RT3 N/A | RT4 T-A,T-E | RT5 T-B,T-C | RT6 N/A | RT7 T-D | RT8 ok | RT9 N/A | RT10 T-D | RT11 N/A

---

# Plan Review: member-foothold-containment
Date: 2026-11-16
Review round: 3

## Changes from Previous Round
C5 rewritten around `lockFootholdWriter`; C10 per-call-site gates; C2 reuses `departedSince`; acceptance rewritten.

## Functionality Findings
- F1-r3 Major design (R5, R42) — bootstrap migration takes the credential lock before deleting the tenant row (inverts C5's order). → migration takes `lockTenantRows(..., "update")` first.
- F2-r3 Major design (R5, R3) — target row not locked. → `alsoLock` includes the target (merged with SEC-7).
- F3-r3 Major design (R5) — unbounded credential lock under FOR SHARE. → bounded `lockUsersAuthArtifacts` (merged with SEC-10).
- F4-r3 Major design (R29, R5) — limiter clear over-clears. → per-route key table; only per-target keys cleared.
- F5-r3 Minor design (R42, RT10) — helper presence, not position. → C10 position rule.
- F6-r3 Minor prose (R12) — error codes. → mapping spelled out.
- F7-r3 Minor prose (R5) — SEC-3 note. → extended (merged with SEC-11).

## Security Findings
- SEC-7 Major design (R3, R42, R5) — merged with F2-r3.
- SEC-8 Major design (R3, R42) — containment is id-bounded; a foothold created after the listing survives. → fence claim restated; C7 returns `remaining` counts, dialog notice.
- SEC-9 Minor design (R42, R49) — templated table names. → unclassified unless keyed.
- SEC-10 Minor prose (R5) — merged with F3-r3.
- SEC-11 Minor prose (R5) — merged with F7-r3.

## Testing Findings
- T3-1 Major design (RT4, RT5) — routes own their transactions; mirror/containment cells not holdable. → departure and containment held via tx-taking production functions; reverse order covered sequentially.
- T3-2 Major design (RT4) — T-E not constructible. → cell restated as no-40P01 only; rule 9 is the order proof.
- T3-3 Minor prose (RT4) — pid / release order. → stated.
- T3-4 Major design (RT7, RT10) — non-race real-DB cells for the helper. → added.
- T3-5 Minor design (R42) — rule 9 branch shape. → self-test case.
- T3-6 Minor prose (RT7) — failing cell per writer/route. → named.
- T3-7 Minor prose (RT4) — backfill role. → stated.

## Recurring Issue Check
### Functionality expert
R1 ok | R2 ok | R3 F2 | R4 ok | R5 F1,F2,F3,F4,F7 | R6-R11 N/A | R12 F6 | R13-R28 N/A | R29 F4 | R30-R39 N/A | R40 ok | R41 N/A | R42 F1,F5 | R43-R57 N/A
### Security expert
R1 ok | R2 ok | R3 SEC-7,SEC-8 | R4 ok | R5 SEC-7,SEC-10,SEC-11 | R6-R8 N/A | R9-R10 ok | R11 N/A | R12-R15 ok | R16 N/A | R17-R18 ok | R19-R23 N/A | R24 ok | R25-R28 N/A | R29 ok | R30 N/A | R31 ok | R32-R41 N/A | R42 SEC-7,SEC-8,SEC-9 | R43 ok | R44-R45 N/A | R46 ok | R47 N/A | R48 ok | R49 SEC-9 | R50-R55 N/A | R56 ok | R57 N/A | RS1-RS2 N/A | RS3-RS4 ok | RS5-RS6 N/A
### Testing expert
R1-R14 ok | R15-R41 N/A | R42 T3-5 | R43-R57 N/A | RT1-RT3 N/A | RT4 T3-1,T3-2,T3-3,T3-7 | RT5 T3-1 | RT6 N/A | RT7 T3-4,T3-6 | RT8 ok | RT9 N/A | RT10 T3-4,T3-5 | RT11 N/A

---

# Plan Review: member-foothold-containment
Date: 2026-11-16
Review round: 4

## Changes from Previous Round
C5 table/locks/errors/limiters, C7 remaining counts, C10 templated-SQL and position rules, acceptance race cells restated.

## Functionality Findings
- F1-r4 Major design (R5, R3) — `lockTenantRows` in the bootstrap migration reads `tenant_member_departures` outside its grant (silently empty). → `AUTH_TENANT_CLAIM_MEMBERSHIP` gains `tenantMemberDeparture`; lock key named `existingTenantId`.
- F2-r4 Major design (R5, R29) — `remaining` counts deliberately unselected rows. → counts only rows created after the GET's `listedAt`, echoed by the dialog.
- F3-r4 Minor prose (R12) — `remaining` absence and types. → stated.

## Security Findings
- SEC-12 Major design (R42, R3, R49) — SCIM-token / MCP-client / service-account POSTs ungated against containment. → added to C5 (class closed).
- SEC-13 Minor design (R29, R5) — approve per-target key is shared (max 5). → not cleared.

## Testing Findings
- T4-1 Major design (RT7, R42) — session fence breaks existing route tests. → existing tests enumerated by import; real-DB ones get a session helper; prisma-mocked ones mock the gate with a call assertion.
- T4-2 Minor prose — session seeding. → shared helper.
- T4-3 Minor prose — per-route status, wait budget, OWNER, backfill markers. → stated.

## Recurring Issue Check
### Functionality expert
R1-R2 ok | R3 F1 | R4 ok | R5 F1,F2 | R6-R11 N/A | R12 F3 | R13-R28 N/A | R29 F2 | R30-R39 N/A | R40 ok | R41 N/A | R42 F1 | R43-R57 N/A
### Security expert
R1-R2 ok | R3 SEC-12 | R4 ok | R5 SEC-13 | R6-R8 N/A | R9-R10 ok | R11 N/A | R12-R15 ok | R16 N/A | R17-R18 ok | R19-R23 N/A | R24 ok | R25-R28 N/A | R29 SEC-13 | R30 N/A | R31 ok | R32-R41 N/A | R42 SEC-12 | R43 ok | R44-R45 N/A | R46 ok | R47 N/A | R48 ok | R49 SEC-12 | R50-R55 N/A | R56 ok | R57 N/A | RS1-RS2 N/A | RS3-RS4 ok | RS5-RS6 N/A
### Testing expert
R1-R14 ok | R15-R41 N/A | R42 T4-1 | R43-R57 N/A | RT1-RT3 N/A | RT4 T4-2,T4-3 | RT5 ok | RT6 N/A | RT7 T4-1,T4-2,T4-3 | RT8 ok | RT9 N/A | RT10 ok | RT11 N/A

---

# Plan Review: member-foothold-containment
Date: 2026-11-16
Review round: 5

## Changes from Previous Round
C5 gains SCIM-token / MCP-client / SA POSTs; limiter and grant fixes; `remaining` via `listedAt`; test enumeration.

## Functionality Findings
- F1-r5 Minor design (R42, R49) — DCR claim ungated; completeness sentence false. → class definition (below).
- F2-r5 Minor design (R42, R3) — SA / MCP-client PUT `isActive: true` undoes containment. → in the class.
- F3-r5 Minor prose (R12) — bootstrap lock failure handling. → `provider_error`, retryable.
- F4-r5 Minor prose (R5) — budgets exceed 5 s tx timeout. → P2028 → 409 accepted.
- F5-r5 Minor design (R29) — `listedAt` boundary. → timestamp baseline removed.

## Security Findings
- F1-r5-sec Major design (R42, R3, R49) — DCR claim, break-glass and emergency-access POSTs missing; "every kind" false. → C5 member set redefined as a code-derived class (create / set creator / re-activate on any containable model), enumerated by C10; table is the derivation result.
- F2-r5-sec Major design (R29, R5) — `createdAt > listedAt` misses claims, clock skew. → `remaining` is a neutral count of live unwritten rows; no timestamp.
- F3-r5-sec Minor prose — bound on `listedAt`. → moot (removed).

## Testing Findings
- T5-1 Major design (RT7, R42) — newly gated POSTs lack real-DB cells and red-proofs. → table-driven real-DB gate cells over every C5 site.

## Saturation note
Round 5's Majors all stemmed from enumerating C5's members by instance; the class redefinition removes that source. Round 6 checks whether any design-level finding remains.

## Recurring Issue Check
### Functionality expert
R1-R2 ok | R3 F2 | R4 ok | R5 F4 | R6-R11 N/A | R12 F3 | R13-R28 N/A | R29 F5 | R30-R39 N/A | R40 ok | R41 N/A | R42 F1,F2 | R43-R48 N/A | R49 F1 | R50-R57 N/A
### Security expert
R1-R2 ok | R3 F1 | R4 ok | R5 F2,F3 | R6-R8 N/A | R9-R10 ok | R11 N/A | R12-R15 ok | R16 N/A | R17-R18 ok | R19-R23 N/A | R24 ok | R25-R28 N/A | R29 F2 | R30 N/A | R31 ok | R32-R41 N/A | R42 F1 | R43 ok | R44-R45 N/A | R46 ok | R47 N/A | R48 ok | R49 F1 | R50-R55 N/A | R56 ok | R57 N/A | RS1-RS2 N/A | RS3-RS4 ok | RS5-RS6 N/A
### Testing expert
R1-R14 ok | R15-R41 N/A | R42 T5-1 | R43-R57 N/A | RT1-RT6 ok/N/A | RT7 T5-1 | RT8-RT11 ok/N/A

---

# Plan Review: member-foothold-containment
Date: 2026-11-16
Review round: 6

## Changes from Previous Round
C5 member set as a code-derived class; neutral `remaining`; table-driven gate cells.

## Functionality Findings
- F1-r6 Major design (R5, R14, R42) — DCR claim's `MCP_CLIENT_CONSENT` grant lacks the gate's tables; runs under bypass. → grant extended; tenant id, gate position and claim-arm-only stated.
- F2-r6 Major design (R5, R29) — no catch arms at the consent / emergency-access sites. → per-site error mapping.
- F3-r6 Minor design (R5, R49) — `permission: null` and tenant id source. → semantics stated; EA tenant is the grant's own id.
- F4-r6 Minor prose (R42) — `isActive: data.isActive` undecidable. → every write is a site (default-deny); routes gate when `isActive === true`.

## Security Findings
- F1-r6-sec Major design (R42, R49) — value-dependent predicate; C10 spellings unstated. → default-deny over every write method and named wrapper; nested / aliased / computed / raw refused; positive control per spelling.
- F2-r6-sec Minor design (R42) — model set is a hand list. → `FOOTHOLD_MODEL` map + schema creator-column check.
- F3-r6-sec Minor prose (R42) — `tenantId` moves / `transition()`. → exempt keys with reasons.

## Testing Findings
- F1-r6-test Major design (RT5) — sequential demotion cell decorative (pre-check refuses first). → held-demotion cell is the gate proof; sequential kept as labelled control.
- F2-r6-test Major design — DCR row setup / assertion target. → recipe and `assertNoWrite` stated.
- F3-r6-test Major prose — EA already transactional; deactivated → TENANT_NOT_RESOLVED. → prose fixed; discriminating cells are held-deactivation and session.
- F4-r6-test Minor — cost, fixtures, mocked limiter. → one file, row shape, fresh users; limiter in unit cells.

## Recurring Issue Check
### Functionality expert
R1-R2 ok | R3 F2 | R4 ok | R5 F1,F2,F3 | R6-R11 N/A | R12 ok | R13 N/A | R14 F1 | R15-R28 N/A | R29 F2 | R30-R39 N/A | R40 ok | R41 N/A | R42 F1,F4 | R43-R48 N/A | R49 F3 | R50-R57 N/A
### Security expert
R1-R5 ok | R6-R8 N/A | R9-R10 ok | R11 N/A | R12-R15 ok | R16 N/A | R17 F1 | R18 ok | R19-R23 N/A | R24 ok | R25-R28 N/A | R29 ok | R30 N/A | R31 ok | R32-R41 N/A | R42 F1,F2,F3 | R43 ok | R44-R45 N/A | R46 ok | R47 N/A | R48 ok | R49 F1 | R50-R55 N/A | R56 ok | R57 N/A | RS1-RS2 N/A | RS3-RS4 ok | RS5-RS6 N/A
### Testing expert
R1-R57 ok | RT1-RT4 ok | RT5 F1 | RT6-RT11 ok/N/A

---

# Plan Review: member-foothold-containment
Date: 2026-11-16
Review round: 7

## Changes from Previous Round
Default-deny C10 writer class, `FOOTHOLD_MODEL` map, per-site error mapping, consent grant, held-demotion gate cells.

## Findings (all Minor; no Critical or Major from any expert)
- Functionality: F1-r7 prose (R42) raw-SQL writer rule overlaps reads → writes only; F2-r7 prose (R49) held demotion non-discriminating for null-permission rows → `heldChange` per row.
- Security: F1-r7-sec design (R42, R49) creator-column name list → derived from schema relations to `User` on tenant-scoped models, seeded not-containable list; F2-r7-sec prose wrapper detection → stated; F3-r7-sec prose scripts/prisma scope → stated.
- Testing: T7-1 design (RT5) → `heldChange`; T7-2 design (RT5) → `isActive: false` negative cell.
All seven were applied to the plan in this round.

## Saturation call (round 7)
- Rounds completed: 7 (≥ 2).
- Open Critical / Major: none (every round-6 Major verified resolved by its expert in round 7).
- Remaining findings: the seven Minors above, each a one-line plan edit, applied; none changes a contract's signature, control class or invariant.
- Labels as filed by the experts: F1-r7 prose, F2-r7 prose, F2-r7-sec prose, F3-r7-sec prose; F1-r7-sec, T7-1, T7-2 design (acceptance-cell / gate-predicate precision).
- Decision: exit to Phase 2. Rounds 3–6 were dominated by instance enumeration of C5's member set, which round 5's class redefinition and round 6's default-deny gate removed; round 7 found nothing above Minor. No carried-forward findings (all applied).

## Recurring Issue Check
### Functionality expert
R1-R5 ok | R6-R11 N/A | R12 F1 | R13 N/A | R14 ok | R15-R28 N/A | R29 ok | R30-R39 N/A | R40 ok | R41 N/A | R42 F1 | R43-R48 N/A | R49 F2 | R50-R57 N/A
### Security expert
R1-R5 ok | R6-R8 N/A | R9-R10 ok | R11 N/A | R12-R18 ok | R19-R23 N/A | R24 ok | R25-R28 N/A | R29 ok | R30 N/A | R31 ok | R32-R41 N/A | R42 F1,F2,F3 | R43 ok | R44-R45 N/A | R46 ok | R47 N/A | R48 ok | R49 F1 | R50-R55 N/A | R56 ok | R57 N/A | RS1-RS2 N/A | RS3-RS4 ok | RS5-RS6 N/A
### Testing expert
R1-R14 ok | R15-R41 N/A | R42 T7-1 | R43-R57 N/A | RT1-RT3 N/A | RT4 ok | RT5 T7-1,T7-2 | RT6 N/A | RT7-RT8 ok | RT9 N/A | RT10 ok | RT11 N/A
