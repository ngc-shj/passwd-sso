# Code Review: close-coverage-and-clipboard-gaps
Date: 2026-11-22
Review round: 1

## Changes from Previous Round

Initial review. It builds on the Phase 2 self-R-check (D21) and on the external Codex security review (D18).

## Functionality Findings

- **F1 [Major]** `src/components/settings/security/tenant-session-policy-card.tsx` — client `validate()` skips the auto-lock-vs-idle cross-field check when auto-lock is disabled.
  - The server instead coalesces a null auto-lock to `VAULT_AUTO_LOCK_DEFAULT` (15) and rejects idle timeouts below that.
  - Since the server text was removed, that refusal shows only "save failed". The rationale comment claimed `validate()` already names each bad field, which is false (R29/R48).
- **F2 [Minor]** `src/components/team/members/team-invite-by-email-section.tsx` — two failures in the committed-action-reported-as-failure class (D17 class 13), where the create-grant sibling guards both:
  - a JSON parse failure after `res.ok` reports a created invitation as failed;
  - a missing token yields an `invite/undefined` link.
- **F3 [Minor, question]** `src/app/[locale]/recovery/page.tsx` — the client-side Back link stays reachable in the `reset-invalidation-failed` step. The hook says that step needs a full reload.

## Security Findings

- **S1 [Minor]** `src/hooks/vault/use-recovery-flow.ts` — strings outlive their use (R39):
  - the typed recovery key string stays in state after the verify hand-off;
  - the new passphrase strings stay after a committed reset.
- **S2 [Minor, Adjacent]** `src/app/api/vault/change-passphrase/route.ts` — the passphrase change writes no audit event at all, including when invalidation fails, unlike rotate-key and recover. Verified by the orchestrator: no AUDIT_ACTION exists for a passphrase change.

## Testing Findings

- **T1 [Minor]** — several mutation-ledger rows are not re-executable as recorded against HEAD:
  - stale snapshots;
  - "pre" copies derived from HEAD;
  - missing or elided commands.

  The reviewer re-derived and re-ran 33/288 rows (11.5%, all batches). Every row was red on its mutant, so no vacuous test was found. Commands and exit codes are in `p3r1/results.jsonl`.
- **T2 [Minor]** — D16's aggregate comes from a run made before `perFile` was enrolled, so the recorded numbers do not prove the floor was met. Headroom determinism and the app-coverage wall time are unrecorded.
- **T3 [Minor]** — the check-e2e-selectors self-test covers only the class and id "moved" cases. The data-testid, aria-label and data-slot fixes are unproven.
- **T4 [Minor]** — check-coverage-scope has two untested clauses: a non-object summary and a missing CLI argument.
- **T5 [Minor]** — the check-state-updater-purity self-test lacks `clearInterval` and `queueMicrotask` deny fixtures.
- **T6 [Minor]** — decorative `notification-bell.test.ts` remains next to the behavioural `.tsx` suite.

## Adjacent Findings

- **S2** (security → functionality/audit) — see above.
- **Testing → functionality** — the D1 edge case has no test pinning its behaviour. The edge case: `setValue(prev => prev)` leaves `pendingWriteRef` set across a key change.

## Quality Warnings

None flagged.

## Recurring Issue Check

### Functionality expert

| Status | Rules |
|---|---|
| OK | R1, R2, R7, R8, R11, R12, R17, R18, R19, R20, R21, R23, R26, R27, R32, R33, R35, R36, R37, R38, R39, R40, R41, R42 |
| Finding | R3 → F2; R29 → F1; R34 → F2; R48 → F1 |
| N/A | all others |

### Security expert

| Status | Rules |
|---|---|
| OK | R1, R2, R3, R7, R17, R18, R19, R25, R29, R33, R35, R36, R37, R38, R42, R43, R49, R50, RS3, RS4 |
| Finding | R34 → S2 (Adjacent); R39 → S1 |
| N/A | all others, including RS1, RS2, RS5, RS6 |

### Testing expert

