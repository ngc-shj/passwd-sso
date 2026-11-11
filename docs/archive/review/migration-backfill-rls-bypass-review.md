# Plan Review: migration-backfill-rls-bypass
Date: 2026-11-10
Review round: 1

## Changes from Previous Round
Initial review. Round 0 (before the plan): a read-only sweep of every migration for DML on FORCE
RLS tables without bypass found `20261104000000_team_key_rotation_rekey` in addition to the
issue's `20261101000000`, and 13 pre-bootstrap migrations.

## Functionality Findings
- F1 [Critical, design] Departure step 1 re-run deactivates memberships re-admitted by an accepted
  post-departure invitation (accept upserts the row, keeps `created_at`, tenant row stays
  deactivated). Verified in `src/app/api/teams/invitations/accept/route.ts`. Also falsifies I2.
- F2 [Major, design] Rule 5 (literal-only `set_config`) refuses the COALESCE restore of the
  precedent and of C1.
- F3 [Major, design] Leading-keyword classification misses `BEGIN UPDATE`, `IF … THEN`, `FOR r IN
  SELECT`, `IF EXISTS (SELECT`; both real backfills' first UPDATE start with `BEGIN`.
- F4 [Major, design] Function exclusion drops `INSERT INTO t (cols)`; comma FROM and `ONLY` missed.
- F5 [Major, design] Grant presence, not current state: grant → DML → restore → DML passes.
- F6 [Minor, design] ItemKey versions collided in the window are neither repaired nor detected.
- F7 [Minor, prose] Forbidden pattern's unescaped parentheses never match.
- F8 [Minor, prose, R29] Member-set derivation lacks a command; I2 overstated.
- F9 [Minor, prose] C4 files unnamed; error-name drift from sibling; ASCII-only dollar tags in
  `sql-scan.mjs`; DO-body line numbers relative.
- F10 [Minor, design] `RAISE NOTICE` visibility through `migrate deploy` unverified.

## Security Findings
- S1 [Major, design] Access already leaked in the window (team entries read, rotated team keys
  distributed to departed members) gets no follow-up; operator cannot tell which teams.
- S2 [Minor, prose, R29] Baseline reason "empty RDS" false for managed-Postgres self-hosters the
  setup docs direct to migrate as an admin without BYPASSRLS.
- S3 [Minor, design] C1 writes team rows without the `teams FOR SHARE` lock the rotation contract
  requires.
- S4 [Minor, design] Gate misses `IF EXISTS`, `FOR … IN SELECT`, assignment reads, comma joins
  (merged with F3/F4).
- S5 [Minor, design] Re-run leaves no audit trail; 2c coverage shrinks with retention; bypass
  list exactness untested (no `rls_bypass_not_granted` assertion).

## Testing Findings
- T1 [Major] Re-key fixture reset under `passwd_app` unspecified; a leftover test bypass masks C1.
- T2 [Major] Negative control not distinguishing (abort / post-state / leftover bypass); needs
  zero NOTICE counts and a paired positive control.
- T3 [Major] No per-table red-proof; departure `teams` omission survives (census unasserted).
- T4 [Major] I2 has no cell.
- T5 [Major] Gate self-tests miss extraction forms, NO FORCE, cross-migration, session-scoped
  grant, restore order, rule-5 forms, near-name allow.
- T6 [Major] Real-tree check is per migration only; statement-level hit set not compared.
- T7 [Minor] I3 cannot tell restore from reset; use a sentinel and all four settings.
- T8 [Minor] Gate message contract unasserted.
- T9 [Minor] Root override env pollution in CI.
- T10 [Minor] Departure expected outcomes ambiguous; extract the fixture builder, literal map.

## Adjacent Findings
None tagged.

## Quality Warnings
None.

