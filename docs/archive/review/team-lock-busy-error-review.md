# Plan Review: team-lock-busy-error

## Round 1 (2026-11-12)

Initial review. Local LLM pre-screen skipped (Ollama unavailable). Finding IDs are prefixed by
expert: F- functionality, S- security, T- testing.

### Functionality
- F-F1 Major (design) — re-key runner: `TEAM_BUSY` also reaches the upgrade PUT and the migrate
  PUT chains, not only the re-key POST; unwired chains fall to STOP, a regression from today's
  REFRESH_KEYS retry. Runner `retryAfterMs` does not clamp (plan said it did). → Resolved: C5 wires
  all three locking chains, adds a 30 s clamp, updates `rekeyStopRetryBudget` and the comment.
- F-F2 Major (design) — membership clients branch on `CONFLICT` or bare 409 (members-list page,
  ownerless card, invite, add-from-tenant, team-create, tenant-members-card); plan's "no code
  change" claim was false. → Resolved: each named in C5 with its change; the four status-keyed
  ones key their fixed message on the specific code (fixes their pre-existing `CONFLICT`
  misreport, R34).
- F-F3 Minor (design) — "this team" wording misfits the tenant-row timeout and the spent-token
  admin-reset. → Resolved: `TEAM_BUSY` only for `TeamRotationInProgressError`; neutral wording;
  admin-reset keeps `CONFLICT` (SC5).
- F-F4 Minor (prose) — API_ERROR count test (204) and two more doc spots. → Resolved: C1, C6.
- F-F5 Minor (prose) — form message namespace; delete toast widening; importer retry budget is 2.
  → Resolved: `PasswordForm.teamEntryTeamBusy`; widening stated; budget stated.
- F-F6 Minor (prose) — stale directory-sync claim; bulk-import rationale; RFC wording. →
  Resolved: corrected in Background/C3/C6 and the 409 rationale.
- F-F7 Minor (design) — forbidden-pattern regex misses confirm-key. → Resolved: pattern dropped;
  confirm-key pinned by its `busy` test.

### Security
- S-F1 Minor (design) — `TEAM_BUSY` precedes the in-tx actor re-check for a just-revoked member.
  → Accepted, recorded in C4 (pre-tx authz still first; retry yields 403; previous code leaked the
  same fact).
- S-F2 Minor (design) — vault/tenant routes reveal some team is rotating. → Accepted in C4; no
  team id in the body.
- S-F3 Minor (prose) — shared wording mislabels the tenant-row timeout. → Resolved with F-F3.
- S-F4 Info — fixed `Retry-After` without jitter; clamp the client wait. → Clamp added (C5); jitter
  recorded under Risks.

### Testing
- T-F1 Major — no existing cells for history restore, vault reset, owner. → Resolved: listed as new
  cells with pairs.
- T-F2 Major — membership sites lack paired `TEAM_BUSY`/`CONFLICT` cells; bare-409 cells would not
  fail on the old mapping. → Resolved: per-site pair.
- T-F3 Major — `team-entry-rekey.test.ts` stubs the error class. → Resolved: `importActual`.
- T-F4 Major — integration covers only create and removal; removal cell unlisted. → Resolved: flip
  both, add PUT, bulk import, confirm-key.
- T-F5 Minor — no-write/audit and header assertions. → Resolved: stated for every cell.
- T-F6 Major — bulk-import `TEAM_BUSY` cell missing. → Resolved.
- T-F7 Major — client tests underspecified. → Resolved: per-file cells incl. `invalidateTeamKeys`
  not called and non-`TEAM_BUSY` 409 not retried.
- T-F8 Minor — status/helper/constant cells. → Resolved.
- T-F9 Minor — helper cells assert header presence/absence. → Resolved.
- T-F10 Minor — invariant not CI-enforced. → Accepted (SC3); integration cells are the backstop.

### Recurring Issue Check

Preserved from each expert's output; non-N/A entries:
- Functionality: R1 ok; R2 ok; R3 F-F1/F-F2; R8 F-F2; R10 ok; R12 F-F4; R17 F-F1; R18 F-F4;
  R22 ok; R29 F-F1/F-F3/F-F6; R34 F-F2; R38 F-F1; R40 ok; R42 F-F1/F-F2/F-F6/F-F7; R51 ok;
  all others N/A.
