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

---

# Review round 3

Scope: the round-2 fixes and C11, `git diff 5dc2f7d16..cdc3f1fb4`. All round-2 findings were verified as resolved.

On R43, every allow-listed refusal code was checked against the route source, including proxy-level responses and the `withRequestLog` rethrow path. None of them can be emitted after commit, and every predicate narrows relative to 5dc2f7d16.

## New findings

**F-R3-1 [Critical, escalated] `rotateKey` never checks the typed current passphrase**
- **Where:** `src/lib/vault/vault-context.tsx` and `src/app/api/vault/rotate-key/route.ts`. The bug pre-dates the branch and is already on main.
- **Why the server check is vacuous:** `currentAuthHash` is derived from the in-memory secret key, so the server's check always passes for an unlocked client.
- **Effect:** the typed passphrase becomes the new wrapping passphrase and the new verifier. A typo locks the user out permanently, because the same rotation also invalidates the recovery key, the PRF wraps and the EA grants.
- **Hidden by the dialog test:** it mocks an INVALID_PASSPHRASE that the real flow cannot produce.

**S3-1 [Major]** Unlock paths leave key material un-zeroed on failure.
- `unlock`: `secretKey`.
- `unlockWithPasskey`: `prfOutput` and `secretKey`.
- Everywhere: `authKeyBytes`.

**T3-1 [Major]** The C11 gate self-test does not pin the server-module exemption. Three one-step mutants stay green:
- scope widened to every deny root;
- `some` → `every`;
- the namespace-import clause dropped.

**T3-2 [Major]** No test proves that a successful rotation keeps a *copy* of the new key. The alias mutant stays green while the `finally` zeroes the live key.

**T3-3 [Major]** `check-e2e-selectors.sh` section 1 uses `--diff-filter=D` with rename detection on, so a moved route page is never flagged. This is the same class as S-R2-1. `added_pages` is unused.

**F-R3-2 / S3-5 [Minor]** VAULT_WRAP_CONFLICT and KEY_VERSION_MISMATCH prove that another writer moved the wrap, yet the vault stays unlocked on the stale material.

**F-R3-3 [Minor]** A lock that fires while the rotate POST is in flight is undone: the 2xx writes the new key material into the locked provider.

**S3-2 [Minor]** The retired secret key is not zeroed when a rotation succeeds.

**S3-3 [Minor]** `recovery-key/generate` is a vault-wrapping writer, but it has no CAS and its audit is not in the transaction. A concurrent rotation can leave a recovery wrap of the retired key.

**S3-4 [Minor]** The C11 gate has undeclared bypasses, and one live member is still unmigrated.
- **Bypasses:** `.catch`, chained `.then`, `["json"]` element access, destructuring.
- **Unmigrated member:** the `Promise.all` passkey-options read in vault-context.

**S3-6 / F-R3-4 [Minor]** Team key rotation is a missed D24 member. An unknown outcome is reported as failed, and the cached old team key is kept.

**T3-4 [Minor]** `vault-wrap-cas` does not await the in-flight requests when the race setup fails.

## Resolution Status (round 3)

Red-proof ledgers are in the scratchpad: `r3-fix-a/`, `r3-fix-b/` and `r3-fix-c/`, each with a `ledger.md`.
- **Every new test** fails against the pre-fix copy or a named mutant.
- **Every deny pin** has an allow pin, red on an over-broad mutant.

### F-R3-1 [Critical] Rotation did not verify the typed passphrase — resolved
- **Client:** `rotateKey` sends `currentVerifierHash`, computed from the typed passphrase and the current salt.
- **Server:**
  - It requires the field and verifies it against the stored verifier before any transaction, using the same helper and pepper handling as change-passphrase.
  - A wrong verifier gives 401 `INVALID_PASSPHRASE`; a missing verifier gives `VERIFIER_NOT_SET`.
  - The existing `currentAuthHash` check is kept.
  - `newVerifierHash` is now required as well. Before, a payload without it rotated the salt but left a verifier that could never match again. Only the web client calls this route.
- **Early refusal:** the client checks the passphrase locally first, so a wrong one is refused before any re-encryption.
- **Tests:**
  - route: a wrong verifier gives 401 with no transaction;
  - route: a stale tab after a passphrase change elsewhere is refused;
  - route: a missing field gives 400;
  - allow pin: a correct passphrase rotates;
  - the dialog's INVALID_PASSPHRASE case now follows a reachable flow.

### F-R3-2 / S3-5 — resolved
- VAULT_WRAP_CONFLICT and KEY_VERSION_MISMATCH now lock the vault and throw `VaultChangedElsewhereError`.
- The dialogs show a persistent "changed in another tab or device; locked" notice.
- INVALID_PASSPHRASE still keeps the vault unlocked. That side is pinned with a lock-on-every-refusal mutant.