## Recurring Issue Check
### Functionality expert
R42: member set recomputed (59 FORCE tables; 13 + 2 migrations), no delta. R29: F8. Re-run safety
vs app writers: F1, F6. Enforcement mechanism run against the real tree: F2–F5. Forbidden pattern
run against original text: F7. File list: F9.

### Security expert
R29: S2, S3, version-reuse wording. R42: S4; C1 table lists exact. RS1: S1 (team authz reads only
`team_members`). RS2: version reuse safe (AES-GCM, `item_key_id` lookup, AAD). RS3: scoping
correct, report-mode exactness needs a test (S5). RS4: S5. RS5: counts and UUIDs only. RS6:
enforce mode fails closed; report mode silently admits (S5).

### Testing expert
R42: partial (T3, T6). RT1 OK. RT2 OK. RT3 n/a. RT4 n/a. RT5 OK. RT6 OK. RT7 partial (T2, T3,
T5, T6). RT8 open (T2). RT9 n/a. RT10 partial (T5). RT11 OK.

## Resolution Status
### Round 1
- F1 — step 1 excludes memberships re-admitted by an accepted post-departure invitation; writer
  set derived (only accept reactivates without an active tenant row); C4 fixture. I2 reworded.
- F2, F3, F4, F5, S4 — C3 rewritten: references from every table-introducing position in a DO
  statement, comma items, `ONLY`, INSERT/MERGE targets always; current-state tracking; literal
  requirement on grants only; C5 fixtures for each.
- F6 — documented harmless with reason; SC3.
- F7 — pattern escaped.
- F8 — derivation command (`--list`); I2 reworded.
- F9 — files named; sibling error names; Unicode tags / unparsed fail closed; line offsets.
- F10 — no flow relies on NOTICE (E3); audit rows are the record.
- S1 — C1 enqueues `TEAM_MEMBER_TENANT_DEACTIVATE` outbox rows (SYSTEM actor, `backfill`
  metadata); C6 operator runbook: rotate affected teams.
- S2 — per-entry baseline reasons verified in Phase 2; setup-doc note (C6).
- S3 — blocks take `teams FOR SHARE` first.
- S5 — audit via S1; no-warning assertion in C4. 2c retention shrinkage accepted as the
  original plan's best-effort residual, now larger by the delay. Anti-Deferral: residual = a
  PENDING invitation issued before a pre-change SCIM delete whose `SCIM_USER_DELETE` audit row
  was purged stays acceptable (the deleted tenant row leaves accept nothing to compare);
  likelihood low (needs a pre-change delete, a still-PENDING unexpired invitation, and a purge);
  cost of a fix: the delete time is gone with the audit row, and an invitee with no tenant row is
  indistinguishable from a legitimate external invitee — not reconstructible.
- T1–T10 — adopted in C4 / C5 / Testing strategy.

## Round 2
Incremental review of the round-1 revision. Two reviewers converged on the C1 exclusion
(perspective convergence: Critical floor).

### Findings
- R2-F1 [Critical, design] Exclusion relies on `team_invitations` rows that retention GC deletes
  ~7 days after issue; I2 false everywhere.
- R2-S1 [Major, design] An ACCEPTED invitation is not evidence of re-admission: the accept
  pre-check marks one ACCEPTED for an already-active member without admission checks; case
  variants make it reachable by a leaked member.
- R2-T1 [Critical, design] I2 cell committed the originals' table-wide UPDATEs to the shared DB.
- R2-F2 [Major] SQL outbox insert under-specified (no DB default for id; camelCase keys;
  `TeamMember`; `TENANT_DEACTIVATION`). R2-S4 [Minor] same, plus parser defaults scope/actor.
- R2-S2 [Major] Members, roles, webhooks created on a departed inviter's leaked authority survive.
- R2-T2 [Major] I2 straggler half unasserted. R2-T3 [Major] empty sentinels (22P02, restore vs
  reset). R2-T4 [Major] exclusion tested one-sided. R2-T6 [Major] report mode: table-list mutants
  red only via the notice sink. R2-T7 [Major] outbox pin path. R2-T8 [Major] `--list` expected set
  storage.
