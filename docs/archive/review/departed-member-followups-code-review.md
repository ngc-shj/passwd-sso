# Code Review: departed-member-followups
Date: 2026-11-16
Review round: 1

## Changes from Previous Round
Initial review of `origin/main...HEAD` (plan, implementation, runbook link). Seeds unavailable (Ollama
down); full-diff review by each expert.

## Functionality Findings
No findings. Checklist files all in the diff; both gates OK on the real tree; 69 unit files pass.
Noted, not raised: the raw NULL cover is a whole-template match (= S2).

## Security Findings
- **S1 Minor (R49)** — the `endTeamMemberships` cover for a `team-departure.ts` writer accepted a call
  nested in a callback of the writer's function, a shadowed name, or a receiver call.
- **S2 Minor (R49)** — the "clears the column" cover is a lazy regex over the whole template (a
  multi-statement template could be over-covered); an upsert's `create` arm was claimed unread.
- **S3 Minor (R42)** — `scripts/` is scanned for `.ts` only; `*Unsafe` raw calls (`tenant-domain.ts`
  uses `$queryRawUnsafe` for SELECTs) and non-`.ts` files stay unseen.
- Answers: the pre-skip move loses no coverage and runs nothing twice; the bypass-rls entry is scoped by
  file + routine; in-transaction audits fail closed with no partial state; the transfer CAS turns a
  self-transfer from a 200 no-op into `MEMBER_NOT_FOUND` (no authority change); R43 clean.

## Testing Findings
- **T-1 Minor (RT10)** — no cells for the Prisma upsert arms of the departure-writer NULL cover (D4).
- **T-2 Minor (RT1)** — the transfer arm's `admittedAt` select was not asserted.
- **T-3 Minor (RT8)** — the members POST P2002 race cell did not assert that no audit was written.
- **T-4 Minor** — the `ALREADY_SENT` no-audit cell's positive control is in a separate cell.

## Adjacent Findings
- S1's red-proof cells belong to the gate's test file (Testing).

## Quality Warnings
None (manual merge).

## Recurring Issue Check
### Functionality expert
R1–R4 OK · R5 OK · R6–R8 N/A · R9 OK · R10–R16 N/A · R17–R21 OK · R22–R24 N/A · R25 OK · R26–R28 N/A ·
R29 OK · R30–R35 N/A · R36 OK · R37–R41 N/A · R42 OK · R43 N/A · R44, R45 OK · R46, R47 note (= S2) ·
R48 N/A · R49, R50 OK · R51 N/A · R52, R53 OK · R54–R57 N/A
### Security expert
R3, R5, R9, R12, R14, R18, R25, R43 OK · R42 S3 · R49 S1/S2 · others not triggered · RS1–RS6 not triggered
### Testing expert
R3 T-3 · R19, R42 OK · others not triggered · RT1 T-2 · RT2–RT6 OK · RT7, RT8 OK (T-3) · RT9 OK ·
RT10 T-1/T-4 · RT11 OK

## Environment Verification Report
- VE1 (worktree DB): `verified-local` — `npx vitest run --config vitest.integration.config.ts
  src/__tests__/db-integration/departed-member-followups.integration.test.ts` 13/13; the nine suites
  driving the changed routes 345/345.
- VE2 (cli/extension deps): `verified-local` — full pre-pr exit 0 from this worktree.

## Resolution Status
### S1 Minor Nested `endTeamMemberships` call counted
- Action: the cover counts a call in the writer's own function body only (`callsIn`). New deny cell
  (call nested in a callback); red-proved by restoring the descendant search on a scratch copy of the
  gate (only that cell fails). Shadowed names and receiver calls stay within the header's stated limit
  ("names and positions, not identities").
- Modified file: `scripts/checks/check-team-rotation-input-lock.mjs` (`checkDepartureClasses`),
  `scripts/__tests__/check-team-rotation-input-lock.test.mjs`.

### T-1 Minor Upsert arms of the NULL cover
- Action: deny cell (upsert `create` arm sets a timestamp, `update` empty, no call) and allow cell
  (upsert `update` clears the column). Red-proved separately: not reading the `create` arm fails the
  deny cell only; reading `data` for an upsert fails the allow cell only. D4 corrected (a create's
  `data` naming null is covered: it makes an active row).
