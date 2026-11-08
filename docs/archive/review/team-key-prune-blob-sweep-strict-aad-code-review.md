# Code Review: team-key-prune-blob-sweep-strict-aad
Date: 2026-11-09
Review round: 1

## Changes from Previous Round
Initial review (incremental on the Phase 2 self-R-check baseline). Seeds unavailable —
full-diff review by three fresh experts.

## Functionality Findings
- FF1 [Major] `team_member_key_prune` evaluates its three NOT EXISTS per member row (DISTINCT
  after the filter) with no index serving the version predicate; at scale it can exceed the
  statement timeout every tick. The "index-friendly" comment is unsupported (R29, R53).
- FF2 [Minor] A breaker refusal on a dense or first-tick orphan stretch repeats every pass; the
  operator remedy is not documented.
- FF3 [Minor] `--init-blob-marker` runs the DB-URL refines though it never connects.
- FF4 [Minor] A blob sweep configured on the DB backend is a silent no-op.

## Security Findings
- SS1 [Major] The prune takes no team lock. A history restore holding `teams FOR SHARE` reads
  history row h (version k) unlocked; the retention GC history sweep deletes h and commits; the
  prune's snapshot sees k unreferenced (entry not yet committed) and deletes k; the restore
  commits the entry at k → the live entry is sealed under a key nobody holds. The plan's part-1
  argument ("copies an existing reference inside one transaction") omits third-party deleters of
  the copy source (R3/R42, R51).
- SS2 [Major] `buildEntryRekeyPayload` opens a live v1+ entry at the server-reported
  `aadVersion`; a malicious server reporting 0 and serving a legacy history row resealed with no
  AAD under the live ItemKey (D81) launders that content into an AAD-bound live row. C6 approves
  the call; the `crypto-team.ts` header overclaims (R49). Carried over from main's
  `teamEntryAadFor`.

## Testing Findings
- TF1 [Critical] The race cells run B entirely before A commits, so no cell can fail on a
  multi-statement prune regression; the header claims snapshot evidence (RT4, R49).
- TF2 [Major] The breaker's 20-key floor is unpinned (the allow cell runs at ratio 1.0).
- TF3 [Minor] Exact grace and `maxDeletes` equality boundaries untested.
- TF4 [Minor] MinIO young side asserts only `deleted === 0` (a refusal passes too).
- TF5 [Minor] MinIO `afterAll` loops forever on partial `DeleteObjects` errors.
- TF6 [Minor] The C2 gate self-test lacks its fail-loud arms.
- TF7 [Minor] RDS-shape cell superuser URL falls back to `""`.
- TF8 [Minor, Adjacent] The unparseable-key cell's "never reads a row" assertion cannot fail.

## Adjacent Findings
- TF8 (testing → functionality): see above.

## Quality Warnings
None.

## Recurring Issue Check
### Functionality expert
R1 checked · R2 accepted (D6) · R3 checked · R4/R12 checked · R5/R9 checked · R14 checked · R16
(SC3, FF4) · R18 checked · R29 FF1 · R31 checked · R32/R35 checked · R38/R56 FF2 · R40 checked ·
R41 FF4 · R48 checked · R53 FF1 · R55 checked · R57 checked · RT1 spot-check clean.

### Security expert
R3/R42 SS1 · R5/R9 SS1 · R14 OK · R25 OK · R29 SS1, SS2 · R31 OK · R39 SS1 · R43 OK · R47 OK ·
R49 SS2, SS1 · R51 SS1 · R54 OK · R55 OK · RS3 OK · RS4 OK.

### Testing expert
R44 checked · R49 TF1 · R50 TF6, TF7 · RT1 checked · RT4 TF1 · RT5 checked · RT6 checked · RT7
TF1, TF6 · RT8 TF8 · RT10 TF2, TF3 · RT11 TF5 · R42 checked.

## Environment Verification Report
- VE1 S3 list/marker/delete: `verified-local` (`ANCHOR_TEST_S3_ENDPOINT=http://127.0.0.1:9000 npm
  run test:integration -- retention-gc-blob-orphans`, 6/6) and `verified-CI` pending the PR run
  (ci-integration starts MinIO). Azure / GCS: `blocked-deferred` — Phase 1 VE1; deviation D5.
- VE2 AWS: inert (no `BLOB_BACKEND` wired) — SC3 follow-up.
- VE3 iOS golden vectors: `blocked-deferred` — Phase 1 VE3 (separate build host); vectors are
  byte-identical to the web and extension ones (testing expert verified).

## Resolution Status

### Round 1
- SS1 [Major] / TF1 [Critical] / FF1 [Major] — Action: new forward migration
  `20261109100000_team_member_key_prune_team_lock`: bypass and batch guards, a READ COMMITTED guard,
  statement 1 locks candidate teams `FOR NO KEY UPDATE OF t SKIP LOCKED` (LIMIT p_batch, pre-filtered
  to teams with an unreferenced old version — D10), statement 2 decides per (team, version) pair in a
  fresh snapshot restricted to the locked teams; "index-friendly" claim dropped. Copier member-set
  re-derived: every writer of a non-current version holds `teams FOR SHARE` from before reading its
  source until commit (restore, PUT snapshot, re-key; rotation holds NO KEY UPDATE). C2 gate checks
  the body shape on the shared SQL lexer (26 self-test cells incl. TF6 fail-loud arms). Integration:
  three-party SS1 cell, in-flight-commit cell, skip cell, live shape check; header states what each
  proves. Red-proof on an isolated DB: lock removed → SS1/in-flight/skip red; decide-then-lock → in-flight
  red; no SKIP LOCKED → SS1/skip red. Modified: migration, `scripts/checks/lib/team-key-prune-shape.mjs`,
  `check-team-key-version-refs.mjs` (+test), `team-member-key-prune.integration.test.ts`, policy and
  worker docs; deviations D10–D14.
- SS2 [Major] — Action: `buildEntryRekeyPayload` blocks a live v1+ entry whose `aadVersion !== 1`
  (UNDECRYPTABLE) and opens strictly; removed from the C6 allow-list; header corrected. ItemKey (v1+)
  postdates AAD and v1+ creation always required aadVersion ≥ 1; such a row is already unreadable to
  every strict reader (D67), so blocking it loses no read. Cells incl. the laundering shape; guard
  fixture. Modified: `src/lib/team/rekey-payload.ts`, `crypto-team.ts` (comment), tests; D15.
- FF2 — docs: "Breaker refusals" operator section. FF3 — DB-URL refines skipped under
  `--init-blob-marker` (spawn cells both sides). FF4 — one `retention-gc.blob_sweep_inert` error line
  at start when mode ≠ off on the DB backend (cells both sides).
- TF2/TF3/TF8 — boundary cells (floor 20/21 at ratio 0.5, exact grace, exact maxDeletes), exact
  `readRefs` ids; red-proved. TF4 — young count and refused undefined (D16: MinIO 1 s granularity).
  TF5 — bounded cleanup, throws on DeleteObjects errors. TF7 — named errors + rolsuper check.
- Verification: vitest 21626 pass; extension 2761; typecheck/lint 0; integration 1442 pass (MinIO);
  gates, audit-db-grants, worker bundle smoke 0; `next build` 0.