- Minor: R2-F3 lock set / deadlock path; R2-F4 predicate unspecified; R2-F5 lexical grant in
  branches, FORCE via EXECUTE, grant/restore ambiguity; R2-F6 C6 record location; R2-S3 C6
  scope; R2-S5 accept pre-check (Adjacent); R2-T5 stamp-relative fixtures; R2-T9 63 vs 59;
  R2-T10 census race; R2-T11 12 mutants; R2-T12 outbox count scope.

### Recurring Issue Check
Functionality: R42 recomputed with revised rules — 15 migrations, 59 tables, no DDL-in-DO false
hits, `20261109162613` passes; writer set for re-activation complete (accept, members POST,
approve, `returnToTenant`). Security: RS1 R2-S1/R2-S2; RS3 bypass incl. `audit_outbox` OK; RS4
R2-S4; RS5 OK; RS6 R2-S1. Testing: RT4 R2-T10; RT5 R2-T7; RT7 R2-T6/T8/T9; RT8 R2-T3/T6; RT10
R2-T4; RT11 R2-T1.

### Resolution
- R2-F1, R2-S1, R2-T1, R2-T2 — C1 now runs only when the migrate role cannot bypass RLS (I2 is a
  skip, asserted as superuser inside a rolled-back transaction; nothing committed). The exclusion
  uses the system-written `TEAM_MEMBER_TENANT_DEACTIVATE` record (`audit_logs` or pending
  `audit_outbox`) at or after the departure, not invitations. Residual (purged record → revoked,
  recoverable) stated in C1 and C6. The straggler half of I2 is gone with the gate.
- R2-F2, R2-S4 — payload spelled out in C1; C4 `toEqual(buildOutboxPayload(...))` + `deliverRow`.
- R2-S2 — C6 review/revert guidance; SC4 follow-up for the accept/create inviter checks.
- R2-S3, R2-F6 — C6 rewritten. R2-S5 — SC4.
- R2-F3 — all teams locked in one ordered statement; deadlock/resolve path and rotation window in
  Considerations. R2-F4 — predicate scoped (tenant, team, target, action, time) in C1; email no
  longer part of it.
- R2-F5 — non-`on` `bypass_rls` values are restores; grants in branches/nested blocks and FORCE
  in DO fail closed; C5 fixtures.
- R2-T3, T4, T5, T6, T7, T10, T12 — C4 rewritten. R2-T8, T9 — C5 literals. R2-T11 — 12 mutants
  listed, plus conjunct and gate mutants.

## Round 3
Incremental. All three reviewers independently flagged the exclusion's time conjunct.

### Findings
- R3-F1 / R3-S1 / R3-T1 [Major, design] The time conjunct compares the departure stamp
  (DB `clock_timestamp()`) with the record's `created_at` (outbox time copied into
  `audit_logs`; reviewers differ on whether Prisma or the column default fills it — either way a
  different clock, and possibly earlier). R3-S1 also: the team conjunct is too narrow.
- R3-S2 [Major, design, RS6] The role gate skips silently after a migrate-role switch or a
  cross-host restore.
- R3-T2 [Major] Conjunct / arm fixtures missing. R3-T3 [Major] `rolbypassrls` half unexercised.
- Minor: R3-F2 text comparisons, all outbox statuses; R3-F3 restore across role classes; R3-F4
  Vercel/Neon attribute claim; R3-S3 "system-written" wording; R3-S4 webhooks outlive the
  membership; R3-T4 skip capture; R3-T5 missing C5 cells; R3-T6 misfiled case; R3-T7 literals
  break on future FORCE migrations.

