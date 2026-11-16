# Plan Review: session-revocation-failure-surfaces

## Round 1 (2026-11-16)

### Changes from Previous Round
Initial review. The local LLM pre-screen was skipped (Ollama unavailable).

### Functionality Findings
The functionality expert verified:
- Nested `$transaction` inside `withTenantRls` shares the context transaction (`src/lib/prisma.ts` proxy).
- All ten tables have NOT NULL `tenant_id` and tenant-isolation policies.
- All three retry claims hold.
- Every cited command reproduces.
- The R42 set C is complete (adapter `deleteUser` is already gate-forbidden).

| ID | Sev | Finding | Disposition |
|----|-----|---------|-------------|
| F1 | Major | C5 "one implementation" false: `auth.ts` and `member-passkey-revoke.ts` keep tombstone + Sentry copies | Fixed: C5 adopts both, keeping byte-identical log type, message and tags |
| F2 | Minor | C5 per-digest path for a directory-sync batch | Skipped. Anti-Deferral: per-digest keeps per-token failure counts; bulk reports a pipeline failure as all-or-nothing. A batch is one tenant's departing users' sessions, queued on one connection. Worst case: N queued Redis commands after commit, with no correctness impact. Recorded in C5 |
| F3 | Minor | No-deadlock claim per call only | Fixed: directory sync locks the union up front (C2); C1 claim narrowed |
| F4 | Minor | Unbounded user-auth wait; 409 with wrong reason; team DELETE on 5 s default | Fixed: bounded via budget + `UserAuthLockTimeoutError` with its own message (C1); team DELETE timeout (C4); C6 states the 409 path |
| F5 | Minor | Lock-order derivation misses implicit write locks | Fixed: C2 records FK key-share and the bootstrap-migration cycle analysis |
| F6 | Minor | Files-to-update and test consumers missing | Fixed: "Files to update" and "Existing tests that change" |
| F7 | Minor | Batch keys must be byte-identical to `userAuthLockKey` | Fixed: C1, T4 |
| F8 | Minor (Adj) | T1 trigger on an unseeded table never fires | Fixed: T1 seeding (see test F1) |
| F9 | Minor | Team-membership-only ends do not revoke; reason unrecorded | Fixed: "Out of class" paragraph |

### Security Findings
The security expert verified:
- Q1: the tenant-scoped revocation is complete.
- Q2: the mint race closes.
- Q4: the cache claim is true.

| ID | Sev | Finding | Disposition |
|----|-----|---------|-------------|
| S1 | Major | admin-reset: token spent + wipe committed before revocation; retry unreachable | Fixed: C7 revokes before the token CAS; AC6/T7 |
| S2 | Minor | Unbounded wait; multi-statement locking in directory sync | Fixed with F3/F4 |
| S3 | Major | T5 grep guard is surface-form; C2 relied on it as a boundary | Fixed: C8 adds AST gate rule 9 to `check-team-rotation-input-lock.mjs`; C2 restated |
| S4 | Minor | Trigger rejection premises partly false | Fixed: C2 states R48 and the bootstrap-migration reasons |
| S5 | Minor | Lock-class failures answer 409, not 5xx | Fixed: C6, scenario 7 |
| S6 | Minor | Rollback leaves user active; one failure blocks the sync run | Fixed: trade-off paragraph; the existing `ERROR` sync log + `lastSyncError` is the operator signal |
| S7 | Minor | Directory-sync / POST revocations leave no counts | Partially fixed: structured `directory-sync.credentials-revoked` log line. Anti-Deferral for the audit-row part: per-team `TEAM_MEMBER_TENANT_DEACTIVATE` rows and `usersDeactivated` record the departures. A new audit action costs R12 surface (groups, i18n, UI) for counts the departure already implies. Worst case: counts in logs only |