### F-R3-3 — resolved, with one extension
- A lock counter is bumped by `lock()` and by the pagehide/unmount zeroing.
- **Lock during the POST:** a 2xx does not install the key. `ROTATION_COMMITTED_VAULT_LOCKED` is returned and a warning is shown.
- **Lock while the rotation is being prepared:** the POST is never sent and `ROTATION_NOT_STARTED_VAULT_LOCKED` is returned. The counter is checked before ECDH re-encryption and again just before the POST.
- `changePassphrase` skips its ref update when a lock happened meanwhile.
- **Residual:** mode-0 → mode-2 attachment migration PUTs that started before the lock may still finish. They are complete writes under the old key, so nothing is lost.

### S3-1 / S3-2 — resolved
- One `finally` per function zeroes `secretKey`, `prfOutput` and `authKeyBytes` on every path of `unlock`, `unlockWithPasskey`, `unlockWithStoredPrf`, `setup` and rotate.
- The retired key is zeroed before the new one is installed.
- Allow pins: successful unlocks keep a working copy, using an alias mutant at three sites.

### S3-3 — resolved
- `recovery-key/generate` writes with a CAS on `accountSalt` and `keyVersion`.
- A lost CAS gives 409 VAULT_WRAP_CONFLICT with no audit row; a won CAS writes `logAuditInTx` in the same transaction.
- `RECOVERY_KEY_CREATED` and `RECOVERY_KEY_REGENERATED` were added to `check-critical-audit-atomic`.
- **Real-DB proof:** `vault-wrap-cas` gained four parked-race cells: an unchanged writer (allow), a rotation, keyVersion only, and salt only. They are red on the pre-fix route and on each predicate-drop mutant.
- `VERIFIER_NOT_SET` moved into the shared pre-commit list. A set-equality check confirms the three resulting sets are unchanged.

### S3-4 — resolved
- **Value tracking:** the gate tracks promise and Response values through `.catch`/`.finally`, `.then` chains, aliasing and `??`/`||`/`&&`. It follows Promise.all/allSettled element by element and treats race/any as the response itself.
- **Reads:** any body reader counts (`json`, `text`, `blob`, `arrayBuffer`, `formData`, `bytes`), whether reached through member or element access, destructuring, or `clone()`.
- **Remaining declared bypasses:** a value that crosses a function or container boundary, and raw `fetch`, which eslint already bans.
- **Self-test:** 23 new deny rows and 7 new allow rows, each red on the pre-change gate.
- **Unmigrated member:** the Promise.all passkey-options read now goes through `readPasskeyOptions(parseJsonBodyOnce(…))`.

### S3-6 / F-R3-4 — resolved
- The team rotate button has a route-enumerated pre-commit refusal list. Any other outcome invalidates the cached team key, shows an "outcome unknown" toast and refreshes.
- Pins:
  - an allow pin;
  - an over-broad mutant;
  - a C11 pin that an unreadable 2xx counts as committed.

### T3-1 — resolved
- New deny rows: the exemption does not apply outside `src/lib`.
- New allow rows: mixed type and value imports, and namespace imports.
- Each row is red on its own mutant.
- The namespace mutant turned out to be equivalent under the old predicate, so the predicate was rewritten until each clause is load-bearing. One consequence: an empty `import {}` no longer counts as a marker, which fails closed.

### T3-2 — resolved
- The success tests assert that `getSecretKey()` is non-zero and opens the sent verification artifact.
- They are red on the alias mutant.

### T3-3 — resolved
- `deleted_pages` uses `--no-renames`, and the unused `added_pages` is removed.
- Self-tests: R1, a moved referenced page, is flagged and red on the old gate; R2, a moved unreferenced page, is allowed.
- No other `git diff` in the script relies on D/A filters with rename detection on.

### T3-4 — resolved
- `raceParkedOnUpdate` awaits `Promise.allSettled(requests)` after releasing the blocker.

---

# Review round 4

Scope: the round-3 fixes, `git diff cdc3f1fb4..e98ff648c`.

**Resolved from round 3:** F-R3-1, S3-3, S3-6, T3-1 to T3-4, and the `checkStoredVerifier` migration (behaviour-equivalent at all five sites). The round-3 ledgers were re-executed and match.

**R43:** no widening. The rotate predicate, the refusal sets (FORBIDDEN removed) and the generate CAS all narrow.

**Rotate as a guessing oracle:** not a finding. It is limited to 3 per 15 minutes, the same as change-passphrase, and offline guessing through `unlock/data` already dominates.