### Recurring Issue Check
Functionality: R42 departure writer set re-derived (`endTeamMemberships` via `departFromTenant`,
`departCreatedMembership`; five call sites; one action); R29 R3-F1. Security: RS1 R3-S1/S2/S4;
RS3 OK; RS4 no forgery vector for the evidence record (import endpoint hard-codes its action);
RS5 OK; RS6 R3-S2. Testing: RT7 R3-T2/T3/T5/T7; RT8 R3-T1; RT10 R3-T1/T2; RT11 OK.

### Resolution
- R3-F1/S1/T1 — exclusion is any `TEAM_MEMBER_TENANT_DEACTIVATE` record for (tenant, user), no
  time or team conjunct; soundness argued from the writer set (records only from
  `endTeamMemberships`, which ends all active memberships; the stamp is written once). Residuals
  (purged records; no active membership at the post-change departure) revoke, fail closed, C6.
- R3-S2, R3-F3 — role gate kept for the departure block only (the re-key block runs
  unconditionally, every statement being one the app performs itself); the skip raises a
  `WARNING` with the candidate count; C6 says how to read it and how to run the block by hand.
- R3-T2, T3, T4, T5, T6, T7 — C4 fixtures per conjunct and arm, `audit_logs`-only record,
  non-PENDING outbox record, other-team record; `NOSUPERUSER BYPASSRLS` role cell; raw-client
  notice capture; C5 cells added, case moved; independent counts computed in the test.
- R3-F2 — text comparisons, all statuses, in C1. R3-F4 — C6 says to check the attributes.
  R3-S3 — reworded. R3-S4 — C6 starts with webhooks; added to the SC4 follow-up.

## Round 4
Incremental. Finding character: one design defect (R4-F1); the rest test-cell mechanics and prose
introduced or left by round 3.

### Findings
- R4-F1 [Major, design] Re-key step 1 is not pre-change-only: history restore writes marker 0
  on purpose; step 1 would mark such entries not pending (and create a high-water > version
  state `rekey-consistency.ts` rejects).
- R4-F2 / R4-T1 [Major] Skip-WARNING count asserted absolute over a database-wide census.
- R4-T2 [Major] `rolsuper` half of the gate unkillable (`ctx.su` has both attributes).
- R4-T3 / R4-F3 [Major] Stand-in role privileges and connection unspecified; gate must read
  `current_user`.
- R4-S1 [Major, RS6] C6 trigger relied on a WARNING whose visibility is unverified (E3).
- Minor: R4-F4 / R4-S2 exclusion wording overclaims, SC5 exception; R4-F5 re-key straggler half
  of I2 untested; R4-S3 webhooks step after the fan-out; R4-S4 share links (refuted — every serve
  path calls `share_creator_admitted`, which requires the creator's active membership; recorded
  in C6); R4-S5 SC4 overclaims; R4-T4 59 statements not 63 (4 commented out); R4-T5 time
  conjunct regression guard; R4-T6 re-key I2 scope, second-tenant cleanup.

### Recurring Issue Check
Functionality: R42 writers of `item_key_team_key_version` re-derived — entry create, re-key POST,
history restore (missed member: R4-F1); departure writers unchanged. Security: RS1 R4-S2/S5; RS4
no forgery vector; RS6 R4-S1. Testing: RT4 R4-T1/T6; RT7 R4-T1/T4; RT8 R4-T1/T2; RT10 R4-T2/T5;
RT11 OK.

### Resolution
- R4-F1 — step 1 runs only under the role condition and only on `high_water = 0`; residual
  (restore to a v0 row) stated; C4 fixture via the real restore route; mutants.
- R4-F2/T1 — skip count as an in-transaction delta. R4-T2/T3/F3 — three roles on one checked-out
  client (`ctx.su`, `NOSUPERUSER BYPASSRLS IN ROLE passwd_app`, `SUPERUSER NOBYPASSRLS`),
  attributes asserted; `current_user` in C1; `rolsuper`-half mutant.
- R4-S1 — C6 has operators run the candidate query on any role/host change (or doubt) instead of
  relying on the WARNING; visibility measured in Phase 2.