- Security: R1 ok; R2 ok; R3 ok; R12 ok; R17 ok; R29 S-F3; R34 ok; R37 S-F3; R38 ok; R42 S-F3;
  RS2 S-F4; all others N/A.
- Testing: R1 ok; R2 ok; R3 T-F2; R8 ok; R12 ok; R16 ok; R17 T-F7; R19 T-F3; R29 ok; R37 ok;
  R38 T-F7; R42 T-F10; RT1 T-F3; RT2 ok; RT3 T-F8; RT4 T-F4; RT5 T-F3; RT6 T-F8; RT7
  T-F1/T-F2/T-F6; RT8 T-F5; RT9 T-F10; RT10 T-F2/T-F6; RT11 ok; all others N/A.

## Round 2 (2026-11-13)

Changes from Round 1: TEAM_BUSY narrowed to `TeamRotationInProgressError`; admin-reset keeps
CONFLICT; runner wired on all three locking chains with a 30 s clamp; six membership client
consumers named; test cells enumerated per file.

### Functionality
- F2-1 Major (design) — `teams/route.ts` and `tenant/members/[userId]` cannot raise the team-lock
  timeout (tenant-row locks only). → Resolved: R1 lists the reachable sites; those two use
  `membershipConflictResponse` uniformly with only a CONFLICT pin; create-dialog and
  tenant-members-card keyed on their real codes, no TEAM_BUSY cell.
- F2-2 Major (design) — members-list role/remove, transfer-ownership and invite-accept pages
  receive TEAM_BUSY and show `networkError`/`acceptFailed`. → Resolved: TEAM_BUSY arm each (C5).
- F2-3 Minor (prose) — C5 rg used non-existent `apiPath` names, missed `API_PATH.*` consumers. →
  Resolved: derivation corrected; `vault-reset/page.tsx` recorded as no-change.
- F2-4 Minor (design) — `membershipConflictResponse` would pull `next/server` into a lock module
  imported by directory sync/services. → Resolved: new `src/lib/http/lock-conflict-response.ts`.
- F2-5 Minor (prose) — importer bound misstated. → Resolved.

### Security
No findings. S-F1..S-F4 resolutions verified; owner route 404s a foreign team before any lock;
generic 409 rendering on invite/add/create/role discloses nothing beyond codes already in the body.

### Testing
- T2-F2 Major (design) — existing status-keyed cells mock code-less / other-code 409s and would
  flip when re-keyed. → Resolved: mocks carry the real route codes; code-less and CONFLICT cells
  added.
- T2-F1, F3–F9 Minor (design) — ownerless card test is new; pin cells labelled and red-proved by
  mutation; mid-batch bulk-import abort; importer exhaustion/clamp/default; runner clamp/default/
  shared budget; delete network-error pin; integration timeouts/lower bound; integration header +
  no-audit. → All resolved in the Testing strategy.

### Recurring Issue Check (non-N/A)
- Functionality: R1 ok; R2 ok; R3 F2-1; R8 F2-2; R10 ok; R12 ok; R17 ok; R18 ok; R22 ok; R29 F2-5;
  R34 ok; R38 ok; R40 ok; R42 F2-1/F2-2/F2-3; R51 ok.
- Security: R1, R2, R3, R12, R17, R29, R34, R37, R38, R42 ok; RS2 ok.
- Testing: R3, R8, R12, R16, R19, R29, R37, R42 ok; R17/R38 T2-F5/F6; RT1–RT3, RT5, RT6, RT9,
  RT11 ok; RT4 T2-F8/F9; RT7 T2-F3; RT8 T2-F4/F9; RT10 T2-F2/F4.

## Round 3 (2026-11-13)

Changes from Round 2: reachable TEAM_BUSY site list; helper moved to the HTTP layer; three more
UI consumers; status-keyed consumers keyed on real codes; test cells refined.

### Functionality
- F3-1 Minor (design) — BUSY_WAIT shared the pass-wide rotation budget. → Resolved: own
  `MAX_BUSY_WAITS = 10`; rationale corrected (only a `FOR NO KEY UPDATE` holder blocks these
  `FOR SHARE` requests, so the source is a rotation or the prune, not membership writes).
