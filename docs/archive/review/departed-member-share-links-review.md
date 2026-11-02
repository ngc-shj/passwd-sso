# Plan Review: departed-member-share-links
Date: 2026-11-02
Review round: 5 (saturated)

## Changes from Previous Round
Initial review of plan v1 (serve-time predicate as a `Prisma.Sql` fragment, bypass
grants widened, file-level gate). Local LLM pre-screen: tenant departure reaching
`team_members` was unstated — added before round 1 (citation of the gate's rules
corrected against its source).

## Functionality Findings
- F1 [Major, design] `Prisma.Sql` fragments are denied by `check-raw-sql-usage`;
  `trustedSql` values cannot enter tagged `$executeRaw` → a SQL function.
- F2 [Major, design] Predicate only in the UPDATE answers maxViews/410, not revoked;
  the page's password-protected branch and verify-access ordering were uncovered.
- F3 [Major, design] C4 not implementable on Prisma `findMany` with status filters;
  the UI would label a dead link "Expired"; "revoked" misstates a revivable state.
- F4 [Major, design] File-level gate passes with one of two UPDATEs unguarded.
- F5-F9 [Minor, prose/design] Wrong derivation command (content reads by id); C3
  rationale (report-mode bypass); discriminator app-only; guest rationale; sharing
  policy and role equivalence unrecorded.
- F10 [Adjacent, Minor] Master-key rotation also revokes version-0 team shares.

## Security Findings
- S1 [Major, design] Same as F2: refused distinguishable from revoked, revealing
  membership to a link holder.
- S2 [Major, prose] C3 rationale wrong (`rls_bypass_admits` in report mode admits
  with a WARNING; after the flip, 42501); the planned test could not catch it.
- S3 [Minor] Revival restores an outsider's access on any re-admission → require the
  membership row to predate the share.
- S4 [Minor] Discriminator grep-enforced → DB CHECK.
- S5 [Minor] Widened grant is read+write and ambient → SECURITY DEFINER function.
- S6 [Minor] "Every path" claim has a counterexample (bootstrap tenant migration).
- S7 [Minor] Control class overstated (stops further retrieval only).
- S8 [Minor] Gate granularity (same as F4). S9 [Minor] Trashed entries foldable in.
- S10 [Adjacent, Minor] Sharing policy only checked at creation.

## Testing Findings
- T1 [Critical, design] No per-site positive control: a broken predicate or grant
  passes every refusal test.
- T2 [Major] No per-site expected-answer table; refusal vs maxViews indistinguishable.
- T3 [Major] Protected branch untested (same as F2/S1).
- T4 [Major] No harness stated for the RSC page.
- T5 [Major] Gate per file (same as F4); self-test fixtures, missing-file, exit status.
- T6 [Major] Unit SQL-string mocks; new raw calls; two test trees.
- T7 [Major] Missing cells: entry delete, cross-team isolation, other member active,
  C4 lists, DELETE-then-re-add, download, trashed entry.
- T8 [Major] A5 needs a deterministic shape (stale permission), not a race test.
- T9-T11 [Minor] Red-proof clause list and preconditions; E2E/manual cell; TS
  spelling of "team share".

## Adjacent Findings
F10 (rotation over-revocation) → SC4. S10 (policy) → SC3.

## Quality Warnings
None.

## Recurring Issue Check
### Functionality expert
R1 (F1), R3 (F2, F3), R12 (F3), R14 (F1 grants), R29 (F5, F6, F8), R42 (F2, F5),
R48 (F3, F9), R49 (F2, F4), R52 OK.
### Security expert
R29 (S2, S6), R42 (S1, S6), R43 (S5), R49 (S2, S4, S5, S7), R54 (S5); RS2 OK; RS3
(alias must not be free text — moot with the function); RS1, RS4-RS6 n/a.
### Testing expert
RT1 (T6), RT2 OK, RT3 (constants), RT4 (T8), RT5 (T4, C4), RT6 (direct DB test),
RT7 (T1, T5), RT8 (T2), RT9 (C4 reuse), RT10 (T1, T7), RT11 (T9); R19, R42, R44,
R46, R48, R33.