- R4-F4/S2 — wording and SC5 residual; C6 classification. R4-F5 — straggler read-back. R4-S3 —
  pre-deploy section. R4-S4 — no change needed; noted in C6. R4-S5 — SC4 restated with the
  structural item. R4-T4 — 59/59, comment stripping. R4-T5 — stamp − 1 s fixture, mutants.
  R4-T6 — fixture read-back; second tenant cleaned by the cell.

## Round 5
Incremental. Character: C1–C5 design verified (re-key writer set complete; three-role I2 design
feasible; refutation of R4-S4 confirmed). The open Majors are in C6, the operator runbook, which
has gained a new Major each round since it was added — the plan-prose defect surface the
saturation rule describes. Resolution narrows C6 to what can be stated and tested instead of
specifying more of it.

### Findings
- R5-S1 / R5-F1 [Major, design] C6's re-admission classification names evidence that never
  exists for a candidate (accept writes no audit row; `TEAM_MEMBER_ADD` refuses departed users and
  targets the team-member id).
- R5-S2 [Major, design] The SC5-with-record residual sits outside C6's candidate set and remedy.
- R5-S3 [Major, design, RS6] C6 queries "with a bypass-capable role" return a silent empty result
  as RDS / Cloud SQL admin (RLS is granted by settings, not role attributes); trigger conditional.
- R5-T1 [Major, design] The `current_user` (not `session_user`) gate property has no killing cell.
- Minor: R5-S4 SC4 structural item needs a re-admission timestamp; R5-F2 reverse role switch
  residual; R5-F3 / R5-T3 straggler fixtures and mutants; R5-T2 per-arm time/team guards; R5-T4
  gate count output; R5-T5 I2 placement, delta arm, listener cleanup.

### Recurring Issue Check
Functionality: R42 re-key column writers re-derived (create, bulk import, update, re-key POST,
restore, rotation, attachments, stragglers) — no missed member; audit-action member set for C6
checked. Security: RS1 R5-S2; RS2 R5-S1; RS4 named actions not self-producible, the likely
substitute is; RS6 R5-S3. Testing: RT7 R5-T3/T4; RT8 R5-T1; RT10 R5-T1/T2; RT11 OK.

### Resolution
- R5-S1/F1/S2/S3 — C6 rewritten: one self-contained read-only SQL report (transaction-local
  bypass grant, positive control, raw candidates without exclusion, record flag), run before and
  after C1 on every deployment, exercised by a C4 cell; no classification — every remaining
  candidate goes to the tenant admin, removal through the app.
- R5-T1 — fourth I2 transaction (`SET LOCAL ROLE passwd_app` on the superuser client) and the
  `session_user` mutant.
- R5-S4 — SC4 requires a re-admission timestamp and an accept audit action. R5-F2 — residual in
  C1. R5-F3/T2/T3/T4/T5 — C4, C3 trailer, Testing strategy.