## New and continuing findings

- **F-R4-1 / S4-1 [Major, continuing F-R3-3]** — `rotateKey` compares the lock counter and *then* awaits the body read before installing keys. A lock during the read installs keys into a locked provider and shows "rotated successfully".
- **S4-3 [Major]** — the decrypted ECDH private key buffer is never zeroed in `unlock`, `unlockWithPasskey` or `unlockWithStoredPrf`.
- **T4-1 [Major]** — the `not-set` branch of the recover reset step is unpinned.
  - **Mutant:** deleting it passes all 22 tests.
  - **Effect under the mutant:** the request falls into the CAS write without proof, which fails open.
- **T4-2 [Major]** — in the C11 gate self-test, 11 rewritten tracker clauses have green mutants that are real false negatives, and 2 allow sides are unpinned.
- **T4-3 [Major]** — the pagehide/unmount lock-counter bump is unpinned.
- **S4-4 [Major]** — the gate resolves an imported helper to the first exported helper with the same name.
  - **Effect:** a false negative.
  - **Header claim:** that same-name helpers "can only over-report" is false.
- **F-R4-2 / S4-2 / A4-1 [Minor]** — proven-stale refusals keep the vault unlocked. Three cases:
  - a rotate `INVALID_PASSPHRASE` after the local check passed;
  - a change-passphrase `INVALID_PASSPHRASE` from a stale tab;
  - a generate `VAULT_WRAP_CONFLICT`.
- **F-R4-3 [Minor]** — a lock while the operation is being prepared surfaces as an error into an unmounted dialog instead of "not started". `changePassphrase` also captures the lock counter only after two key derivations.
- **F-R4-4 [Minor]** — `ROTATION_COMMITTED_VAULT_LOCKED` drops `rotationEffects`, so the "sign out other devices" banner is lost.
- **F-R4-5 / S4-A1 [Minor]** — the rotate dialog shows the change-passphrase hint for `VERIFIER_NOT_SET`. The hint does not say the unlock must use the passphrase, so a passkey-only user loops.
- **F-R4-6 [Minor, regression from the round-3 side-fix]** — the notification-bell delete decides the badge change from the render-time `isRead`. If a mark-read request is still in flight, the badge is decremented twice.
- **T4-4 [Minor]** — older C11 clauses are unpinned, and `let f2 = fetchApi` is an undeclared bypass.
- **A4-2 [Minor]** — the pagehide zeroing bumps the lock counter but leaves `vaultStatus` as UNLOCKED.

## Process note

Many round-4 findings continue the round-3 lock-counter fix, which was a point check at a single await. These are fixed structurally rather than site by site:
- a single synchronous install function is the only writer of key material, and it refuses when any lock has happened since the flow started;
- the lock is checked after every await in the key-changing flows;
- each `checkStoredVerifier` call site is written so that deleting a mapping degrades to a refusal.

## Resolution Status (round 4)

Red-proof ledgers are in the scratchpad: `r4-fix-a/`, `r4-fix-b/` and `r4-fix-c/`, each with a `ledger.md`. Every new test is red on the pre-fix copy or on a named mutant, and every deny pin has an allow pin.

### F-R4-1 / S4-1 / F-R4-3 / F-R4-4 / T4-3 / A4-2 — resolved structurally
- **One drop path.** `dropKeyMaterial()` is the only place that bumps the lock counter and drops keys. `lock()` and the pagehide/unmount zeroing both call it.
  - Pagehide now sets LOCKED (A4-2). The two drop paths had drifted: the old pagehide path left the wrap and the encryption key resident.
- **One install path.** `installKeyMaterial(epoch, …)` is synchronous and is the only writer of key material, for setup, the three unlock paths, `changePassphrase` and `rotateKey`.
  - It refuses if a lock happened since the flow began, and nothing is awaited between its check and its writes.
  - The unlock paths used to write the refs, then await the ECDH decrypt, then set UNLOCKED. A pagehide in between left keys in a page cached for back/forward navigation. This was not reported, but it is in the same class, so it was fixed too.
- **Lock checks after every await.** `lockedSince(epoch)` runs after every await in `changePassphrase` and `rotateKey` that precedes a ref read or a request.
  - In `rotateKey`, a throw caused by a lock before the request is sent (`!sent && lockedSince`) becomes `ROTATION_NOT_STARTED_VAULT_LOCKED`.
  - In `changePassphrase`, the epoch is now captured at entry. Before, it was captured after the two key derivations.