## Resolution Status (plan v2)
- F1, S5, S2/F6: C1 is a `SECURITY DEFINER` SQL function; bypass grants unchanged
  (no C3 grant widening); EXECUTE granted in the migration, RDS/CI bootstraps and the
  grants manifest.
- F2, S1, T2, T3: per-site pre-check beside the revoked check (page before the
  protected branch; verify-access before the password check) answering as revoked;
  the UPDATEs also call C1; per-site answer table in C3.
- F3, T7e: C4 adds `creatorAdmitted` with a distinct badge (en/ja); filters unchanged.
- F4, S8, T5: per-statement gate with pinned counts, self-test fixtures, missing-file
  failure, `Static:` step.
- S3: `m.created_at <= s.created_at`; revival defined per path in Design.
- S4, F7: C2 CHECK (`NOT VALID` for historical rows).
- S9: `e.deleted_at IS NULL` folded into C1 (trash and restore covered in A2/A3).
- S6, F8: claim narrowed; the bootstrap case recorded in Considerations.
- S7: Objective states refusal stops further retrieval; rotation is the remedy.
- F9: role equivalence recorded in C1; sharing policy → SC3.
- F5: derivation command restated (bypass-grant readers).
- T1, T7, T8: acceptance cells with positive controls per site, protected ×
  unprotected, refusal asserted against a revoked control; A4, A5, A7 deterministic.
- T4, T6, T9, T10: harness, mock updates in both trees, red-proof list, manual-test
  plan stated in Testing strategy.
- T11: the TS branch `masterKeyVersion === 0` in page/content selects the E2E render
  path and is not an admission decision; forbidden patterns now target the rule's
  terms instead.

## Round 2 (plan v2)

Findings (design unless noted):
- S11 / T12 [Critical] / F11 [Major] Converged: a SECURITY DEFINER owned by the RDS
  master (NOSUPERUSER NOBYPASSRLS) is still bound by FORCE RLS; its reads hit
  `rls_bypass_admits` under the callers' grants (WARNING now, 42501 after the flip);
  dev/CI migrate as a superuser and cannot show it.
- S12 / F12 [Minor/Major] A new definer trips `[E-RLS-SECDEF]` (CI + pre-pr fatal).
- S13 [Minor] Team test keyed on version admits legacy version-1 team rows.
- S14 / F15 [Minor] Invitation accept also reactivates the old row (revival list).
- S15 [Minor] Fail-closed shape unstated. S16 [Minor] Timing one query longer.
- F13 [Major] C4 consumers key on `isActive`; badge unreachable as specified.
- F14 [Minor, prose] Two UPDATEs per file; verify-access revoked check outside the
  bypass callback.
- T13-T22 [Major/Minor] A7 infeasible after tenant departure; unreachable refusal arms;
  C1 matrix and millisecond boundary; gate binding/ordering/fixtures; C4 badge
  harness; UPDATE counts; deltas; mock list; A9 SQLSTATE; red-proof list.

Resolution (v3): SECURITY INVOKER function with function-scoped `SET app.bypass_*`
(probed); team test `team_password_entry_id IS NOT NULL OR master_key_version = 0`;
`COALESCE(…, false)` and `=== true`; revival writers enumerated and accepted; timing
accepted; C4 `shareLinkStatus` precedence; per-site counts; A7 via team-level loss;
A10 matrix; gate binding-aware.

## Round 3 (plan v3)

Findings:
- F16 [Critical, design] A definition carrying `SET app.*` cannot be created by a
  NOSUPERUSER role — confirmed by probe (`permission denied to set parameter
  "app.bypass_rls"`); the RDS migration would fail. The v3 probe only reowned.
