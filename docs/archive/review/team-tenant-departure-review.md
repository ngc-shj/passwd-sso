# Plan Review: team-tenant-departure

Plan: `docs/archive/review/team-tenant-departure-plan.md` (v6).
Background: `docs/archive/review/team-key-rotation-write-race-code-review.md`
rounds 3–4 (two reverted in-branch designs for S-R2-1).

Reviewers per round: functionality, security, testing (read-only agents).
Round 6 was a single exit check of v6 against round 5's findings.

## Trajectory

| Round | Plan | Design Critical | Outcome |
|-------|------|-----------------|---------|
| 1 | v1 (admission snapshot, `departedPairs`) | 7 | Redesign: departure written onto `team_members.deactivated_at` + marker |
| 2–3 | v2–v3 | 1 (S1: email lookup under tenant RLS) | Admission decided at accept against locked tenant rows |
| 4 | v4 | 1 (S-P1: SCIM DELETE / SSO re-create) | Global lock order, DB clock, admission writer set |
| 5 | v5 | 0 | Majors all mechanism (directory-sync lock batching, timeout budget, parking points) |
| 6 | v6 | 0 | Exit check: Go on C1–C9 after N1–N5 written in |

Stopping rule applied at round 5: design Criticals reached zero and the
remaining Majors concerned the plan's own mechanism, so v6 carries decisions
and invariants and defers exact SQL, parking statements and mock fallout to
Phase 2 (stated in the plan's acceptance-criteria preamble). Phase 3 reviews
the code with the same three experts.

## Decisions that came out of review

- Departure is deactivation of the team memberships with a marker, not
  `keyDistributed = false` (admin browsers redistribute) and not a live
  predicate (locked out re-invited guests) — round 1 / background.
- Admission is decided where it is written, against the invitee's and the
  inviter's tenant rows read and locked under the team tenant's RLS; no step
  matches invitations by email (S1, S-P1, S-R5-2).
- SCIM DELETE leaves a per-user departure record; a re-create does not revive
  pre-delete invitations (S-P1, F-R4-3, F-R5-3).
- One lock order: `tenant_members` (plus an advisory lock per (tenant, user))
  → `teams` → `team_invitations` → `team_members`/keys; one tenant-row lock
  call per transaction; directory sync batches (S-P2, F-R4-1, T1, F/S/T-R5-1,
  N1).
- Departure and invitation timestamps come from `clock_timestamp()` after the
  locks; equal is a refusal (S-P3, F-R4-2, T-R5-2).
- Lock waits in a transaction share one deadline; 55P03, 40P01 and P2028 map
  to 409 / a failed run (F-R4-7, F-R5-2, N2).
- Create-deactivated arms depart through the helper (F-R5-4, S-R5-5).
- Ownerless teams: tenant-level route with its own permission, step-up,
  limiter, discovery GET; self-assignment refusal is a mistake guard, not a
  boundary (S5, S-P4, F-R4-5, S-R5-3).

## Out of scope (recorded)

- SC1 ItemKey/history/attachment re-key on rotation — follow-up issue.
- SC2 iOS sync aborting on one team's error — follow-up.
- SC3 Share links created by a departed user stay live — follow-up.
- A tenant ADMIN can add itself to any team through a SCIM group mapping and
  receive the team key from admins' browsers (S-R5-3) — follow-up issue.
- Backfill arm 2c depends on retained audit rows (one-time residual).

## Go/No-Go

All nine contracts Go after round 6 (see the plan's gate table).