- **Committed but locked keeps its effects (F-R4-4).** A 2xx under a lock reads the body but does not install it. The rotate result `{outcome: ROTATION_COMMITTED_VAULT_LOCKED, effects}` carries the effects; for change-passphrase it is `{invalidationFailed}`. The dialogs render the same banners.
- **T4-3.** Pagehide during an in-flight rotate or change POST is now pinned: nothing is installed.
- **Migration-loop checks.** Each check, before an attachment GET, a migrate PUT and the refetch, is pinned by the number of requests sent after the lock.
- **Interrupted unlock.** An unlock interrupted after the server accepted the credential throws `VAULT_UNLOCK_INTERRUPTED` and shows a neutral "interrupted, try again" message.
  - It is never reported as a wrong passphrase, and it is never counted toward lockout.
  - `resolveUnlockError` now requires every caller to supply that message.

### F-R4-2 / S4-2 / A4-1 — resolved
- `changePassphrase` and the recovery-key dialog now check the passphrase locally first, as `rotateKey` already did. A server `INVALID_PASSPHRASE` after a passing local check therefore proves the verifier moved elsewhere.
  - That refusal, and the generate route's `VAULT_WRAP_CONFLICT`, now `lock()` and show the "changed elsewhere" notice.
  - A local typo stays an inline error with the vault unlocked. That side is pinned with a lock-on-every-refusal mutant.
- The recovery-key flow captures the epoch at its start:
  - **Lock before the POST:** nothing is sent, and a "not created" notice is shown.
  - **Lock after a committed 2xx:** the key is zeroed, never shown, and a persistent notice says a new key was created and the previous one no longer works.

### S4-3 — resolved
The decrypted ECDH private key buffer is zeroed in each unlock function's `finally`. So are the `buffer.slice` copies in setup and in the rotate re-wrap, which had the same problem.

### F-R4-5 / S4-A1 — resolved
- The rotate dialog has its own `VERIFIER_NOT_SET` message. It and the change-passphrase hint now say to unlock once *with the passphrase, not a passkey*.
- Requiring a stored verifier for rotation is the security property, so passkey-only users are told how to establish one.

### F-R4-6 — resolved
- **Mechanism:** a write-through `writeNotifications()` updates a ref and the state together. The delete and mark-read responses decide the badge change from the latest list at response time.
- **Tests:**
  - "mark-read then delete" and "delete then mark-read" each decrement once;
  - both responses arriving in the same `act` decrement once. This is red under a `useLayoutEffect`-synced ref, which shows why the write-through is needed.

### T4-1 — resolved
- All six `checkStoredVerifier` call sites now read `if (verifier !== "ok") return verifier === "not-set" ? … : …`. Deleting a mapping at any site degrades to a refusal, which was proved per site.
- The reset step has a new `not-set` test that asserts nothing is written, audited, invalidated or cleared. It is red on the deletion mutant of the previous code.

### T4-2 / T4-4 / S4-4 — resolved
- **S4-4:** `helperFor` now resolves an imported helper through its import specifier.
  - Supported forms: `@/` and relative paths; index files; renamed, default and namespace imports; and re-exports, with loop protection.
  - An unresolvable or ambiguous case takes the most cautious verdict across same-name helpers.
  - The false header claim was rewritten.
- **T4-4 alias:** any alias of `fetchApi` (const, let or var, a later assignment, a destructured binding or a parameter default) is now a source.
- **Self-test:** it grew from 75 to 130 rows. All 60 mutants are red: the reviewer's list plus the agent's own sweep of the clauses it touched.

---

# Review round 5

Scope: the round-4 fixes, `git diff e98ff648c..f82f44b3f`.

All round-4 findings are resolved:
- **install/drop:** the only writer of key material is confirmed by grep. No await sits between a `lockedSince` check and the use it guards.
- **`VAULT_UNLOCK_INTERRUPTED`:** unreachable for a wrong credential, so lockout accounting is intact.
- **Stored-verifier sites:** all six fail closed.
- **R43:** no widening.
- **Ledgers:** the round-4 ledgers were re-derived and hold. The C11 ledger copies two stale mutant trees; those were rebuilt and are red.

No Critical findings. Two Major findings, both missing tests.

## Findings

- **T5-1 [Major]** — page hide during passkey or stored-PRF unlock is untested. Two kinds of mutant stay green: one that returns false instead of throwing `VAULT_UNLOCK_INTERRUPTED`, and one that reads the epoch at install time instead of at the start. Only the `unlock` path is pinned (R3).
- **T5-2 [Major]** — zeroing of key buffers is untested. The fills of `dropKeyMaterial`, and the setup and rotate ECDH working copies, have green mutants.
- **F-R5-2 [Minor, R39/R42]** — two status transitions bypass `dropKeyMaterial`. The render-time LOCKED on session end and the switch from UNLOCKED to SETUP_REQUIRED both leave keys resident without bumping the epoch. This contradicts the round-4 claim that there is a single drop path.
- **S5-1 / F-R5-1 [Minor, R48]** — a missing pepper (an operator misconfiguration) maps to INVALID_PASSPHRASE.
  - After a passing local check, the client reads that as "changed elsewhere" and locks on every retry.
  - travel-mode/disable counts it toward the user's lockout.
