# Coding Deviation Log: team-key-prune-blob-sweep-strict-aad

## Phase 2

- D1 (orchestrator decision, external review item 3) — `RETENTION_GC_BLOB_ORPHAN_GRACE_MS` has
  no schema default. A worker-schema refine requires it when `RETENTION_GC_BLOB_SWEEP_MODE=delete`;
  `report` mode falls back to `BLOB_ORPHAN_GRACE_REPORT_DEFAULT_MS` (one day) in
  `buildSweepOpts`. Reason: a default of one day in delete mode would delete objects that a DB
  restore to an older point needs. Cells: delete without grace fails, delete with grace passes,
  report without grace passes.
- D2 (C1 RDS-shape cell) — the cell observes the bypass report instead of flipping
  `rls_bypass_enforced()`: `check-bypass-rls` forbids creating routines outside migrations, so
  the test cannot redefine it. It still runs in one rolled-back superuser transaction with a
  NOSUPERUSER NOBYPASSRLS stand-in owner and FORCE RLS on the five tables, asserting no
  `rls_bypass_not_granted` under the production grant (and the referenced v2 kept) and the
  history table reported when the grant omits it (negative control); a fresh connection confirms
  report mode, the owner and the absence of the probe role.
- D3 (C1 rotation race cell) — after the rotation commits, the re-run prunes v3 (now
  non-current and unreferenced); the cell asserts v2 (referenced) and v4 (current) survive.
- D4 (C9 `--init-blob-marker` smoke) — no `worker-bundle-smoke.json` entry: that map is one entry
  per ECS task pinned to `ecs.tf` and its harness runs only `--validate-env-only`. The smoke
  check builds the real bundle with the new code (proves no top-level await in the CJS bundle),
  the MinIO integration cells spawn the entrypoint (`created`, `exists`), and store-less spawn
  cells cover the exit-1 refusals.
- D5 (C3 VE1) — Azure/GCS list fixtures are typed against the stores' narrow shapes, not
  `satisfies` against SDK types: neither SDK is installed in this repo. S3 fixtures are typed
  against `ListObjectsV2CommandOutput`.
- D6 — `BLOB_SWEEP_MODE` lives in `src/lib/blob-store/constants.ts`: the worker sweep-bounds
  scanner reads a `"delete"` literal inside a worker module as SQL; `env-schema.ts` keeps its
  own literal enum because `check-public-contract` pins its import closure. Empty optional blob
  variables are treated as unset by the worker schema (the dev `.env` has `BLOB_BACKEND=`).
  Audit metadata adds `holderUserIdsOmitted`; the function rejects `p_batch < 1` (22023).
  `app-role-denied-privileges.json` covers tables and sequences only, so no function entry.
- D7 (C5) — `openTeamEntryFieldAt` treats exactly 1 as strict, 0 as legacy, anything else
  throws (the C5 acceptance cell's "2 throws" over the approach text's "integer ≥ 1"; no AAD
  version 2 exists). `tryOpen` does not catch it, so a malformed label stops the re-key pass;
  the history view shows its decrypt-failed toast.