## Round 6
Incremental. C1–C5 design verified unchanged; open Majors again in C6. Scope question put to the
user (split C6's remediation off vs keep it): **user chose to keep it in this PR**, so C6 is
completed rather than narrowed.

### Findings
- R6-F1 [Major, design] C6's remedy (app member removal) cannot remove a leaked OWNER and needs a
  higher-ranked team member; tenant admins lack the permission; re-departure is a no-op.
- R6-T1 [Major, design] Report cell asserted containment, not a tenant-scoped exact set.
- R6-T2 [Major, design] Grant-removed refusal could pass via a uuid cast error.
- Minor: R6-F2 report lacks the nil tenant id; R6-F3 / R6-T3 report's own transaction vs the
  cell wrapper, predicate untied to C1; R6-F4 after-C1 candidates mischaracterised; R6-F5
  residual wording; R6-F6 / R6-T7 `FORCED_TABLES` definition; R6-S1 reverse role-switch residual;
  R6-S2 webhook step had no query; R6-S3 per-tenant forwarding; R6-T4 skip-count arms; R6-T5
  "census" ambiguity; R6-T6 I1 vs census.

### Recurring Issue Check
Functionality: R42 removal-path writer set re-derived (member DELETE, owner transfer, tenant
owner-assign, `/ownerless`, re-departure) — R6-F1. Security: RS1 R6-S1/S3; RS3 webhooks R6-S2;
RS6 positive control verified against `rls_bypass_admits` semantics. Testing: RT2 R6-T3; RT7
R6-T4; RT8 R6-T1/T2; RT10 R6-T1.

### Resolution
- R6-F1 — a second tested script, contain: ends confirmed (tenant, team, user) memberships the
  way C1 does (marker, outbox record with `manual`), refuses anything but an active membership of
  a departed member; an OWNER's team then goes through owner-assign.
- R6-T1, T2, T3, F3 — C4's C6 cells: exact set filtered to the cell's tenants, tied to C1's
  deactivated ∪ excluded sets, adjacent non-candidates, per-fixture record flags; inner-marked
  body run after C1; grant-removed run with the nil tenant id kept, asserting the control's
  message; own connection, stated as an exception to the wrapper.
- R6-F2 — nil tenant id in both scripts. R6-S2 — report section 2 lists webhooks (over-includes).
  R6-S3 — per-tenant forwarding. R6-S1, F5 — both role-switch directions in C1. R6-F4 — wording.
  R6-F6, T7 — `FORCED_TABLES` defined, fixture. R6-T4 — skip count declared advisory. R6-T5, T6 —
  wording.

## Round 7
Incremental. C1–C5 unchanged in substance; OWNER containment verified against `returnToTenant`
(owner-assign demotes departed OWNER rows, so a return cannot create two owners), the ownerless
filter and key state (departure keeps member keys; rotation clears `key_distributed`).

### Findings
- R7-S1 [Major, design] Report section 2 lost the webhooks of memberships C1 or contain already
  ended; the post-C1 step omitted webhooks.
- R7-T1 [Major, design] The inner-body report cell after C1 would hit the positive control (C1
  restored the sentinels); no test bypass specified.
- Minor: R7-S2 section 2 columns (URLs embed credentials); R7-S3 contain attribution; R7-S4 /
  R7-F1 contain check-then-write without the app's tenant-row lock order (adjacent: C1 step 1 vs a
  concurrent return); R7-F2 owner-assign before rotation; R7-F3 contain input form; R7-F4 stale
  "classification" reference; R7-F5 / R7-T7 `FORCE_STATEMENTS`; R7-T2 "nothing written"
  read-back; R7-T3 mixed / cross-tenant refusals; R7-T4 contain fixtures' tenant, outbox
  `tenant_id`; R7-T5 ownerless absent-before; R7-T6 stamp value, pool-factory connection,
  script table-list mutants.

### Recurring Issue Check
Functionality: R42 marker writers (`endTeamMemberships`, C1, contain) checked against the
tenant-row lock protocol — R7-F1. Security: RS1 R7-S1; RS3 R7-S2/S3; RS5 R7-S4; RS6 OK.
Testing: RT2 R7-T1/T4; RT5 R7-T2; RT8 R7-T1/T2/T3/T6; RT10 R7-T3; RT11 R7-T7.

### Resolution
- R7-S1 — section 2 covers candidates' teams and teams of memberships with a C1-dir record; the
  ended-membership step starts with webhooks; C4 asserts a C1-ended team's webhook is listed.