- **S5-4 [Minor, R39]** — the entry, history and CEK-rewrap loops in `rotateKey` keep decrypting after a lock.
- **S5-2 [Minor, R49]** — the C11 gate misses a renamed `fetchApi` import and a default-exported const helper. Both are pre-existing, but the round-4 resolution claims coverage of them.
- **S5-3 / T5-6 [Minor, R47]** — Check E's use count can be evaded through an import alias, export lines or a local alias. The setup-route cap is unpinned.
- **F-R5-3 [Minor]** — the recovery-key unknown outcome under a lock goes to `setError` on a dialog that has already unmounted.
- **F-R5-4 [Minor]** — the recovery-key `VERIFIER_NOT_SET` message still omits "with your passphrase, not a passkey".
- **F-R5-5 / T5-5 [Minor]**
  - A list refetch between a request and its response suppresses a valid badge decrement.
  - The `isRead` guard, the missing-item delete guard and the mark-all ref write are unpinned.
- **F-R5-6 [Minor]** — `recoveryKeyCommittedVaultLocked` claims a previous key existed, even for a first-time user.
- **T5-3 / T5-4 / T5-7 [Minor]** — three coverage gaps:
  - a refusal after a lock returning not-started is unpinned;
  - the lock check before the rotate-key/data GET is unpinned;
  - the bfcache pageshow test never reaches its `lock()` branch, and its title says otherwise.

The severity trend across rounds is Critical in round 3, six Majors in round 4, and two test-only Majors in round 5. No production defect above Minor remains.

## Resolution Status (round 5)

Red-proof ledgers are in the scratchpad: `r5-fix-a/`, `r5-fix-b/` and `r5-fix-c/`, each with a `ledger.md`. Every new test is red on the pre-fix copy or on a named mutant, and deny and allow pins are paired.

### F-R5-2 — resolved
- **Lint constraint.** Calling `dropKeyMaterial` from an effect is refused by `react-hooks/set-state-in-effect`. So the ref half is split out as `dropKeyRefs` (bump the epoch, then zero and null the refs), and the two transitions are wired as follows:
  - **Session end.** A render-time `unauthenticated && UNLOCKED` sets LOCKED. A layout effect syncs `sessionStatusRef` and calls `dropKeyRefs()` while a key is held. `installKeyMaterial` also refuses once the session is unauthenticated.
  - **SETUP_REQUIRED.** `checkVaultStatus` drops first when a key is held.
- **Every remaining `setVaultStatus` / `setEncryptionKey` call was enumerated.** No transition away from UNLOCKED now skips the drop.
- **Error code on a refused install.** An unlock refused because the session ended throws `UNAUTHORIZED`, which leads to sign-in; it no longer throws INTERRUPTED, which would loop.
- **Stale status responses.** These are now ignored: only the latest request applies, and a setup-required verdict is discarded once a key has been installed since its request started.

### T5-1 / T5-2 / T5-3 / T5-4 — resolved
- **T5-1.** The interrupted unlock (pagehide) and the session-expired unlock are each an `it.each` over all three unlock paths.
- **T5-2.** Zeroing is pinned for the secret-key ref, the ECDH ref, and the setup and rotate ECDH working copies, each with a non-zero allow pin.
- **T5-3.** A refusal received after a lock reports not-started, for both change and rotate.
- **T5-4.** A lock before the data GET means no GET is sent.

### T5-7 — resolved by removal
- The bfcache pageshow guard was dead code.
- **Why it could never act:** pagehide queues the LOCKED update at the same priority the guard would use, a page frozen before it renders applies it on restore, and a freeze with no pagehide leaves the key in place, so the guard's condition is false there anyway.
- The guard and its vacuous tests were removed. The remaining test pins that pagehide drops the keys and the vault stays locked across a persisted pageshow.

### S5-4 — resolved
Each of the entry, history and CEK loops checks `lockedSince` on every iteration. Each loop has its own pin based on decrypt counts.

### S5-1 / F-R5-1 — resolved
- **Server.** `checkStoredVerifier` returns `"unavailable"` when the pepper version is missing; the audit is still written. All six sites map it to 503 SERVICE_UNAVAILABLE, keeping the fail-closed shape. travel-mode/disable no longer counts it toward the user's lockout.
- **Client.** 503 is a pre-commit refusal, so the vault stays unlocked and an inline "retry later" message is shown.
- **Allow side.** A genuinely wrong verifier still locks after a passing local check.

