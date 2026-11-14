# Code Review: departed-member-leaked-authority
Date: 2026-11-14
Review round: 1

## Changes from Previous Round

Initial review. The local LLM was unavailable, so no seed findings; each expert reviewed the
full diff.

## Functionality Findings

- **F1 [Minor]** The paused-webhook message told admins to re-create the webhook, though
  delivery resumes when the creator regains authority (`messages/{en,ja}/TeamWebhook.json`).
- **F2 [Minor]** Report section 1 listed memberships (tenant row deleted, or re-created after a
  SCIM DELETE) that the contain script cannot end, and one such row made contain refuse the whole
  batch (`docs/operations/departed-member-access-backfill.md`).

## Security Findings

- **S1 [Critical, escalate: false]** confirm-key never checked whether the **recipient**
  departed the tenant after admission, so a leftover member could be given the team key, also
  automatically through `pending-key-distributions`.
- **S2 [Major]** Member PUT let a leftover target be promoted or made OWNER.

## Testing Findings

- **T1 [Major]** The card test passed with the paused predicate inverted.
- **T2 [Minor]** The resume cell did not identify which event was delivered.
- **T3 [Minor]** A confirm-key test name claimed a shared lock budget it did not assert.
- **T4 [Minor]** The accept 410 cell lacked not-called guards.
- **T5 [Minor]** The qualified routine-name gate test was deny-only.
- **T6 [Minor]** The `SHARE_CREATOR_DEPARTED_SQL` override could silently swap the subject.

## Adjacent Findings

- **T7 [Minor, from Testing]** The worker kept a webhook on a missing verdict (`!== false`); the
  GET treated it as paused.

## Quality Warnings

None.

## Recurring Issue Check

### Functionality expert
R3, R5, R9–R12, R14, R17, R18, R24, R25, R29, R34, R35, R38, R40, R42, R48, R49, R52, R54, R55,
R57 checked; F1 under R29/R37, F2 under R34/R41; the rest N/A.

### Security expert
R1, R5, R9, R10, R12, R14–R16, R18, R25, R29, R33–R38, R40, R41, R43, R47, R48, R51, R52, R54,
R55, R57 OK; R3, R17, R22, R42, R49 → S1/S2; RS3, RS4 OK; RS1, RS2, RS5, RS6 N/A.

### Testing expert
R3, R17, R18, R19, R42 OK; R35 present; R48 → T7; R50 → T6; RT1, RT3, RT5, RT6, RT11 OK;
RT7 → T1, T3; RT8 → T4; RT10 → T5; RT4, RT9 N/A.

## Environment Verification Report

N/A — no environment constraints declared in Phase 1.

## Resolution Status

### S1 [Critical] Key distribution to a leftover recipient
- Action: confirm-key refuses a leftover recipient, read unlocked after the team lock (a locked
  read serialised against SCIM; deviation D8). The same recipient class covers rotate-key, where
  a leftover key-holder is no longer wrapped the new version and loses `keyDistributed`.
- Modified file: `src/app/api/teams/[teamId]/members/[memberId]/confirm-key/route.ts`,
  `src/app/api/teams/[teamId]/rotate-key/route.ts`, `rotate-key/data/route.ts`,
  `src/lib/team/tenant-row-lock.ts` (`readTenantRows`).

### S2 [Major] Promotion or transfer to a leftover target
- Action: promotion and transfer to a leftover target are refused (target read unlocked;
  `lockActorThenTeam` unchanged); demotion allowed and pinned.
- Modified file: `src/app/api/teams/[teamId]/members/[memberId]/route.ts`.

### T1 [Major] Card test blind to an inverted predicate
- Action: per-row assertions; red-proved against `=== true`, `!== true` and removal (each fails;
  control passes).
- Modified file: `src/components/team/security/team-webhook-card.test.tsx`.

### F1 [Minor] Paused message
- Action: both recovery paths named, and that events during the pause are not sent.
- Modified file: `messages/en/TeamWebhook.json`, `messages/ja/TeamWebhook.json`.

### F2 [Minor] Report vs contain
- Action: section 1 gains `containable`; step 6 passes only those rows and routes the rest to
  member removal. New integration cell; red-proved (constant `true` fails three cells).
- Modified file: `docs/operations/departed-member-access-backfill.md`,
  `src/__tests__/db-integration/departed-member-operator-scripts.integration.test.ts`.

### T2 [Minor] Resume cell
- Action: the delivered body carries the resumed event's marker and not the skipped one's.
- Modified file: `src/__tests__/db-integration/departed-member-leaked-authority.integration.test.ts`.

### T3 [Minor] Test name
- Action: renamed to what it pins (only the distributor's tenant row locked, before the team;
  the recipient's read unlocked after it).
- Modified file: `src/app/api/teams/[teamId]/members/[memberId]/confirm-key/route.test.ts`.

### T4 [Minor] Accept 410 guards
- Action: asserts no unlocked ACCEPTED write, no upsert, no audit. The locked claim does run and
  is overwritten by EXPIRED, so it is not asserted uncalled.
- Modified file: `src/app/api/teams/invitations/accept/route.test.ts`.

### T5 [Minor] Gate allow cell
- Action: a schema-qualified CREATE of the allowlisted probe in its file exits 0. Red proof: the
  pre-fix parser was observed in this session reporting `creates public` for the qualified form,
  which both new cells refuse; a scratch run is impractical because the test resolves fixtures
  from the repo root.
- Modified file: `scripts/__tests__/check-bypass-rls.test.mjs`.

### T6 [Minor] Red-proof overrides
- Action: `redProofOverride` refuses under CI and warns locally; applied to all three overrides
  (`SHARE_CREATOR_DEPARTED_SQL`, `RLS_BACKFILL_RERUN_SQL`, `RUNBOOK_MD`).
- Modified file: `src/__tests__/db-integration/helpers.ts` and the two test files.

### T7 [Minor] Missing verdict
- Action: the worker delivers only on `true` or `"legacy"`.
- Modified file: `src/workers/audit-outbox-worker.ts`.