| Status | Rules |
|---|---|
| OK | R1, R2, R7, R16, R17, R18, R19, R30, R33, R36, R42, R44, R45, R49, R53, RT1, RT2, RT3, RT5, RT6, RT8, RT10, RT11 |
| Finding | R3 → T3; R21 → T1; R29 → T2; R34 → T6; R50 → T4; RT7 → T3, T4, T5 |
| N/A | others |

## Environment Verification Report

| Constraint | Path | Status | Evidence |
|---|---|---|---|
| VE1 (integration suite path-filtered) | Coverage floors | verified-local | Floors computed from unit coverage only; full suite with thresholds exits 0 at HEAD: 1,293 files, 27,344 tests |
| VE1 | Integration suite | verified-local | 170/174 pass; the 4 failing files are pre-existing dev-DB rows (D20) |
| VE2 (clipboard per browser) | Chromium clear and refocus retry; Firefox/Safari residual; Safari create-grant | blocked-deferred | VE2 is the Phase 1 constraint; manual steps in `close-coverage-and-clipboard-gaps-manual-test.md` §2; the unit tests cover the logic with a stateful clipboard fake |

## Resolution Status

(Updated after fixes.)

### F1 [Major] Session-policy cross-field check diverged from the server — resolved
- **Action:** `validate()` now checks the effective auto-lock against the idle caps. The effective value is the entered value, or `VAULT_AUTO_LOCK_DEFAULT` when auto-lock is disabled (the same constant the route uses).
  - The comparison is strict `>`, as on the server.
  - A disabled-case message explains that the default applies.
  - The rationale comment was corrected.
  - The server text is still never shown.
- **Tests:** disabled+idle=10 and disabled+extIdle=10 are refused with no request sent; disabled with 15/15 saves. A mutant using `>=` turns the allow pin red.
- **Modified files:** `src/components/settings/security/tenant-session-policy-card.tsx`; `messages/{en,ja}/TenantAdmin.json`.

### S1 [Minor] Recovery strings retained after use — resolved
- **Action:** the typed key is cleared at the verify hand-off. The passphrases are cleared after a committed reset (2xx or SESSION_INVALIDATE_FAILED). Both are kept on refused attempts (allow pins).
- **Modified file:** `src/hooks/vault/use-recovery-flow.ts`.

### S2 [Minor/Adjacent] Passphrase change was never audited — resolved
- **Action:** new `AUDIT_ACTION.VAULT_PASSPHRASE_CHANGE` with a Prisma enum value and migration `20261122000000_vault_passphrase_change_audit_action`. It is recorded in two phases, mirroring VAULT_RESET_EXECUTED:
  - committed: `logAuditInTx` in the same transaction as the wrap update;
  - completed: best-effort, carrying `invalidationFailed` and the revocation counts.
- **Registration:**
  - personal AUTH group, i18n labels;
  - `check-critical-audit-atomic` CRITICAL_ACTIONS and its self-test;
  - `docs/operations/audit-log-reference.md`.
- **Modified files:**
  - `src/app/api/vault/change-passphrase/route.ts`
  - `src/lib/constants/audit/audit.ts`
  - `prisma/schema.prisma`
  - the migration
  - `messages/{en,ja}/AuditLog.json`
  - `scripts/checks/check-critical-audit-atomic.mjs`
- **Not applied to the shared dev DB:** the auto-mode classifier declined applying the migration, because the DB is shared with the :3000 instance. CI applies it to a fresh DB. Applying it locally is left to the user.

### F2 [Minor] Team invite post-create handling — resolved
- **Action:** `onSuccess()` runs right after `res.ok`. The token is parsed with try/catch and a non-empty-string guard. A missing or unparseable token shows `invitedLinkUnavailable` and nothing is copied.
- **Modified files:** `src/components/team/members/team-invite-by-email-section.tsx`; `messages/{en,ja}/Team.json`.