### F-R5-3 / F-R5-4 / F-R5-6 — resolved
- **F-R5-3.** A recovery-key unknown outcome while locked becomes a persistent toast.
- **F-R5-4.** `ApiErrors.verifierNotSet` and the recovery dialog's own hint now say to unlock with the passphrase, not a passkey.
- **F-R5-6.** The committed-locked and outcome-unknown wording depends on whether a previous key existed.

### F-R5-5 / T5-5 — resolved
- **Mechanism.** The badge decrement is decided by a per-id set of ids already accounted for, shared by mark-read, delete and mark-all, rather than by the list's contents.
- **Pins:**
  - a refetch arriving in between;
  - a double click;
  - a double delete;
  - mark-all followed by a poll.

### S5-2 / S5-3 / T5-6 — resolved
- **C11 gate.**
  - **New sources:** any import binding of `fetchApi`, under any local name or through any re-export, including `export const x = fetchApi` and export clauses over local aliases.
  - **Default exports:** `export default <ident>` is followed. An unresolvable default takes the most cautious verdict.
  - **Crash fixed:** a recursion crash on mutual re-exports was found and fixed, with a termination row.
  - **Remaining declared bypasses:** call results (`wrap(post)`), the function or container boundary, and raw `fetch`.
- **Check E.** Re-implemented on the AST: renames, aliases, re-exports, namespace access and export lines are counted, and the setup-route cap is pinned. 12 deny rows and 3 allow rows were added.

---

# Review round 6

Scope: the round-5 fixes, `git diff f82f44b3f..577dc810b`.

**Round-5 findings:** all resolved. The round-5 ledgers were re-derived on HEAD, because r5-fix-a had run on a pre-simplify control.
- **backup-db:** the old-trap mutant is red 3/3 deterministically, not only under load.
- **R43:** no widening. UNAUTHORIZED and INTERRUPTED are unreachable for a wrong credential, and the 503 is unreachable for a wrong verifier.

There are no Critical findings. The one Major finding concerns test infrastructure (T6-3).

## Findings

- **T6-3 [Major, test infrastructure]** — the `runScript` timeout sends SIGTERM, which bash defers until the foreground child returns.
  - A hung child command (a stub, `docker exec`, `pg_*`) hangs the synchronous cell indefinitely.
  - The comment claiming "a hung run is still stopped" is false.
- **S6-1 [Minor, R39]** — the session check in `installKeyMaterial` is level-based.
  - A user switch from A to B (authenticated → authenticated) keeps A's key material installed.
  - An unlock started under A can install under B's session.
- **S6-2 [Minor, R38]** — a genuine `setupRequired` is discarded, not re-asked, after an intervening unlock install.
- **F6-1 [Minor, R38]** — an in-flight status response is applied after the session ends. A signed-out user is then shown the setup wizard.
- **F6-4 [Minor, R49]** — setup refusals VAULT_ALREADY_SETUP and a POST 401 end in a generic `setupError`, with no LOCKED transition and no route to sign-in.
- **F6-3 / S6-7 / A6-1 [Minor, R3]** — `share-links/verify-access` is a seventh pepper caller that still maps MISSING_PEPPER_VERSION to "wrong password", with a failed-attempt audit row.
- **F6-2 [Minor]** — the travel-mode card renders 503 and 429 as a generic failure.
- **S6-3 / F6-5 / A6-2 [Minor, R49]** — backup-db cleanup can still be interrupted between `trap - EXIT` and `trap :`.
- **S6-4 / F6-A1 [Minor]** — with `set +e`, a failed passfile or partial removal exits 0 without any output.
- **T6-4 [Minor]** — `trap :` versus `trap ''` is unpinned.
- **T6-1 / T6-2 [Minor]** — the layout-effect ordering and the position of the install count relative to the refusal check are unpinned.
- **S6-5 / T6-6 [Minor, R49]** — the C11 gate misses `fetchApi` aliases reached through a namespace member, an `export *` barrel, a property alias, destructuring, or `.bind`.
- **S6-6 / T6-5 [Minor, R47]** — Check E misses aliases built from expressions and computed-key spellings.

## Process note — the gate mechanism changes from detection to refusal