### Testing Findings
| ID | Sev | Finding | Disposition |
|----|-----|---------|-------------|
| F1 | Major | T1 fault cannot fire; no positive control that earlier revocations ran | Fixed: seed `mcp_authorization_codes`, trigger conditional on the session already deleted |
| F2 | Major | Rollback assertions omit mapping, departure record, team rows, keys, invitations, audit | Fixed: AC1 full snapshot |
| F3 | Major | `CREATE FUNCTION` needs a `check-bypass-rls` allowlist entry + drop-before-create | Fixed: T1, files list |
| F4 | Major | Batch lock identity with mint lock untested | Fixed: T6 |
| F5 | Major | Route "rejection propagates" cell green on today's code | Fixed: T4 rejects inside an executed callback; red against today's route |
| F6 | Major | Unlisted breaking tests | Fixed: list in Testing strategy |
| F7 | Major | T5 grep, file-granular, no positive control | Fixed: C8 / T5 |
| F8 | Major | `departCreatedMembership` + route tombstoning untested | Fixed: T2, T4 |
| F9 | Major | T3 must go through the production path under tenant RLS | Fixed: T3 |
| F10 | Minor | AC4 cross-tenant survival holds via RLS | Fixed: T3 note + T4 `where.tenantId` |
| F11 | Minor | No allow cell for non-transition | Fixed: AC7/T8 |
| F12 | Minor | Integration wiring / exact T1 outcome | Fixed: E2, AC1 says 500 |
| F13 | Minor (Adj) | user-auth lock outside the lock budget | Fixed with func F4 (T6 bounded-wait cell) |

### Recurring Issue Check
#### Functionality expert
- R1: F1
- R2: OK
- R3: F6
- R4: N/A
- R5: OK
- R6: OK
- R7–R8: N/A
- R9: OK
- R10: OK
- R11: N/A
- R12: OK
- R13: N/A
- R14: OK
- R15: N/A
- R16: OK
- R17: F1
- R18: OK
- R19: F6
- R20: OK
- R21–R28: N/A
- R29: F3, F5
- R30–R33: N/A
- R34: OK
- R35: OK
- R36: OK
- R37: F4
- R38: OK
- R39: N/A
- R40–R41: OK
- R42: complete; F9
- R43: OK
- R44–R47: N/A
- R48: OK
- R49: F3
- R50: F8
- R51: N/A
- R52: F2
- R53: N/A
- R54: OK
- R55–R57: N/A

#### Security expert
- R1: S3
- R3: checked; admin-reset member (S1)
- R4: S7
- R5: S2
- R9: OK
- R14: OK
- R17: checked
- R22: checked
- R29: S2, S4, S5
- R34: S1
- R38: S1
- R42: S1
- R47: S3
- R48: S4
- R49: S3
- R52: S2, S6
- R54: OK
- Others: n/a
- RS1–RS6: n/a (no new routes, inputs or comparisons)

#### Testing expert
- R1: OK
- R3: F8
- R5: F2
- R9: N/A
- R18: F3
- R19: F6
- R29: OK
- R35: OK
- R42: F7
- R47: F7
- R50: F12
- Others: N/A
- RT1: F5, F6
- RT2: OK
- RT3: N/A
- RT4: F4
- RT5: F4, F9
- RT6: F8
- RT7: F1, F4, F5, F7, F10
- RT8: F1, F2, F5
- RT9: N/A
- RT10: F11
- RT11: F3

## Round 2 (2026-11-16)

### Changes from Previous Round
Round-1 fixes applied: C7 (admin-reset), C8 (AST gate rule 9), bounded user-auth lock, C5 adoption by auth.ts/member-passkey-revoke, and the test plan rework. Round 2 used one combined reviewer covering all three perspectives (incremental round; round 1 had three separate experts). All round-1 dispositions were verified except F3/S2, S3/test F7 and func F1, which were re-opened below.

| ID | Sev | Finding | Disposition |
|----|-----|---------|-------------|
| F-R2-1 | Major | Directory-sync union lock reverses the user-auth order vs C4 team DELETE (team_members row ↔ user-auth cycle) | Fixed: union lock dropped; user-auth is the last lock in every departure/removal tx; C1 deadlock argument restated; T6 lock-order cell |
| F-R2-2 | Major | Rule 9 cannot see team-departure.ts (IMPLEMENTATIONS skip); rule 2 is a regex | Fixed: C8 runs before the skip, classifies with sql-scan.mjs (only literal NULL non-ending), adds fixtures |
| F-R2-3 | Minor | auth.ts exception reason wrong; `<anonymous>` key; tripwire overstated | Fixed: reason (moves sessions, source-tenant only), EXEMPTIONS key, C8 class = tripwire |
| F-R2-4 | Minor | C5 byte-identity not achievable as specified | Fixed: `reason: string \| null`, per-adopter table with deltas, pre-commit tombstone in invalidateUserSessions stated |
| F-R2-5 | Minor | Team routes answer CONFLICT without reason text | Fixed: C6 |
| S-R2-1 | Minor | C7 pre-wipe revocation window | Fixed: recorded and justified in C7 |
| S-R2-2 | Minor | Post-revocation refusal arms unaudited | Fixed: `phase: "aborted"` audit in C7 + unit cell |
| S-R2-3 | Minor | Contention could refuse deprovisioning? | Fixed: queue-order reasoning in C1 |
| T-R2-1 | Major | T1/T7 500 does not prove the trigger fired | Fixed: distinctive raise message asserted on the rethrown error; session seeded in-tenant; predicate pre-check; limiter passes |
| T-R2-2 | Minor | No directory-sync fault cell | Fixed: T2 |
| T-R2-3 | Minor | FUNCTION_RULE_ALLOWLIST per file | Fixed: T1/T7 share one file |
| T-R2-4 | Minor | No unit cell for C7 CAS-miss path | Fixed: T7 unit cells |