- F3-2 Minor (prose) — scenario 2 named the prune, contradicting SC4. → Resolved: rotation.
- F3-3 Minor (design) — a spent shared budget throws the team timeout without a team wait. →
  Accepted in C4 (retry-safe; advice correct; a third error class would be wording only).
- F3-4 Minor (design) — members-list role/remove and transfer-ownership left CONFLICT as
  `networkError`. → Resolved: render `tApi(apiErrorToI18nKey(code))` for any coded non-ok.
- F3-5 Minor (prose) — create-dialog fallback surface. → Resolved: toast; slug field only for
  `SLUG_ALREADY_TAKEN`.

### Security
No findings (invite-accept reachable only by the valid, email-matched invitee; generic rendering
discloses nothing beyond body codes; helper layering fine).

### Testing
- T3-F1 Minor (prose) — `members/[memberId]` existing timeout cells are tenant-row timeouts. →
  Resolved: they become CONFLICT pins; new TEAM_BUSY cells throw on `FROM teams`.
- T3-F2 / T3-F3 Minor (design/prose) — pin red-proof mutation did not reach admin-reset, SCIM or
  entry-family mismatch cells. → Resolved: per-decision-path mutations named.

### Recurring Issue Check (non-N/A)
- Functionality: R1, R2, R8, R10, R12, R17, R18, R22, R34, R38, R40, R42 ok; R3 F3-4; R29
  F3-2/F3-5; R51 F3-1/F3-3.
- Security: R1, R2, R3, R12, R17, R29, R34, R37, R38, R42 ok; RS2 ok.
- Testing: R3, R8, R12, R16, R17, R19, R29, R37, R38, R42 ok; RT1–RT6, RT8, RT9, RT11 ok; RT7
  T3-F2/F3; RT10 T3-F1.

## Round 4 (2026-11-13)

Changes from Round 3: separate busy budget with corrected rationale; members-list/transfer
handlers render coded errors; per-decision-path pin mutations.

### Functionality
- F4-1 Major (design) — `handleStepUpError` reads the `Response` body without cloning, so every
  later `readApiErrorBody(res)` on step-up-gated consumers returns null in a browser; the planned
  TEAM_BUSY arms (and the existing approve/reject CONFLICT arm) are dead. Verified by the
  orchestrator in `src/lib/http/handle-step-up-error.ts` / `read-api-error-body.ts`. → Resolved:
  new C7 fixes the helper (clone; pre-consumed body → false); UI cells use real `Response`s.
- F4-2 Minor (prose) — transfer-ownership lacks `tApi`. → Resolved in C5.
- F4-3 Minor (prose) — code-less path wording. → Resolved in Testing strategy.

### Security
No findings. Note (pre-existing): `apiErrorToI18nKey` uses `in`, matching inherited names. →
Resolved as C8 (own-key lookup), since C5 widens its use on server-supplied codes.

### Testing
- T4-F1 Minor (design) — entry-family mismatch pin mutation was off-path. → Resolved: mutate the
  mismatch-producing statement per site.
- T4-F2 Minor (prose) — busy budget boundary and rate-limit isolation. → Resolved.

### Recurring Issue Check (non-N/A)
- Functionality: R1, R2, R8, R12, R17, R18, R22, R34, R38, R40, R42, R51 ok; R3/R4 F4-1; R29
  F4-2/F4-3.
- Security: retry bounds, disclosure, rendering, fail-closed, authz ordering, client clamp ok.
- Testing: R1, R3, R8, R12, R16, R17, R19, R29, R37, R38, R42 ok; RT1–RT6, RT8–RT11 ok; RT7
  T4-F1.

## Round 5 (2026-11-13)

Changes from Round 4: added C7 (step-up helpers read a clone) and C8 (own-key i18n lookup).

### Functionality
- F5-1 Major (design) — `res.clone()` throws on the plain-object `Response` mocks of ~24 callers'
  tests. → Resolved by redesign: C7 now memoizes the parse in `readApiErrorBody` (WeakMap per
  `Response`) and routes `toastApiError` through it; no clone, existing mocks unaffected, and a
  second reader of any kind is covered, not only the step-up helpers.