The C11 gate and Check E were evaded by new spellings in rounds 4, 5 and 6, and each round added detection for the spellings reported. Following the escalation rule (a gate escaped twice means changing the mechanism), both gates now refuse the undecidable class outright:
- **`fetchApi`:** it may be referenced only as a direct callee or as a plain import. Any other value use is refused, except at an explicit allowlist of the three real injection sites, whose receiving parameters are tracked as sources.
- **`INITIAL_VAULT_KEY_VERSION`:** it may appear only in its definition, in a plain import or re-export, and once as the direct `keyVersion:` value in each of the two setup sites.

## Resolution Status (round 6)

Red-proof ledgers are in the scratchpad: `r6-fix-a/`, `r6-fix-b/` and `r6-fix-c/`, each with a `ledger.md`. Every new deny pin is red on HEAD or on a named mutant, and is paired with an allow pin.

### T6-3 / T6-4 — resolved
- `runScript` now defaults to `killSignal: "SIGKILL"`. A stub that sleeps 30 s is stopped in under 2 s; without the default, the mutant hangs for 30 s.
- `trap :` versus `trap ''` is pinned by a cell that sends a signal during cleanup: the signal must still be able to kill the run.

### S6-1 / F6-1 / S6-2 / T6-1 / T6-2 / F6-4 — resolved
- **S6-1.** A user switch between two defined user ids drops the keys and moves the epoch, so an unlock started under A installs nothing under B. A refetch for the same user, or one that carries no user id, keeps the vault unlocked.
- **F6-1.** A status response that arrives after the session ends is ignored.
- **S6-2.** After an intervening unlock install, a setup-required verdict triggers a re-ask instead of being discarded. If the re-ask confirms a reset, the vault goes to SETUP_REQUIRED and no unlock installs into it.
- **T6-1.** The session sync runs as a layout effect. An unlock POST that resolves in the commit that ends the session reports UNAUTHORIZED.
- **T6-2.** The install count is bumped only after a successful install, so a refused unlock does not trigger a re-ask.
- **F6-4.**
  - VAULT_ALREADY_SETUP moves the vault to LOCKED and unlock then works.
  - A 401 on setup throws UNAUTHORIZED, and the wizard shows the session-expired card with a route to sign-in.

### F6-3 / S6-7 / A6-1 — resolved
- **Server.** `share-links/verify-access` maps MISSING_PEPPER_VERSION to a VERIFIER_PEPPER_MISSING audit and a 503, with no VERIFY_FAILED row. Every other non-ok reason is still refused as an incorrect password.
- **Why it stays separate.** The check stays local to the route because the actor is anonymous and `checkStoredVerifier` needs a userId.
- **Client.** The share-password gate already mapped 503 to a "retry later" message without counting the attempt.
- **Remaining callers.** No other caller of `verifyPassphraseVerifier` exists. The remaining HMAC verifier callers are writers under the current version.

### F6-2 — resolved
The travel-mode card maps RATE_LIMIT_EXCEEDED to `rateLimited` and SERVICE_UNAVAILABLE to `retryLater`.

### S6-3 / F6-5 / A6-2 / S6-4 / F6-A1 — resolved
- **Window closed.** `trap :` is armed before `trap - EXIT`. `on_signal` returns when it runs inside cleanup, which closes the window around `local rc=$?`.
- **Silent exit 0 fixed.** A passfile that `rm` fails to remove, or that still exists afterwards, is reported with its path. That run exits 1 with `BACKUP_ERR:CLEANUP_INCOMPLETE` rather than 0, and the backup-recovery docs describe the code.
- **Other leftovers.** A failed removal of `.partial` or of the lock produces a warning.

### S6-5 / T6-6 / S6-6 / T6-5 — resolved by refusal
- **The C11 gate** permits `fetchApi` only as:
  - a direct callee;
  - a plain import;
  - a type position;
  - a key;
  - one of four allowlisted injection sites.
  - **The four sites:** the import folder and tag resolvers, and the team-attachment and re-key runner deps. Their receiving parameters or members are tracked as sources. `password-import-tags.ts` is the fourth site, found while enumerating.
  - **Refused:**
    - every other value use;
    - every rename;
    - every re-export;
    - a namespace or default import of `url-helpers`;
    - `export *`;
    - a dynamic `import()` or `require()` that may load it.
  - **Stale entries.** An allowlist entry that no longer matches exactly once is refused.
  - **Newly checked.** Tracking the re-key runner's `deps.fetch` brought `fetchOrStop` under the gate; its reads are clean.
- **Check E** permits `INITIAL_VAULT_KEY_VERSION` only in:
  - its definition;
  - the index re-export;
  - a plain named import;
  - at most one direct `keyVersion:` value in each of the two setup sites.
  - **Refused:** every other spelling, including computed keys, namespace or `export *` access to either module, and loaders.