- F17 [Major, design] A8's `GET /api/share-links` as another member is unreachable
  (the route lists the caller's own links).
- F18 [Minor, design] `shareLinkStatus` dropped `maxViewsReached`; no client-safe home.
- S17 [Minor, design] No catalog check for routines that set `app.bypass_*`.
- S18 [Minor, design/prose] The enforce-flip cell needs a `CREATE OR REPLACE FUNCTION`
  in a test (function rule); the owner variation is meaningless for an INVOKER function.
- T23, T24 [Minor] A10 connection/context/role not pinned; SET red-proof observable in
  the base cells.
- T25 [Major, design] No committed cell fails when C1 leaves the UPDATEs.
- T26-T30 [Minor] A7 toggle per cell; page import assertion shape; dashboard page
  untested; gate rule 2 "function" undefined; A9 constraint read path.

Resolution (v4): plpgsql body saving / `set_config(…, true)` / restoring the settings
in a subtransaction (pattern of the claim-event purge), probed as created by a
NOSUPERUSER role; A10b applies the migration file as a non-superuser;
`[E-RLS-BYPASS-ROUTINE]` added; `share_admission` recorded beside `BYPASS_PURPOSE`;
A10 on one su connection via `SET LOCAL ROLE passwd_app` in three contexts with the
notice sink; enforce flip and owner variation dropped; A12 forces the pre-check true;
A8 rewritten per audience; `shareLinkStatus` in a dependency-free module with all arms;
gate rule 2 defined over the top-level enclosing function; A9 via the su pg client;
per-cell toggles; page element assertion shape.

## Round 4 (plan v4)

No Critical. Findings:
- F1 / T32 [Major, design] A10b could not apply the whole migration file (its
  `BEGIN/COMMIT` commits the test transaction; the function already exists; C2 needs
  table ownership).
- T31 [Major, design] A10 on a raw pg client has no notice listener, so the report-mode
  red-proof could not fail; contexts must use the production GUC helpers.
- T33 [Major, design] A12 reached one of two UPDATEs per site.
- S19 [Minor] `set_config` placement and the single exit unpinned; the leak path is a
  normal return skipping the restore, not the error path.
- S20 / F3 / T35 [Minor] Restore of a never-set value (`''`), the purge's `'off'`
  default, and the comparison in A10.
- S21 / F2 / F4 [Minor] `[E-RLS-BYPASS-ROUTINE]` predicate (prosrc + proconfig, all
  routine kinds and schemas, regprocedure allowlist) and a self-contradicting
  allowlist sentence.
- T34 [Minor, prose] The subtransaction restore is unobservable.

Resolution (v5): C2 in its own migration; A10b strips the wrapper with `analyze()` and
drops the function first; A10 on `ctx.su.prisma.$transaction` with `setTenantGucs` /
`setBypassGucs` and a sink positive control, comparing normalised settings in every
result arm plus `app.tenant_id`; A12 with `maxViews` set and unset, named answers and
a live twin; C1 pins `set_config` inside the block, the handler re-raises only, a
single `RETURN` after the `COALESCE(saved,'')` restore; `[E-RLS-BYPASS-ROUTINE]`
predicate and allowlist specified; subtransaction restore declared unobservable.

## Round 5 (plan v5)

Findings, labelled by the expert who filed them:
- F-R5-1 / T36 [Major, (a) prose] A12's `maxViews` variation reaches the same non-FILE
  UPDATE; the second UPDATE per site is the FILE arm.
- T37 [Major, (a) prose] A10's legacy cell drops C2 in a transaction not stated to roll
  back; `set_config(…, true)` makes context order matter.
- F-R5-2 / T38 [Minor, (a)/(b)] `analyze()` only counts; the wrapper is sliced, and the
  file must start with `BEGIN;`.
- S22 [Minor, (a)] Allowlist comparison must be a `::regprocedure` cast, never
  `to_regprocedure` in `NOT IN`.
- S23 [Minor, (a)] `SET SESSION` and the tripwire's known bypasses.
- T39 [Minor, (b)] The sink positive control runs as `passwd_app` in a bypass context.

All resolved in the plan file (v5): A12 seeds a FILE-type team share through su; one
rolled-back transaction per A10 context with seeding as su; slice wording and
`BEGIN;`-first file; cast comparison; `(LOCAL|SESSION)` and the bypass list; positive
control role and context; `RESET ROLE` in A10b.

## Saturation call

Round 5 meets all four conditions: (1) five rounds completed; (2) no Critical or Major
open — the two Majors were prose and are resolved in the plan file; (3) no finding
against the design itself — the contracts, control classes and invariants have been
unchanged since round 3 (the round-4 change to C1's body was a mechanism fix of F16,
and rounds 4-5 found only test-procedure and wording gaps); (4) every remaining
finding is (a) prose-only or (b) reachable only by building and executing the tests.
Phase 1 closes; contracts C1-C5 are locked. No finding is carried forward.