### F3 [Minor] Back link in the invalidation-failed step — resolved
- **Action:** the Back link is hidden in `reset-invalidation-failed`, and Continue performs `hardNavigate`.
- **Why a full reload is needed:** this was verified. `VaultProvider` (mounted in the locale layout) keeps a stale `recoveryKeyInvalidated`/status across client navigation.
- **Modified file:** `src/app/[locale]/recovery/page.tsx`.

### T1 [Minor] Ledger rows not re-executable as recorded — resolved by re-execution record
- **Action:** the reviewer re-derived 33 of 288 rows against HEAD 82290f40a, building control and mutant from the HEAD source and the stated mutation. All 33 gave control exit 0 / mutant exit 1. Exact commands and exit codes: `scratchpad/p3r1/results.jsonl`.
- **Status of the remaining rows:** the stale rows are historical evidence of red at authoring time. The re-execution above is the C3 quality-bar item 3 record.

### T2 [Minor] D16 measurement predates the perFile enrolment — resolved
- **Action:** D16 is superseded by the HEAD measurement recorded in D22.

### T3 / T4 / T5 [Minor] Gate self-test gaps — resolved
- **Action:**
  - check-e2e-selectors gained M5–M10 for data-testid, aria-label and data-slot, each red-proved against its own section reverted to BRE.
  - check-coverage-scope covers the non-object summary and the missing CLI argument.
  - check-state-updater-purity covers clearInterval and queueMicrotask.
- **Follow-on fix found during T3:** sections 3 and 7 of check-e2e-selectors diffed the whole tree, test files included. A copy added to a test mock masked a real source removal (fail-open), and a test-only removal was over-reported. Both sections are now scoped to changed source files. M11/M12 are red on the previous gate.

### T6 [Minor] Decorative duplicate test — resolved
- **Action:** `notification-bell.test.ts` was deleted. The `.tsx` suite renders the component.

### Adjacent (D1 edge) — resolved
- **Action:** `useLocalStorage` wrote back a hydrated value the user never set after `setValue(prev => prev)` followed by a key change. `pendingWriteRef` now records the key it was set for.

---

# Review round 2

Scope: the round-1 fixes, `git diff 82290f40a..5dc2f7d16`. Round 2 also measured predicates against round 1's state (R43), not only against main.

## Round-1 findings re-verified

- **F1, S1, S2, F2, T1–T6, D1 edge:** all resolved.
- **F3:** continuing, re-raised as N2 below.
- **D1 edge:** the A→B→A variant is re-raised as N3 below.

## New findings

- **T2-1 [Critical]** `src/app/api/vault/change-passphrase/route.test.ts` — the test aliased the transaction client to the ambient `prisma` mock. A mutant that moved `user.update` outside the transaction, or split the audit write into a second transaction, stayed green. The recover route test had the same hole.
- **S-R2-1 [Major]** `scripts/checks/check-e2e-selectors.sh` — scoping sections 3 and 7 to `changed_src` lost git's rename pairing. A selector removed from a renamed `.tsx` passed silently. This is an R43 boundary widening introduced by the round-1 T3 fix.
- **S-R2-2 [Minor]** change-passphrase (and its recover sibling) — the verifier is checked against a snapshot read in another transaction, and the update is unconditional. Two concurrent holders of the old passphrase both pass, and the last write wins.
- **N1 [Minor]** change-passphrase and recover — a comment falsely claimed `withUserTenantRls` cannot share a transaction (R29).
- **N2 [Minor]** `src/app/[locale]/recovery/page.tsx` — the Back link stayed clickable while a reset was in flight. A reset that then committed landed on the stale VaultProvider.
- **N3 [Minor]** `src/hooks/use-local-storage.ts` — `pendingWriteRef` survived an A→B→A key change and wrote back the hydrated value.
- **N4 [Minor]** api-key, SCIM, SA token and JIT approve — a committed create was reported as failed when the 2xx body was unreadable. This is the fourth expansion of D17 class 13, so the class is escalated to contract C11 with a CI guard (R42).
- **T2-2 [Minor]** — the completion audit metadata pinned only 4 of its 10 keys.
- **T2-3 [Minor]** `scripts/__tests__/check-e2e-selectors.test.mjs` — M12 did not pin the removed-side pathspec. A whole-tree `removed=` mutant passed all self-tests.
- **T2-4 [Minor]** D22 — said "four" exact-path ratchets (there are 13) and recorded no reproducing command.

