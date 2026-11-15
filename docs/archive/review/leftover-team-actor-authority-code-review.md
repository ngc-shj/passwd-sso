# Code Review: leftover-team-actor-authority
Date: 2026-11-15
Review round: 1

## Changes from Previous Round
Initial review of `8d6345c8d...343976def`. Seeds unavailable (Ollama down); full-diff review.

## Functionality Findings
- **FN-F1 Major** — `team-pending-invitations-list.tsx` `handleCancelInvitation` never checks
  `res.ok`; the new 403/409 (and existing 404) outcomes show "cancelled" and call `onCancel()` while
  the invitation survives.
- **FN-F2 Minor** — Implementation Checklist files absent from the diff with no deviation entry.
- **FN-F3 Minor (existing bug in a changed file)** — `memberCount` counts deactivated rows
  (`src/app/api/teams/route.ts`, `src/app/api/teams/[teamId]/route.ts`).

## Security Findings
- **SEC-F1 Major** — `share_creator_admitted` compares the creator's departure with the share's
  `created_at`, not with the creator's team admission: a team share a leftover created after
  departing is still served (R42 class derived over `src/` only missed this SQL-defined reader; R48
  divergent adjudicators; runbook claims "share links stop on their own").
- **SEC-F2 Minor** — worker granted `tenant_members.role` the decision does not read.

## Testing Findings
- **TEST-F1 Minor** — "refused before the transaction" cells assert `fired === false` on an unarmed hook.
- **TEST-F2 Minor** — C5 `callsGate` accepts a gate call nested in an uninvoked inner function.
- **TEST-F3 Minor** — compose-directory fallback probes `REPO_ROOT` twice in a primary checkout.
- **TEST-F4 Minor** — C8 lacks a cell pinning that a qualifying row left out of the input is untouched.

## Adjacent Findings
None.

## Quality Warnings
None (manual merge).

## Recurring Issue Check
### Functionality expert
R1 OK · R2 OK · R3 OK · R4 N/A · R5 OK · R6–R8 N/A · R9 OK · R10 OK · R11 OK · R12 OK · R13 N/A ·
R14 OK · R15 OK · R16 OK · R17 OK · R18 OK · R19 FN-F2 · R20 OK · R21 N/A · R22 OK · R23 N/A · R24 OK ·
R25–R28 N/A · R29 OK · R30 N/A · R31 OK · R32 OK · R33 N/A · R34 FN-F1/FN-F3 · R35 Adjacent (C8 is an
operator procedure) · R36 OK · R37 OK · R38–R39 N/A · R40 OK · R41 OK · R42 OK · R43 OK · R44–R47 N/A ·
R48 OK · R49 OK · R50 OK · R51 OK · R52 checked · R53 N/A · R54 OK · R55–R57 N/A
### Security expert
R1 OK · R2 OK · R3 SEC-F1 · R4 OK · R5 OK · R6–R8 N/A · R9 OK · R10 OK · R11 OK · R12 OK · R13 N/A ·
R14 SEC-F2 · R15 OK · R16 OK · R17 OK · R18 OK · R19 OK · R20 N/A · R21 N/A · R22 OK · R23 N/A · R24 OK ·
R25 OK · R26–R28 N/A · R29 SEC-F1 · R30 N/A · R31 OK · R32 OK · R33 N/A · R34 SEC-F1 · R35 N/A · R36 OK ·
R37 OK · R38 OK · R39 N/A · R40 OK · R41 OK · R42 SEC-F1 · R43 OK · R44–R47 N/A · R48 SEC-F1 · R49 SEC-F1 ·
R50 OK · R51 OK · R52 OK · R53 N/A · R54 OK · R55 OK · R56–R57 N/A · RS1 N/A · RS2 N/A · RS3 OK · RS4 OK ·
RS5–RS6 N/A
### Testing expert
R1 TEST-F3 · R2–R18 N/A or OK · R19 OK · R20–R41 N/A · R42 OK · R43–R48 N/A · R49 TEST-F2 · R50 OK ·
R51–R57 N/A · RT1 OK · RT2 OK · RT3 OK · RT4 OK · RT5 OK · RT6 OK · RT7 TEST-F1/F2 · RT8 OK · RT9 OK ·
RT10 OK · RT11 OK

## Environment Verification Report
- VE1 (worktree DB): `verified-local` — integration suites run with
  `npx vitest run --config vitest.integration.config.ts <file>` against `passwd_sso_wt_leftover_team_actor`.
- VE2 (worker privileges): `verified-local` — C4 cells run as `ctx.worker.prisma`
  (`passwd_outbox_worker`, principal asserted); `audit-outbox-worker-role` 6/6.