- R7-T1 — the after-C1 body cell sets and asserts a test bypass (report's exact list, nil tenant).
- R7-S2 — six named columns, asserted. R7-S3 — required operator label + `session_user` in
  metadata via `jsonb_build_object`, bounded. R7-S4/F1 — contain takes advisory locks, tenant rows
  `FOR UPDATE`, then teams; guard and write are one `UPDATE … RETURNING` with a count check; C1
  locks the candidates' tenant rows `FOR SHARE` first. R7-F2 — owner-assign (key holder) before
  rotation; teams with no member. R7-F3 — placeholder lines, asserted once. R7-F4/F5/T7 — wording.
  R7-T2–T6 — C4 contain cells and mutants.

## Round 8
Incremental. App lock protocol verified (`lockTenantRows`' key and order are reproducible from
plain SQL; no deadlock cycle between C1 / contain and returnToTenant, owner-assign, rotation).

### Findings
- R8-S1 / R8-T1 / R8-F3 [Major, design; three-way convergence] Report section 2's C1-dir record
  arm named no store; outbox SENT rows are purged after `OUTBOX_RETENTION_HOURS`, so a
  drained record lives only in `audit_logs`; no cell for that arm.
- Minor: R8-S2 / R8-F3 section 2's anchor nulls after a return; R8-S3 / R8-F4 contain's advisory
  key, order, assembly mechanism and case normalisation; R8-S4 typed input, label quoting and
  template token; R8-S5 / R8-F6 dangling C6 parenthetical; R8-F1 `FOR SHARE OF` on the tenant
  rows only; R8-F2 invitation steps before membership step; R8-F5 owner-assign branch; R8-T2
  lock mutants need a two-connection cell; R8-T3 cross-tenant refusal must isolate its
  conjunct; R8-T4 contain cells' tenants and read-back isolation; R8-T5 label bound cells;
  R8-T6 stamp vs `now()` at millisecond precision; R8-T7 after-C1 bypass purpose and ordering.

### Recurring Issue Check
Functionality: R42 tenant-row lockers re-derived (SCIM user/group, directory sync, departure,
accept, invitations, members POST/PUT, approve/reject, owner-assign, team create) — all one
tenant, advisory first; R8-F1/F2. Security: RS1 R8-S1/S2/S5; RS3 R8-S4; RS5 R8-S3. Testing:
RT5 R8-T4; RT8 R8-T1/T2/T3/T5/T6; RT10 R8-T3; RT11 R8-T2/T4/T7.

### Resolution
- R8-S1/T1/F3 — section 2 reads both stores with the exact paths; `audit_outbox` in the report's
  list; C4 `audit_logs`-only fixture plus different-backfill and different-action negatives;
  per-arm mutants.
- R8-S2 — no stamp lists all of the team's webhooks; C4 cell after a return.
- R8-S3/S4/F4 — contain is one `DO` block; typed uuid array placeholder (malformed raises at the
  cast; upper case normalised by the cast); dollar-quoted label refused when empty, > 255 or
  the template token; the app's exact advisory expression and `COLLATE "C"` order; the row lock
  stated as what carries correctness.
- R8-F1 — `FOR SHARE OF tenant_members`. R8-F2 — invitation steps first. R8-F5/S5/F6 — C6
  steps numbered; owner-assign branch covers no assignable key holder.
- R8-T2 — two-connection `lock_timeout` cells per lock; order review-verified. R8-T3/T4/T5/T6/T7
  — C4 contain cells and after-C1 bypass revised.

## Round 9
Incremental. Functionality and security: Minor only. Testing: four Majors, all on how cells are
constructed — the pattern of mechanism-level specification becoming its own defect surface. The
resolution therefore states the test obligation once (every named control has a mutant run red
in Phase 2; an unkillable mutant is a deviation-log finding) instead of enumerating more
mechanics, and fixes the concrete defects.

### Findings
- R9-T1 [Major] Section 2 arm fixtures did not isolate their arm/conjunct.
- R9-T2 [Major] `returnToTenant` cannot run inside the cell's raw transaction.
- R9-T3 [Major] Combined lock holds mask lock mutants; C1 has three locks; A must lock a
  subject the script reaches, B as `passwd_app`.
- R9-T6 [Major] Cross-tenant refusal failed two conjuncts together.
- Minor: R9-F1 departures written before teams by `deactivateScimUser` (C1 order); R9-F2
  owner-assign 409 with a keyless OWNER; R9-F3 / R9-S1 section 2 and step 5 anchor moves on
  return + re-departure or row deletion; R9-F4 / R9-S2 contain input count, shape, emptiness,
  duplicates; R9-F5 `COMMIT` outside the `DO`; R9-F6 cross-tenant row-lock order; R9-S3 record
  evidence purged by retention; R9-S4 `operator` / `dbUser` reach tenant logs and webhooks;
  R9-T4 lock-cell cleanup; R9-T5 advisory key hand-copied; R9-T7 mutant list; R9-T8 contain
  success-cell details.

### Recurring Issue Check
Functionality: R42 lock-protocol writers re-derived incl. `tenant_member_departures` (R9-F1);
reorder changes no statement result (verified against the original). Security: RS3 R9-S2; RS4
R9-S4; webhook-group membership and worker metadata copy verified. Testing: RT2 R9-T5; RT5
R9-T1/T8; RT8 R9-T1/T3/T6/T7; RT10 R9-T6; RT11 R9-T2/T4.

### Resolution
- R9-F3/S1 — a record-found team lists all its webhooks (no time filter); records carry
  `departedAt`, which anchors step 5. R9-T2 — the return case is a committed-fixture cell through
  the real `returnToTenant`.
- R9-F4/S2/F5 — array shape, emptiness, distinct count, `IS DISTINCT FROM`; script shape
  `BEGIN; DO; COMMIT`. R9-F1 — 2c's insert before teams; full order stated. R9-F6 — `(tenant,
  user)` order. R9-F2 — step 2 split. R9-S3 — keep the first after-C1 output. R9-S4 — `dbUser`
  only to a session `NOTICE`; the label documented as tenant-visible.
- R9-T1/T3/T4/T5/T6/T7/T8 — C4 C6 cells rewritten (isolation preconditions, one-field negatives,
  one lock per cell, exported key helper, team/membership tenant match as one conjunct); Testing
  strategy restated as an obligation with the starting mutant list.

## Round 10 (final; loop cap)
Incremental. Security: no findings. Functionality and testing: Minor only.

### Findings
- R10-F1 [Minor, prose] Reorder justification ("no statement reads what another writes") false
  as written; the order itself is right.
- R10-F2 [Minor, design] C1's 2c departure-record insert held no advisory lock for SCIM-deleted
  subjects, who have no tenant row; a concurrent accept could slip through during the migrate.
- R10-T1 [Minor, design] The mutation obligation had no artifact Phase 3 reads.
- R10-T2 [Minor, prose] "section 1 exclusion" names a control the report lacks.
- R10-T3 [Minor, prose] Two refusal entries cannot be isolated by one-field negatives.
- R10-T4 [Minor, (b)] `SET LOCAL lock_timeout` before the script's own `BEGIN` is a no-op.

### Recurring Issue Check
Functionality: R42 lock-protocol writers re-derived for every table C1 writes — R10-F2. Security:
RS1–RS6 none; exclusion-record forgery re-checked (import endpoint writes a fixed action).
Testing: RT4 R10-T4; RT7 R10-T1/T2; RT10 R10-T3; others OK.

### Resolution
- R10-F1, F2, T1, T2, T3 — applied in the plan (advisory locks over candidates ∪ 2c subjects;
  `## Mutation results` table obligation; wording).
- R10-T4 — carried forward (plan `## Carried-Forward Plan Findings`).

## Final state
Plan review rounds: 10 (cap). Open Critical / Major: none. Saturation: rounds 9–10 found no
design defect in C1–C5; C6 converged after the user chose (round 6) to keep it in scope. One
Minor (R10-T4, reachable only by executing) carried forward. All contracts locked.