## Resolution Status (round 2)

### T2-1 [Critical] Transaction aliasing in the vault route tests — resolved
- **Action:** the tests now give the transaction client its own mock, distinct from the ambient `prisma`. They assert that the wrap update and the committed audit row are written through the same transaction client.
- **Red-proof:** the update-outside-transaction and split-transaction mutants are red in both route tests.
- **Modified files:** `src/app/api/vault/change-passphrase/route.test.ts`, `src/app/api/vault/recovery-key/recover/route.test.ts`.

### S-R2-1 [Major] Rename pairing lost in the e2e-selector gate — resolved
- **Action:** `changed_src` is computed with `--no-renames`. A renamed file then appears as a delete plus an add, so its removed selectors are seen.
- **Self-tests:** M12b (removed side) and M13–M14 (rename with a removed data-testid or data-slot), each red on the round-1 gate.
- **Modified files:** `scripts/checks/check-e2e-selectors.sh`, `scripts/__tests__/check-e2e-selectors.test.mjs`.

### S-R2-2 [Minor] No compare-and-swap on the vault wrap — resolved
- **Action:** change-passphrase and recover now write with `updateMany` keyed on `accountSalt` from the snapshot. That is the column every vault-wrapping writer moves.
- **Loser of a race:** gets 409 `VAULT_WRAP_CONFLICT`, with no audit row and no session invalidation.
- **Tests:** conflict and allow pins in both route tests.
- **Real-DB proof:** `src/__tests__/db-integration/vault-wrap-cas.integration.test.ts` runs as `passwd_app`, so the users RLS policy applies.
  - **Race setup:** the test holds the user row `FOR UPDATE` and parks both requests on it, confirmed with `pg_blocking_pids`, then releases the lock.
  - **Assertions:** exactly one request gets 200 and the other gets 409. The stored wrap is the winner's. There is exactly one committed audit row.
  - **Red-proof:** a mutant without the `accountSalt` predicate gives `[200, 200]`, for each route.
  - **Stale secret, sent after the first commit:** it is refused by the verifier check (401), not by the compare-and-swap.

### N1 [Minor] False transaction comment — resolved
- **Action:** the comment now gives the real reason, which is that the snapshot's tenantId is already in hand.

### N2 [Minor] Back link during an in-flight reset — resolved
- **Action:** the link is also withheld while the new-passphrase step is loading.

### N3 [Minor] pendingWriteRef across A→B→A — resolved
- **Action:** a pending write is dropped when the key changes away from the key it was set for.
- **Test:** an A→B→A pin.

### N4 [Minor → class C11] Committed mutation reported as failed — resolved by contract C11
- **Action:** see the plan's C11 and deviation D23.
  - The gate `check-mutation-response-read.mjs` found 52 reads in 31 files at the start, and every one was migrated to `parseJsonBodyOnce`.
  - The deny roots were then extended to `src/lib` client modules, which found 12 more.
  - The 13 once-shown-secret sites show "created, but cannot be shown" and copy nothing.

### T2-2 / T2-3 / T2-4 [Minor] — resolved
- **T2-2:** all completion-audit metadata keys are pinned, including the counts.
- **T2-3:** M12b pins the removed-side pathspec.
- **T2-4:** D22 is corrected to 13 ratchets and gives the reproducing command.

## Recurring Issue Check (round 2)

| Expert | Findings by rule |
|---|---|
| Functionality | R3 → N4; R25 → N3; R29 → N1; R38 → N2 |
| Security | R43 → S-R2-1; R51 → S-R2-2 |
| Testing | RT1/RT7 → T2-1; RT7 → T2-2, T2-3; R29 → T2-4 |

All other rules in range were OK or N/A.