### Recurring Issue Check (combined reviewer)
- R1: F-R2-4
- R4: S-R2-2
- R5: F-R2-1
- R9: OK
- R10: OK
- R14: OK
- R17: F-R2-4
- R18: T-R2-3
- R19: OK
- R29: F-R2-1, F-R2-2, F-R2-3, F-R2-5
- R35: OK
- R37: OK
- R38: S-R2-1
- R40: OK
- R42: OK
- R47: F-R2-2
- R48: OK
- R49: F-R2-3, S-R2-1
- R50: T-R2-1
- R52: S-R2-3
- R54: OK
- Others: N/A
- RS1–RS6: N/A
- RT1: OK
- RT2: OK
- RT4: OK
- RT5: OK
- RT6: OK
- RT7: F-R2-2
- RT8: T-R2-1, T-R2-2
- RT10: T-R2-2, T-R2-4
- RT11: OK
- Others: N/A

## Round 3 (2026-11-16)

### Changes from Previous Round
Round-2 fixes applied: union lock dropped, rule 9 moved before the IMPLEMENTATIONS skip and moved onto sql-scan, the C5 adopter table, the C7 aborted audit, and the T1 fault proof. Round 3 used one combined reviewer and checked every contention pair; no cycle beyond those now listed in C1.

| ID | Sev | Finding | Disposition |
|----|-----|---------|-------------|
| F-R3-1 | Major | Revocation lock reused directory sync's spent `transitionBudget`, so an uncontended large batch fails every run | Fixed: `boundedLockWait` creates a fresh budget at the lock; unit cell |
| F-R3-2 | Minor | Deadlock list incomplete (departCreatedMembership × migration, two syncs) | Fixed: cycles (a)–(c) listed in C1 |
| F-R3-3 | Major | `phase:"aborted"` under ADMIN_VAULT_RESET_EXECUTE labelled "executed" and sent to webhooks | Fixed: SESSION_REVOKE_ALL emitted right after the revocation |
| F-R3-4 | Minor | C8 expected set must use gate keys (`<anonymous>`); allow fixture shape | Fixed |
| F-R3-5 | Minor | Helper drops error fields on throw; directory sync row wrong | Fixed |
| S-R3-1 | Minor | Rethrow/CAS-throw arms unaudited | Fixed by F-R3-3's placement (emitted before the CAS) |
| S-R3-2 | Minor | Rule 9 misses Prisma update/create and raw INSERT/UPSERT/MERGE in IMPLEMENTATIONS files | Fixed: C8 member definition widened, fail-closed on unreadable writes |
| T-R3-1 | Critical | T6 lock-order cell green under the regressed ordering | Fixed: park via `team_member_keys` trigger, pg_locks witness, red-proof named |
| T-R3-2 | Minor | Bounded-wait cell had no budget seam | Fixed: hold past TEAM_KEY_LOCK_TIMEOUT_MS |

### Recurring Issue Check (combined reviewer)
- R4: F-R3-3
- R12: F-R3-3
- R29: F-R3-2, F-R3-4, F-R3-5
- R38: F-R3-1
- R42: S-R3-2
- R49: S-R3-1, S-R3-2
- R52: F-R3-1
- RT2: T-R3-2
- RT4: T-R3-1
- RT7: T-R3-1
- RT10: F-R3-3, S-R3-1
- OK: R1, R2, R3, R5, R9, R17, R18, R19, R35, R40, R47, R48, R50, R54, RT1, RT5, RT6, RT8, RT11
- N/A: all others