- VE3 (backup-db Group B reader): `verified-local` from the worktree (239/239, compose dir printed as
  the main worktree; `DOCKER_HOST=unix:///nonexistent` fails "no pg_restore reachable"); the primary
  checkout run is D5.

## Resolution Status
### SEC-F1 Major — leftover-created team shares still served
- Action: migration `20261115000300_share_creator_leftover` re-creates `share_creator_admitted` on the
  `20261114000100` body with one added clause:
  `AND (GREATEST(tm.deactivated_at, d.departed_at) >= COALESCE(m.admitted_at, m.created_at)) IS NOT TRUE`
  (equality refuses; NULL admits). Mirror comments in `tenant-departure-read.ts` and
  `rls-cross-tenant-verify.sql`, runbook sentences, `bearer-passkey-gate-manifest.json` entry.
  `share-departure.integration.test.ts`: deny (both seeds), re-admitted / guest / twin allow,
  equality refusal, A10/A10b rows; one existing A10 row (re-created tenant row, departure record
  later than the admission) now expects refused — that creator is a leftover by the C1 predicate.
  Red-proved by re-applying the previous body on the worktree DB (6 cells red) and restoring.
- Modified file: `prisma/migrations/20261115000300_share_creator_leftover/migration.sql`,
  `src/__tests__/db-integration/share-departure.integration.test.ts`

### SEC-F2 Minor — worker `tenant_members.role` grant
- Action: accepted; see deviation D16 (Anti-Deferral: acceptable risk, quantified there).

### FN-F1 Major — cancel UI reports success on error
- Action: `handleCancelInvitation` branches on `res.ok`; failures go through the existing
  `toastApiError(res, tApi)` and do not call `onCancel()`. Component test: 200 success, 403/404/409
  mapped errors without `onCancel`, network error.
- Modified file: `src/components/team/members/team-pending-invitations-list.tsx`

### FN-F2 Minor — checklist files absent from the diff
- Action: deviation D15 records each file as checked and unaffected, and the restore-route form.

### FN-F3 Minor — `memberCount` counts deactivated rows
- Action: `_count.members` filtered on `deactivatedAt: null` in `src/app/api/teams/route.ts` and
  `src/app/api/teams/[teamId]/route.ts`, with unit assertions. Leftover rows still count (display,
  as SC3).

### TEST-F1 Minor — unarmed hook asserted
- Action: the five "refused before the transaction" cells arm a no-op hook before the request and keep
  `fired === false` with the 404.

### TEST-F2 Minor — nested gate call accepted
- Action: `callsGate` counts a call only when its nearest function-like ancestor is the handler;
  refusal and allow self-tests added; red-proved on a scratch copy.

### TEST-F3 Minor — duplicate compose probe
- Action: candidate directories deduplicated in both tests.

### TEST-F4 Minor — readmit sibling untouched
- Action: new readmit cell — two qualifying rows, one in the input; the other keeps
  `admitted_at IS NULL`, one READMIT outbox row.

---

# Round 2
Date: 2026-11-16
Review round: 2 (incremental, `343976def..7295710a0`)

## Changes from Previous Round
All round-1 findings resolved: SEC-F1, FN-F1, FN-F3, TEST-F1..F4 fixed; SEC-F2 accepted (D16);
FN-F2 recorded (D15).

## Functionality Findings
No findings. Every code the cancel route returns maps to an existing `ApiErrors` key in en/ja;
`memberCount` matches the active members list; guest, re-admitted and never-departed creators'
shares are still admitted.

## Security Findings
No findings. The new function body differs from `20261114000100` by the one clause; the flipped A10
row is a leftover by the C1 predicate (its re-admitted twin is served). SQL-side authority readers of
`team_members` re-derived across all migrations (functions, views, policies, triggers): only
`share_creator_admitted` decides team authority — the class is closed. No fix widens a boundary (R43).

## Testing Findings
No findings. share-departure 48/48; component and unit files 66/66; A10b's four variants each pinned
by the probe their migration flips.

## Recurring Issue Check (round 2)
All three experts: R1–R57 (+RS1–RS6 / RT1–RT11) OK or N/A; R3, R29, R42, R48, R49 resolved (SEC-F1);
R14 accepted (D16).

## Termination
All three experts returned "No findings" in round 2. R42 class expansion: the leftover-authority class
gained one member in review (the SQL `share_creator_admitted`), the worktree-compose class one in
Phase 2 (bootstrap-rds-roles) — neither expanded twice, so the expanding-class guard condition does
not fire.
