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