- Modified file: `scripts/__tests__/check-team-rotation-input-lock.test.mjs`, deviation log D4.

### T-2 Minor Transfer `admittedAt` select
- Action: the transfer cell asserts the `findUniqueOrThrow` select carries `admittedAt` (the only such
  call in that cell). The field is also required by the helper's type, so `tsc` refuses its omission.
- Modified file: `src/app/api/teams/[teamId]/members/[memberId]/route.test.ts`.

### T-3 Minor P2002 race writes no audit
- Action: the cell asserts `logAuditInTx` was not called (positive control: the 201 cells). Red-proved
  with a route copy that audits before the create: the cell fails with "to not be called".
- Modified file: `src/app/api/teams/[teamId]/members/route.test.ts`.

### S2 Minor Whole-template NULL cover — Accepted
- **Anti-Deferral check**: acceptable risk.
- **Justification**:
  - Worst case: a future `team-departure.ts` template holding two statements, one deactivating and one
    clearing, is covered without `endTeamMemberships`, and a departure leaves memberships active.
  - Likelihood: low — every writer there is one statement per template; the `departureWriters` pin (3)
    fails on a fourth writer, but not on an existing template edited into two statements; the
    integration suites asserting that departures end memberships are the backstop for that edit.
  - Cost to fix: splitting templates by statement (the SQL lexer) inside the gate — the analyser growth
    the issue asked not to repeat; the database form is `#1060`.
- **Orchestrator sign-off**: acceptable-risk quantified; owner `#1060`.

### S3 Minor `*Unsafe` and non-`.ts` writers unseen — Accepted
- **Anti-Deferral check**: acceptable risk.
- **Justification**:
  - Worst case: a script writes `tenant_members.deactivated_at` through `$executeRawUnsafe` or a
    `.sh`/`.sql` file and leaves memberships active.
  - Likelihood: low — no such writer exists (`tenant-domain.ts`'s `$queryRawUnsafe` calls are SELECTs);
    the limit is stated in the gate header and the runbook, which tells operators to run the report after
    any such change.
  - Cost to fix: a new arm per call form and file type, same as S2; `#1060` closes it in the database.
- **Orchestrator sign-off**: acceptable-risk quantified; owner `#1060`.

### T-4 Minor Positive control in a separate cell — Skipped
- **Anti-Deferral check**: acceptable risk.
- **Justification**:
  - Worst case: none beyond readability — the ISSUED cell shares the `beforeEach` fixture and asserts
    the in-transaction emit, so a regression that audits on ALREADY_SENT is still caught by the
    no-audit cell (red-proved in Phase 2).
  - Likelihood: n/a. Cost to fix: a duplicate cell.
- **Orchestrator sign-off**: reviewer marked it optional.

---

# Round 2
Date: 2026-11-16
Review round: 2 (incremental, the review(1) commit)

## Changes from Previous Round
S1, T-1, T-2, T-3 resolved; S2, S3 accepted (owner `#1060`); T-4 skipped.

## Findings
- Functionality: No findings (the `callsIn` cover, D4 and D7 verified against the code).
- Testing: No findings (the new cells discriminate and are paired).
- Security: S1 resolved; S2/S3 accepted. **N1 Minor (R49, docs)** — S2's likelihood line overstated
  what the `departureWriters` pin catches (an existing template edited into two statements keeps the
  count). Applied below.

## Recurring Issue Check (round 2)
All three experts: R1–R57 (+RS1–RS6 / RT1–RT11) clean or not triggered; R49 N1 (docs).

## Tightening-only skip — Round 2
Findings applied directly (no Round 3 review):
- [N1] [Minor] S2 likelihood overstated the pin — `departed-member-followups-code-review.md` (S2 entry) — applied verbatim
Justification: scoped within the Round 1 resolution text, review-log wording only, no code and no
security-boundary touch.

## Termination
Functionality and Testing returned "No findings" in round 2; Security's only finding was review-log
wording, applied under the tightening-only skip. No R42 class expanded twice in this review.