- D8 (C7 scope) — (c') scope root: function declaration, method, or outermost arrow/function
  expression; nested arrows (incl. variable-bound React handlers) belong to the root; nested
  function declarations are their own scope. (b') uses the nearest declared function or
  variable-bound arrow; unbound closures (the `tryOpen` callback) are skipped. Key sources
  re-derived: the plan's five plus `getEntryItemKeys`, `getTeamEncryptionKeyForVersion`,
  `resolveTeamKey`, `requireTeamKey`, `deriveTeamEncryptionKey`. The measured hit on the
  migrated tree (`entry-history-section.tsx` component scope) was fixed by moving the personal
  decrypt into `openPersonalHistoryBlob`; `TRIPWIRE_EXEMPT` is empty.
- D9 (CI parity, Step 2-1 item 7) — deferred parity gaps, pre-existing: `check-npm-audit.mjs`
  needs registry network access; `check-terraform-test-count.mjs` covers the terraform tree,
  which this change does not touch.

## Verification evidence (Phase 2)

- `npx vitest run` exit 0 (1154 files, 21581 tests); extension `npx vitest run` exit 0 (91 files,
  2761 tests); `npm run typecheck` 0; `npm run lint` 0; `npx next build` 0.
- `npm run test:integration` (dev DB + MinIO) exit 0 (147 files, 1439 tests), run by the batch W
  implementer; `audit-db-grants.mjs` on the migrated dev DB 0.
- MinIO honoured `If-None-Match: *` (second `createMarker` → `exists`, body unchanged).
- EXPLAIN ANALYZE of the prune on the dev DB: 0.514 ms execution (dev data is small; production
  scale not measured).
- Red-proofs on scratch copies / an isolated database (`tmk_redproof`, created and dropped): C1
  predicates, blob grace / marker / breaker arms / exact equality, C7 rules (each fails exactly
  its own cells), 34 T8 per-site mutants all caught.

## Step 2-5 self-R-check

- Security: no findings.
- Functionality R1 (Major) — `errCode` read only the top-level code, so a prune refusal logged as
  Prisma's `P2010`; now delegates to `errorLogFields` (`pgErrorCode` first). Dispatch test uses
  the adapter's real nested shape (red against the old helper by construction: top-level `P2010`).
- Testing R42 (Minor) — `rotation-payload.ts` and `entry-history-section.tsx` added to the (d')
  floor. RT11 (Minor, accepted per plan C1 note) — local integration runs prune unreferenced keys
  across the developer's dev DB.
- External review follow-ups: manual-test rollback keeps the audit enum/constants/labels and
  names every inventory a function removal must update; orphan scenario reproduces the
  post-commit cleanup failure; blob integration `afterAll` cleans up only what `beforeAll`
  created.

## Code review round 1

- D10 (SS1, FF1; supersedes the approach's concurrency part 2 and C1's "one statement" control
  class) — `team_member_key_prune` is redefined by
  `20261109100000_team_member_key_prune_team_lock` (forward migration; 20261108120100 untouched).
  One statement was not enough: a restore holding `teams FOR SHARE` reads history row h at k, the
  GC history sweep deletes h and commits, and a snapshot that sees neither h nor the uncommitted
  entry at k deletes k. The body now (1) refuses outside READ COMMITTED (the argument needs a new
  snapshot per statement), (2) locks up to `p_batch` teams `FOR NO KEY UPDATE OF t SKIP LOCKED`,
  (3) decides and deletes in a later statement restricted to `team_id = ANY (v_teams)`, with the
  three reference checks evaluated once per distinct (team, version) pair (`pairs` → `picked`).
  Safety: every copier of a non-current version (restore, PUT snapshot, re-key) holds `teams FOR
  SHARE` from before it reads its source until commit; rotation holds `FOR NO KEY UPDATE`; both
  conflict with the prune's lock, so the team is skipped, and a copier of a locked team is seen
  committed or has not started. Third-party deleters of a copy source are covered because the
  copier still holds the lock. Deviation from the orchestrator's step-1 text: the lock statement
  also filters to teams with at least one old version unreferenced at its (pre-lock) snapshot —
  without it, more than `p_batch` teams whose old versions are all referenced would fill every
  call and later teams would never be reached; the filter only chooses what to lock, step 2
  decides. Because the pre-filter mentions the reference columns too, C2 now checks the
  reference names inside the RETURN QUERY only. The "index-friendly" claim is gone; no new index.
- D11 (C2 / TF1) — the body-shape rules live in `scripts/checks/lib/team-key-prune-shape.mjs`
  (shared SQL lexer), used by the gate over the latest defining migration and by the integration
  test over `pg_get_functiondef`. Rules: bypass check first; guards are `IF <cond> THEN RAISE` with
  no statement keyword in the condition; a READ COMMITTED guard before the lock; exactly one
  `SELECT … INTO v` locking teams `FOR NO KEY UPDATE OF <teams alias> SKIP LOCKED`; exactly one
  RETURN QUERY, last, containing `<alias>.team_id = ANY (v)`; nothing else (PERFORM, DML,
  dynamic EXECUTE, DECLARE initialisers). Limit: the restriction is required to appear, not to be
  a top-level conjunct of every read.
- D12 (C1 race cells) — the rotation cell's expectation changed: A's UPDATE holds the team row,
  so the team is now skipped while A is open ([1, 2, 3], with an unlocked control team pruned),
  and the post-commit prune leaves [2, 4]. The restore / snapshot cells keep their writers
  WITHOUT the team lock: they now prove that the deciding statement reads one snapshot.
- D13 (SS1 red-proof m2) — "decision before lock" in one statement is red only if A commits
  between that statement's snapshot and its lock. The "SS1" cell holds A for the whole call, so
  m2 is green there by construction (SKIP LOCKED still skips A's team); a second cell, "SS1, A
  commits during the call", releases A as soon as the prune backend is observed running, and the
  test-local m2 mutant widens its window with `pg_sleep(1.5)` before the lock. Production passes
  that cell for any commit point; without the widened window it would release A after the call.
- D14 (RDS-shape cell) — the stand-in owner needs `UPDATE` on `teams` to take the team lock; in
  production the migration role owns both the function and the table.
- D15 (SS2; supersedes D7 for the live entry) — `buildEntryRekeyPayload` blocks a live v1+ entry
  whose `aadVersion` is not `AAD_VERSION` (`REKEY_ENTRY_BLOCK.UNDECRYPTABLE`, no new API code)
  and opens it with strict `openTeamEntryField`; D7's "a malformed label stops the re-key pass"
  no longer applies to it (the 2.5 throw cell is now a blocked cell). C6 drops
  `buildEntryRekeyPayload` from the allow-list; `buildEntryUpgradePayload` / `reencryptV0`
  (v0 entries under the team key) and `handleView` keep it. The extension never re-keys; iOS has
  no re-key path (`rg -i rekey extension/src ios` finds none).
- D16 (TF4) — the MinIO young side cannot assert `young === 1`: MinIO's 1 s LastModified
  granularity can give the referenced object the orphan's second, making it young too. The cell
  asserts `young` equals the count of attachment objects listed at or after the orphan's
  LastModified (≥ 1) and `refused` undefined.
- D17 (FF4) — the start-time line is `retention-gc.blob_sweep_inert` (error level, `{ mode }`),
  logged once per `start()` from `createWorker`'s loop.
- D18 (FF3) — `--init-blob-marker` skips both database-URL refines (at-least-one URL, production
  scoped URL); every other refine still applies to it.
- D12 correction (round 2, testing N2): the restore / snapshot cells prove that B never acts on
  an open writer's uncommitted move (the reference is still seen on the side it left, and k
  survives the commit); that the body decides in one statement is the shape gate's job, not
  theirs.

## Code review round 2

- D19 (functionality N1) — `20261109110000_team_member_key_prune_team_cap` (forward
  `CREATE OR REPLACE`) splits the round-1 lock statement in two: (1) an unlocked candidate
  statement with the per-pair pre-filter, `LIMIT 25`; (2) `SELECT … FROM teams t WHERE t.id =
  ANY (v_cands) … FOR NO KEY UPDATE OF t SKIP LOCKED`; (3) the unchanged RETURN QUERY on a fresh
  snapshot. Reason: round 1 locked up to `p_batch` (1000) teams while its pre-filter scan was
  still running and held them through the decision, the audit rows and the commit; every team
  writer waits at most `TEAM_KEY_LOCK_TIMEOUT_MS` (3 s) and then fails.
- D20 — the cap is a constant in the body (25), not a parameter: a second parameter changes the
  signature, which is a new function (EXECUTE grant, `bootstrap-rds-roles.mjs`,
  `db-grants-manifest.json`, the worker's call) for a value nothing needs to tune. 25 keeps the
  lock footprint and the audit rows per call small; teams beyond the first 25 (id order) are
  reached on later ticks because a team leaves the candidate set once its unreferenced versions
  are gone. A team a writer keeps locked holds one of the 25 slots for that tick only.
- D21 (measurement, isolated DB `tmk_perf_r2`, created/migrated/dropped) — 1 team × 500
  members × 4 versions (v1 unreferenced), 20 000 entries, 50 001 histories, 2 000 mode-0
  attachments, plus 30 small teams with unreferenced versions; ANALYZEd. EXPLAIN ANALYZE:
  candidate statement 163–167 ms (unlocked), lock statement 0.05 ms (25 teams), decide+delete
  27.2–27.6 ms (49 pairs). Lock-to-commit, statement by statement with one audit INSERT per
  team: 30.7 ms (25 teams, 49 pairs) and 19.2 ms (6 teams); a FOR SHARE writer on the big team
  queued right after the lock waited 28.5 ms. The round-1 lock statement (search under lock,
  `LIMIT 1000`) took 176–178 ms on the same data, all of it under the team locks.
- D22 (shape gate) — rules added: exactly one unlocked candidate `SELECT … INTO` (no FOR
  UPDATE/SHARE) with `LIMIT <integer literal>`; exactly one locking `SELECT … INTO` that reads
  only `teams`, restricts to `<alias>.id = ANY (<cands>)` and precedes the RETURN QUERY; the
  candidate precedes the lock. The round-1 body now fails the gate (self-test cell).
- D23 (testing N1) — a deterministic park point exists only before a statement's snapshot:
  PostgreSQL takes a statement's relation locks when it plans it. The "parked" cell holds
  `attachments` ACCESS EXCLUSIVE so the function waits when it plans its candidate statement;
  A commits there. It is deterministic but does not distinguish a one-statement
  decide-then-lock body (red-proof m2 green in every behavioural cell); that body is excluded
  by the shape gate's "decision precedes the lock" and "lock reads only teams" cells. No
  production change was made to create a park point. The round-1 timing harness
  (`settledOrPruning`, the `pg_sleep` mutant) is gone.
- D24 (testing N3) — live cell: REPEATABLE READ, worker role, production grant → 25001
  `TEAM_KEY_PRUNE_ISOLATION`, the seeded versions stay; READ COMMITTED then prunes them.
- D25 (allow side of the bounded wait) — live cell: a prune transaction holds the team lock, a
  production `lockTeamKeyVersion` writer waits on it, and completes with the team once the
  prune commits, inside `TEAM_KEY_LOCK_TIMEOUT_MS`.