## Round 4 (2026-11-16)

### Changes from Previous Round
Round-3 fixes applied: fresh-budget bounded lock, deadlock cycles (a)–(c), SESSION_REVOKE_ALL emitted before the CAS, C8 widened, T6 lock-order cell redesigned. One combined reviewer verified every round-3 disposition. It re-walked T6 against the code (sound) and the C8 member set by grep.

| ID | Sev | Label | Finding | Disposition |
|----|-----|-------|---------|-------------|
| F-R4-1 | Major | design | Widened rule 9 flags engine.ts:620 / scim Users POST:200 conditional creates already adjudicated by rule 2 | Fixed: Prisma create/update arm applies only inside IMPLEMENTATIONS files; outside, rule 2 is the one adjudicator; allow fixture added |
| F-R4-2 | Minor | design | analyzeSql has no plain-INSERT kind | Fixed: rule 9 reads the INSERT head from tokens; WRITE_KIND untouched |
| F-R4-3 | Minor | prose | SESSION_REVOKE_ALL renderer keys on `revokedCount`; "other sessions" label | Fixed: `revokedCount` added; label mismatch accepted with reason |
| S-R4-1 | Minor | design (question) | Personal scope invisible to tenant admins | Answered in C7: audience is the target user; admins see the spent token |
| T-R4-1 | Minor | prose | Fresh-budget cell setup | Fixed: `alreadyLocked`, team-less user, allow pair |

### Recurring Issue Check (combined reviewer)
- R4: S-R4-1
- R12: F-R4-3, S-R4-1
- R29: F-R4-1, F-R4-2, F-R4-3
- R47: F-R4-2
- R48: F-R4-1
- RT2: T-R4-1
- OK: R1, R2, R3, R5, R9, R17, R18, R19, R35, R38, R40, R42, R49, R50, R54, RT1, RT4, RT5, RT6, RT7, RT8, RT10, RT11
- N/A: all others

## Round 5 (2026-11-16)

### Changes from Previous Round
Round-4 fixes applied (rule 9's Prisma arm confined to IMPLEMENTATIONS files, the plain-INSERT reader, `revokedCount`, the fresh-budget cell setup). The reviewer verified every round-4 disposition against the code. No Critical or Major.

| ID | Sev | Label (expert's) | Finding | Disposition |
|----|-----|------------------|---------|-------------|
| F-R5-1 | Minor | design | Up to 3 fresh revocation budgets in directory sync can exceed the 10 s tx timeout | Fixed: C1 states the accounting. Accepted: P2028 still rolls back fully; a shared revocation budget would reintroduce F-R3-1 |
| F-R5-2 | Minor | prose | Positive-control keys not literal gate keys | Fixed |
| S-R5-1 | Minor | design | Prisma arm omits updateManyAndReturn/createMany* | Fixed: reuse classifyTenantStateWrite's method set + mayName |
| S-R5-2 | Minor | design | Fail-closed cases for opaque target / unrecognisedWrites / MERGE-insert / column-less INSERT / upsert insert half | Fixed: each stated; fixtures added |
| T-R5-1 | Minor | design | revokedCount not pinned | Fixed: T7 unit assertion |
| T-R5-2 | Minor | design (Phase-2-reachable) | Self-test harness must seed pinned sites; reds must add, not replace | Fixed |

### Exit decision
Exited after round 5 with every finding applied to the plan; none is carried forward.
- Round 5 returned no Critical or Major.
- The saturation criterion's condition 3 (no design-labelled finding) is not met in the strict sense: round 5's Minors carry the expert's `design` label.
- Every one of them concerns either the gate-rule detail or test setup added in rounds 2–4, and each was applied to the plan. Since round 2, each round's findings have been predominantly against the previous round's additions rather than the original design (the self-seeding pattern).
- The remaining surface (gate-rule spellings, harness seeding) is adjudicated by the gate's self-test and by red-proofs in Phase 2.
- The exit is surfaced to the user with this record.

### Recurring Issue Check (combined reviewer)
- R29: F-R5-2
- R42: S-R5-1
- R47: S-R5-2
- R49: S-R5-2
- R52: F-R5-1
- RT7: T-R5-1, T-R5-2
- RT8: T-R5-1
- OK: R4, R12, R48, RT2, RT4, RT10
- N/A: all others