- **Removed:** the alias-following code in both gates.
- **Bypasses still declared** in the C11 header:
  - a response helper carried as a value;
  - the request or Response crossing a function boundary;
  - raw `fetch`;
  - runtime loaders.
- **Red-proof.** Every deny row is red on HEAD or killed by a named mutant (M1–M19, E1–E15). E15 survived at first, and the row that kills it was added. The binding-default row caught a bug in the first draft of the gate.

### Adjacent (round 6) — integration tests ran against the shared dev database — resolved structurally
- **Symptom.** Four integration files failed locally because of three leaked test tenants:
  - `test-tenant-3dfd7ceb` was left by a crashed run, and its anchor row carried a `last_published_at`.
  - `rls-x-tenant-a/b` were left by a local run of `rls-cross-tenant-seed.sql`, and they held v1 webhook rows.
- **Root cause.** The harness ran on whatever `DATABASE_URL` named, which locally is the dev database the live instance and the compose workers share. Leaked rows persisted across runs, tests wrote to and deleted from a live database, and every run needed the workers stopped. CI hid all of this because it uses a fresh database.
- **Fix.** `npm run test:integration` is now `scripts/run-integration-tests.mjs`, and CI runs the same runner.
  - **What a run does:**
    1. Creates an empty database named `passwd_it_<stamp>_<pid>_<hex>` from `template0` and sets a marker comment on it.
    2. Applies the per-database half of `bootstrap-rds-roles.mjs` and then `migrate deploy`.
    3. Runs `--denied-only` and `db:check-drift`.
    4. Runs vitest.
    5. Drops the database, in a cleanup that cannot be interrupted. A failed drop reports `INTEGRATION_CLEANUP_INCOMPLETE` and exits nonzero.
  - **Guarding the cluster.** Cluster-global role state is snapshotted before and after the run, and any change is refused.
  - **Stale databases.** A database left by a dead run is swept on the next run, but only when it is marked, its creator's process on this host is dead, and nothing is connected to it.
  - **`setup.ts`** refuses any database that lacks the name pattern and the marker. The worker-detection refusal is removed, because a compose worker cannot reach a per-run database.
- **Within-run coupling.** These fixes were swept across every integration file. Each is proven by planting foreign rows on a scratch database.
  - **12 files.** Each now asserts only on its own rows, or fails loudly through `assertNoForeignRows` (`foreign-rows.ts`) when the code under test is inherently database-wide.
  - **An empty pass.** `audit-outbox-depth-check` passed without exercising its row when 50 foreign rows were due.
  - **A flaky isolation step.** In `audit-outbox-sweep-caps`, a millisecond-rounding bug made the step flaky.
  - **Cluster-wide lock-wait probes.** The probes in `key-version-guard` and `vault-rotate-key-attachments` observed the whole cluster; they are now scoped.
- **Verification.**
  - The full suite passed through the runner: 175 files and 2459 tests, with the compose workers running.
  - The dev database row counts were unchanged, and no scratch database was left.
  - `check:rls-grant-evidence` passed.
  - A CI-path run on a throwaway `postgres:16` cluster passed.
  - The red-proofs for the runner, M1–M13, are in the scratchpad `it-scratch-a/`, and the plants for the 12 files are in `it-scratch-b/`.
- **Data.** Before the leaked tenants were removed from the dev database, a full backup was taken and validated. They were removed with `deleteTestData`.

### Simplify pass (round 6)
- **Accepted.**
  - **`module-specifier.mjs`.** The dynamic `import()`/`require()` analysis that the C11 gate and Check E each carried is now one shared module, `scripts/checks/lib/module-specifier.mjs`. The two copies were diffed and are identical on every input. Merging them surfaced two shared holes, and both now resolve to "may":
    - a binding destructured from a const string (`const [s] = "./x"`);
    - a template head that stops inside the `@/` alias (`` `@${p}` ``).
    - Each is pinned by a test that is red on the old behaviour. Mutants M1–M11 and MALL are in the scratchpad `specifier-lib/`.
  - **`SessionExpiredCard`.** The lock screen and the setup wizard now share this component.
  - **`assertNoForeignRows`.** The two anchor-publisher preconditions now use this helper. A new `anchor-publisher-fixtures.integration.test.ts` pins that each refuses a foreign row and accepts allowed ones.
- **Not taken.**
  - Collapsing the wizard's `resolveUnlockError` call: the helper stays the one place that decides which codes mean "session expired".
  - A shared `pg` client helper for the scripts: none exists to reuse, and adding one widens the diff past this round.
- **Declared, not closed.** A `..` in a template's dynamic tail falls outside the bundler premise. Refusing it would also refuse legitimate templates such as the i18n message loader.