- F5-2 Minor — C8 missed the `overrides?.[code]` lookup. → Resolved.
- F5-3 Minor — record the sweep of other double-read helpers. → Resolved: two rg derivations in C7.

### Security
- S5-1 Minor — same as F5-2. → Resolved.
- No fail-open: a step-up 403 is read through the same memo, and the guard's tokens are unchanged
  (run the guard unpiped after the change).

### Testing
- Q5-1 Major — mock breakage under clone. → Resolved by the C7 redesign.
- Q5-2 Major — consumer-level C7 proof unnamed. → Resolved: members-list approve/reject `it.each`
  and ownerless-card cells converted to real `Response`s, red-proved by removing the memo.
- Q5-3 Minor — pre-consumed-body pin. → Obsolete (no `bodyUsed` guard in the redesign).
- Q5-4/Q5-5 Minor — C8 overrides cell, red-proof, `typeof string`. → Resolved.
- Q5-6 Minor — clamp boundary 30/31. → Resolved.

### Recurring Issue Check (non-N/A)
- Functionality: R42 F5-3; mock fidelity F5-1; inherited lookup F5-2; fail-closed ok.
- Security: step-up fail-closed ok; guard binding ok; inherited lookup S5-1; error-surface ok.
- Testing: RT7 Q5-2/Q5-3/Q5-5; RT8 Q5-4; RT10 Q5-1/Q5-2.

## Round 6 (2026-11-13)

Changes from Round 5: C7 redesigned to a memoized reader; C8 covers `overrides`.

### Functionality
- F6-1 Minor — memo per object can return a stale parse for reused test mocks. → Resolved: full
  suite right after the C7 edit; fix any such test with a fresh mock.
- F6-2 Minor (prose) — `tenant-reset-history-dialog` now shows the specific server code. →
  Resolved: recorded as the intended change with its own cell.
- F6-3 Minor — `toastApiError` parse differences. → Obsolete under the F6-T1 resolution
  (`toastApiError` keeps its own parse logic over the memo).

### Security
- S6-1 Minor — `eaErrorToI18nKey` uses `in` on `EA_I18N`. → Resolved: in C8.
- No cross-request retention (client-only importers; WeakMap keyed by per-fetch `Response`).

### Testing
- F6-T1 Major (design) — routing `toastApiError` through `readApiErrorBody` added an `ok` and a
  string-`error` guard, breaking 5 existing cells and contradicting "same output". → Resolved:
  memoized raw `parseJsonBodyOnce` with no `ok` check; `readApiErrorBody` keeps its guards over it;
  `toastApiError` keeps its own logic over it.
- F6-T2 Minor — per-object isolation and single-`json()` cells. → Resolved.
- F6-T3 Minor — exact memo mutation, arm-outcome assertions, per-lookup C8 mutations. → Resolved.

### Recurring Issue Check (non-N/A)
- Functionality: R1/R5 F6-2/F6-3; R2 F6-1; R3, R8, R10, R14, R30 ok.
- Security: inherited lookup S6-1; step-up fail-closed, retention, logging ok.
- Testing: RT1–RT4, RT7–RT11 ok; RT5 F6-T1; RT6 F6-T2.

## Round 7 (2026-11-13)

Changes from Round 6: C7 split into a memoized raw parse; C8 covers `eaErrorToI18nKey`.

- Functionality: F7-1 Minor (prose) — a JSON `null` body throws in `toastApiError` today; the plan
  claimed "unchanged". → Resolved: recorded as a deliberate change; the cell asserts the fallback.
- Security: No findings (memo retention bounded by the `Response`; step-up fail-closed unchanged;
  `parseJsonBodyOnce` stays module-private).
- Testing: F7-T1 Minor (design/prose) — same as F7-1. → Resolved.

### Saturation call (Round 7)

Phase 1 closes on the saturation criterion: 7 rounds completed; no Critical or Major open in any
category; Round 7 raised no finding against contracts, control classes, invariants or acceptance
criteria (both findings were labelled prose by their experts and are resolved above); no Minor
remains. No carried-forward findings.

### Recurring Issue Check (non-N/A)
- Functionality: R1, R3, R20, R42 ok; R8 F7-1.
- Security: secret retention, step-up fail-closed, prototype-key class ok.
- Testing: RT1–RT4, RT6–RT11 ok; RT5 F7-T1.
