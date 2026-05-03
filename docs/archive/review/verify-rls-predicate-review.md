# Plan Review: verify-rls-predicate
Date: 2026-05-04
Review rounds: 5 (converged at "READY TO MERGE")

## Round 5 — Convergence

Combined functionality + security + testing single-pass review verified all R4 Major findings (F34/T28, T29, T30, T31) are RESOLVED:

- **F34/T28 (pre-pr.sh)**: sketch passes stub `expected_tables=users`, accepts `[E-RLS-MANIFEST-(EXTRA|MISSING)]` as parse-OK, uses `--single-transaction` for atomic rollback.
- **T29 (Block 1 ordering)**: NULL-clause guard now runs BEFORE symmetry guard (item 3 vs item 4); rationale documented.
- **T30 (Case 5 deterministic)**: Case 5 uses `$CANONICAL_POLICY`, only `[E-RLS-MANIFEST-MISSING]` can fire.
- **T31 (stable error codes)**: 10 codes embedded in ASSERTs (`[E-RLS-ROLE]`, `[E-RLS-DISCOVER]`, `[E-RLS-NULL]`, `[E-RLS-SYM]`, `[E-RLS-COLPARITY]`, `[E-RLS-MANIFEST-EXTRA]`, `[E-RLS-MANIFEST-MISSING]`, `[E-RLS-COUNT-A]`, `[E-RLS-COUNT-B]`, `[E-RLS-BYPASS]`); driver uses `grep -qF` (literal match).

R4 Minors (T32 Case 0 pre-flight, T33 accumulator) also addressed.

### R5 new findings (3 Minors, none blocking)
- M1: pre-pr.sh sketch retains `grep -qE` for the `(EXTRA|MISSING)` alternation — intentional, acceptable.
- M2: Block 2/3/4 prelude ASSERTs (`pre-Block-2:`) lack `[E-RLS-...]` prefix — not negative-test-targeted, acceptable.
- M3: Defensive `ASSERT t ~ regex` lacks code prefix — same rationale.

**Convergence verdict: READY TO MERGE.** Recommended proceeding to Phase 2 (Coding).

## Round 4 — major fixes & new findings

R3→R4 transitions resolved 7 Major + many Minor findings. New R4 Majors:
- F34/T28 — pre-pr.sh sketch missing `-v expected_tables`
- T29 — Block 1 NULL-clause / symmetry order cross-fire
- T30 — Case 5 manifest drift policy state unspecified
- T31 — Regex-based expected_failure_pattern fragile

All resolved in plan v5 (see Round 5 above).

## Round 3 — major fixes & new findings

R2→R3 transitions: floor → manifest, pg_policies → pg_policy, capture/restore → throwaway-table negative test. New R3 Majors (F25, F26, S12, S13, T11, T12, T22, T24) all resolved in plan v4.

## Round 2 — Changes from Round 1

## Round 2 — Changes from Previous Round

Plan v2 was rewritten to address all 3 Critical and 9 Major findings from Round 1:
- Floor 23 → manifest file `scripts/rls-cross-tenant-tables.manifest` (replaces numeric floor entirely; addresses S3 / S5 / S12 / F18 silent-shrink concerns)
- Discovery LIKE pattern fixed (matches bare and suffixed names)
- mcp_clients NULL-row added to seed; per-table override map for verify and bypass blocks
- Bypass count uses `count(*) FILTER (...)` form to avoid collision with existing rls-smoke-seed rows
- Risk #6 transaction-model justification rewritten; file header forbids BEGIN/COMMIT and `--single-transaction`; defensive `ASSERT current_setting()` guards added in each block
- Coverage strengthened to `=1`; ASSERT messages enriched with cause hints
- Block 1 parity assertion (column count vs discovery count) added
- Block 1 role-flag checks include session_user, is_superuser
- USING ↔ WITH CHECK runtime symmetry guard added (Block 1) — using `IS DISTINCT FROM` form (NULL-aware) plus a non-NULL guard
- Negative test added as 4th CI step using an **ephemeral throwaway table** (eliminates capture/restore corruption risk on real `users` policy)
- Block 4 explicitly `RESET app.tenant_id` to test bypass channel in isolation
- Manual test plan inlined with concrete env-var values for the local docker stack
- ASSERT-halt-on-first-failure replaced with `RAISE NOTICE` + accumulator + final `RAISE EXCEPTION` pattern in Blocks 2/3/4 (multi-table failures surface in one CI run)
- Discovery query switched from `pg_policies` view to `pg_catalog.pg_policy` table to avoid the role-USAGE filter that may hide policies from `passwd_app` (S13)
- Discovery-accessibility self-test added in Block 1 (loud failure if `passwd_app` can't read `pg_policy`)
- Pre-merge verification checklist added
- Two follow-up issues committed in Implementation step 9: app.bypass_rls hardening; rls-smoke-seed expansion or retirement
- F20 confirmed by code inspection (live mcp_clients policy is symmetric — no exception needed)

## Round 2 Findings

### Functionality (Round 2)

#### F18 [Major]: Floor==parity-target framing has weak defense-in-depth
- File: plan v2 line 215-216
- Resolution: **RESOLVED in plan v3**. Numeric floor replaced with manifest file; manifest equality check makes silent-shrink scenarios impossible without an explicit table-name diff.

#### F19 [Major]: COALESCE form of symmetry guard masks NULL=NULL case
- File: plan v2 line 94 (was `COALESCE(qual::text, '') <> COALESCE(with_check::text, '')`)
- Resolution: **RESOLVED in plan v3**. Switched to `pg_get_expr(p.polqual, p.polrelid) IS DISTINCT FROM pg_get_expr(p.polwithcheck, p.polrelid)`. Added a separate non-NULL guard for `polqual IS NULL OR polwithcheck IS NULL`.

#### F20 [Major]: mcp_clients live policy may be asymmetric
- Resolution: **RESOLVED by code inspection**. `prisma/migrations/20260328075528_add_rls_machine_identity_tables/migration.sql:45-57` confirms USING ≡ WITH CHECK using the standard symmetric template. No exception list needed in symmetry guard. Added explicit note in §Special cases.

#### F21 [Minor]: mcp_clients bypass FILTER doesn't separately assert NULL row
- Resolution: **RESOLVED in plan v3**. Block 4 explicitly asserts `count(*) FROM mcp_clients WHERE tenant_id IS NULL = 1` after the FILTER form check.

#### F22 [Minor]: Negative-test broken-policy window race
- Resolution: **RESOLVED in plan v3** structurally — the negative test now uses an **ephemeral throwaway table** instead of mutating a real production-table policy. There is no broken state of any real policy at any point. Sequencing constraint comment retained in script header.

#### F23 [Minor]: pg_get_expr round-trip may not be byte-identical
- Resolution: **RESOLVED in plan v3** structurally — same as F22. The throwaway-table approach eliminates the capture/restore problem because there is no real policy to round-trip. The test simply DROPs the throwaway table at end.

#### F24 [Minor]: Block 4 RESET commentary slightly misleading
- Resolution: **RESOLVED in plan v3**. Block 4 commentary now says: "no-op-safe: SET LOCAL from Block 3 already discarded at txn boundary". RESET retained as defensive intent marker.

### Security (Round 2)

#### S11 [Minor]: Text-equality symmetry guard has theoretical edge cases
- Resolution: **RESOLVED in plan v3**. SQL comment near the symmetry guard explicitly documents the false-positive vs false-negative tradeoff.

#### S12 [Major]: No in-PR friction for floor decrements
- Resolution: **RESOLVED in plan v3**. Replaced floor with a manifest file. Adding/removing a table requires editing a named-line entry; the diff is scrutable in code review without specialized tooling.

#### S13 [Major]: passwd_app may not see policies via pg_policies (role-USAGE filter)
- Resolution: **STRUCTURALLY ADDRESSED in plan v3**. Discovery switched from `pg_policies` view to `pg_catalog.pg_policy` table. Block 1 includes a discovery-accessibility self-test (`SELECT count(*) FROM pg_policy ... > 0`) that fails loudly if `passwd_app` lacks SELECT — catches the silent-zero-discovery failure mode before any per-table assertion. Pre-merge verification checklist requires running this query manually before submitting the PR.

#### S14 [Minor]: app.bypass_rls follow-up not committed
- Resolution: **RESOLVED in plan v3**. Implementation step 9 explicitly commits to filing two follow-up issues alongside merge.

#### S15 [Minor]: SIGKILL would skip trap
- Resolution: **DOCUMENTED in plan v3**. CI Postgres is ephemeral; leaked throwaway table is discarded with the runner. Header comment makes the constraint explicit.

#### S16 [Minor]: Manual test pre-condition insufficient
- Resolution: **RESOLVED in plan v3**. Manual test plan pre-conditions now include explicit psql precheck commands for `passwd_app` role + role flag verification + discovery accessibility.

### Testing (Round 2)

#### T11 [Major]: Negative test pre-condition not asserted (canonical-shape invariant)
- Resolution: **RESOLVED in plan v3** structurally — same fix as F22. Throwaway-table approach eliminates the canonical-shape capture concern because there's no real policy state to capture.

#### T12 [Major]: Manual test plan env-var defaults missing
- Resolution: **RESOLVED in plan v3**. Pre-conditions section includes concrete `MIGRATION_DATABASE_URL` and `APP_DATABASE_URL` strings for the local docker stack.

#### T13 [Minor → upgraded]: T7 deferred status warrants explicit cost statement
- Resolution: **RESOLVED in plan v3**. Implementation step 8 adds a `scripts/pre-pr.sh` syntax-check entry as short-term mitigation; if `pre-pr.sh` doesn't exist, the step files a follow-up issue.

#### T14 [Minor]: ASSERT halts on first failure — multi-table CI failures
- Resolution: **RESOLVED in plan v3**. Blocks 2/3/4 now use `RAISE NOTICE` accumulator + final `RAISE EXCEPTION` pattern. Multi-table breakage surfaces all failing tables in one CI run.

#### T15 [Minor]: Defensive note on textual symmetry check edge cases
- Resolution: **RESOLVED in plan v3**. SQL comment near symmetry guard documents the false-positive recoverability path.

#### T16 [Minor]: %s interpolation in Block 4 needs comment
- Resolution: **RESOLVED in plan v3**. Comment near `EXECUTE format(... %s ...)` documents that `filter_clause` is built from constants only and forbids extending to user input.

#### T17 [Minor]: Negative-test single-table target brittleness
- Resolution: **RESOLVED in plan v3** structurally — same fix as F22. Throwaway table eliminates dependency on a specific real-table.

#### T18 [Adjacent]: app.bypass_rls follow-up
- Resolution: **RESOLVED in plan v3** via S14 fix.

## Round 1 Findings (preserved for traceability)

### Original summary (Round 1)

## Summary

Three experts (Functionality / Security / Testing) reviewed the plan at `docs/archive/review/verify-rls-predicate-plan.md`.

- **3 Critical findings** — all on coverage / discovery completeness:
  - The cited table count (23) is wrong by ~30 tables; actual is ~52
  - Discovery `LIKE '%_tenant_isolation'` excludes the existing bare-named `tenant_isolation` policy on `team_policies`
  - `mcp_clients.tenant_id` is nullable; "exactly 1 row per tenant" assertion is fragile and the NULL-tenant invisibility case is unverified
- **9 Major findings** — fail-mode attribution, transaction reasoning, missing guards (USING == WITH CHECK symmetry, policies-must-not-decrease floor), Block 4 redundancy, manual-test.md not delivered, negative-cases manual-only
- **~10 Minor / Adjacent**

## Functionality Findings

### F1 [Critical]: EXPECTED_MIN_TENANT_SCOPED_TABLES = 23 is wrong by ~30 tables
- **File**: `docs/archive/review/verify-rls-predicate-plan.md:79, :139, :184`
- **Evidence**: Counting unique tables with `*_tenant_isolation` policy across ALL migrations yields ~52, not 23. The phase7 migration is only the initial batch; `access_requests`, `audit_chain_anchors`, `audit_outbox`, `directory_sync_*`, `notifications`, `service_accounts`, `tenant_members`, `webauthn_credentials`, etc. were added later.
- **Problem**: `ASSERT discovered_count >= 23` will silently pass with only 23 tables seeded — defeats the "loud failure" requirement.
- **Fix**: Run the actual discovery query during implementation; set the floor to the real number. Update plan text to "currently ~52 (verify with `SELECT count(*) FROM pg_policies WHERE policyname ~ 'tenant_isolation'`)". Document that the bump is required on EVERY new tenant-scoped table.

### F2 [Critical]: Discovery filter `policyname LIKE '%_tenant_isolation'` excludes `team_policies`
- **File**: plan:60-65
- **Evidence**: `prisma/migrations/20260301210000_add_team_policy/migration.sql:39` and `…20260302130000_fix_team_policy_rls/migration.sql` both create the policy as `CREATE POLICY "tenant_isolation" ON "team_policies"` with bare name (no table prefix). SQL `_` is single-char wildcard, so `'tenant_isolation'` does NOT match `'%_tenant_isolation'` (no leading char available).
- **Problem**: `team_policies` (a tenant-scoped table holding cross-tenant policy data) is silently excluded from auto-discovery. The plan's own guard ("`check-migration-drift.mjs` is the upstream guard") is incorrect — the drift check requires `\\S*tenant_isolation` which DOES match the bare name.
- **Fix**: Change LIKE to `(policyname = 'tenant_isolation' OR policyname LIKE '%_tenant_isolation')` OR `policyname ~ 'tenant_isolation$'`. Add a defense-in-depth assertion: every table with a `tenant_id` column must appear in the discovered set.

### F3 [Critical]: `mcp_clients.tenant_id` is nullable; NULL-row invisibility unverified
- **File**: plan:21-22, :76-77
- **Evidence**: `prisma/schema.prisma` declares `model McpClient { tenantId String? }` — the only nullable `tenantId` in the schema. DCR pre-claimed clients have `tenant_id IS NULL`.
- **Problem**: The `count = 1` assertion under `app.tenant_id = '<A>'` is correct only because no NULL row exists in the test DB. A future predicate bug like `USING (tenant_id IS NULL OR tenant_id = current_setting(…))` (a plausible attempt to "include unclaimed clients in tenant view") would make NULL rows visible to every tenant — but the assertion still sees count = 1 if no NULL rows are seeded.
- **Fix**: Seed a third row in `mcp_clients` with `tenant_id = NULL`. Per-tenant assertion remains `count = 1`. Bypass-block expected count for `mcp_clients` becomes 3, not 2 — implement via per-table override map keyed by table name.

### F4 [Major]: Bypass-block `count = 2` will collide with existing `rls-smoke-seed.sql` rows
- **File**: plan:78, :138, :102 ("existing rls-smoke files NOT modified")
- **Evidence**: Existing `rls-smoke-seed.sql:30-57` seeds 1 row of 7 tables under tenant `…0001`. After both seeds run in the same `rls-smoke` job, those tables have 3 rows total (existing + A + B) — bypass-block ASSERT count=2 fails on every overlapping table.
- **Problem**: CI step will fail in its current form with no policy bug — pure seed-data interference. Implementer may "fix" by weakening to `count >= 1`, gutting the test.
- **Fix**: Replace the absolute `count = 2` with `count(*) FILTER (WHERE tenant_id IN ('<A>', '<B>')) = 2`. (For mcp_clients per F3, the FILTER is `tenant_id IN ('<A>', '<B>') OR tenant_id IS NULL` — but counting NULLs requires `count(*) FILTER (WHERE tenant_id IN ('<A>', '<B>') OR tenant_id IS NULL) = 3`.)

### F5 [Major]: Transaction-model justification text is inaccurate (conclusion correct)
- **File**: plan:194 (Risk #6)
- **Evidence**: Plan says "Each `DO $$` block is itself a transaction (PL/pgSQL function call)". Technically false — `DO` runs in the calling transaction; it does not create a subtransaction. The correct mechanism: psql autocommits each top-level statement; `DO $$ … END $$` is one top-level statement, so it gets its own implicit txn, so `SET LOCAL` is reset between top-level statements.
- **Problem**: A future maintainer wrapping the file in `BEGIN…COMMIT` (or invoking psql with `--single-transaction`) silently turns Block 2/3/4's `SET LOCAL` from per-block to file-wide — Block 4's `app.bypass_rls = 'on'` would leak into a subsequent assertion in the same session, false-greening predicate regressions.
- **Fix**: (1) Restate Risk #6 with correct mechanism. (2) Forbid `BEGIN…COMMIT` and `--single-transaction` wrapping at the top of the file with a `-- DO NOT WRAP IN TRANSACTION` comment. (3) Add defensive guards at the start of each block: `ASSERT current_setting('app.bypass_rls', true) IN ('', NULL)` before Block 2/3, and `ASSERT current_setting('app.tenant_id', true) = '<A>'` after each `SET LOCAL` to verify the GUC is actually what we think it is. (See also S1 — same finding routed via Security.)

### F6 / T4 [Major]: Failure-mode attribution conflated; coverage `≥1 exists` weaker than verify `=1`
- **File**: plan:130-132, :241-246, :76-77
- **Evidence**: Coverage check uses `WHERE tenant_id = '<A>'` and asserts existence (≥1); verify asserts `count = 1`. If seed accidentally inserts 2 rows for tenant A, coverage passes, verify fails with policy-bug-shaped message ("expected 1 got 2").
- **Problem**: Asymmetric assertions create an ambiguity zone where seed bugs present as policy bugs, eroding trust in the gate.
- **Fix**: (1) Strengthen coverage to `ASSERT n = 1` (exactly one). (2) ASSERT messages embed expected/actual + cause hint: `format('table=%I block=verify tenant=%s expected=1 got=%s — likely cause: policy bug (cross-tenant leak) — coverage already confirmed exactly 1 row in DB', t, '<A>', n)`.

### F7 [Major]: Per-table seed cost understated; Scenario 1 overstates simplicity
- **File**: plan:116-117, :128, :211-220
- **Evidence**: FK chains 3-5 deep. `team_password_favorites` requires `users → tenants → teams → team_members → team_password_entries → team_password_favorites`. `mcp_refresh_tokens` requires `mcp_clients → mcp_access_tokens`. Scenario 1 says "developer adds two INSERT lines"; actual is dependency-ordered inserts across multiple file sections.
- **Fix**: Update Scenario 1 to enumerate (1) dependency-ordered INSERTs, possibly across sections; (2) bump floor; (3) verify locally. Re-estimate runtime as <2 min for ~55 tables × 4 query passes (still well within the 10-min job timeout).

### F8 [Major]: Tables with `tenant_id` column but missing policy are silently excluded
- **File**: plan:50-66 (discovery intersection)
- **Evidence**: Plan punts the "column exists but policy missing" invariant to `check-migration-drift.mjs` (separate job). If that check is skipped or its job fails, this runtime check still reports green.
- **Problem**: Defense-in-depth gap; violates "loud failure mode" within this CI step.
- **Fix**: Add a Block 1 assertion: `(SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id' AND table_name <> 'tenants') = (count of discovered tables)`. Failure message names which side is short and which table is missing.

### F9 [Major]: Block 1 role-flag checks miss `session_user` vs `current_user`
- **File**: plan:75, :135
- **Evidence**: Plan asserts `current_user = 'passwd_app'`, `NOT rolsuper`, `NOT rolbypassrls`. Does not check `session_user` or `current_setting('is_superuser')`.
- **Problem**: A misconfigured invocation that runs `psql … as superuser …` then `SET ROLE passwd_app` would pass the existing checks but the privilege evaluation may differ in subtle ways.
- **Fix**: Add `ASSERT session_user = current_user, 'session_user must equal current_user (no SET ROLE expected)'` and `ASSERT current_setting('is_superuser') = 'off'`.

### F10 [Minor]: ID assignment scheme for child rows unspecified (PK collision risk)
- **Fix**: State explicitly: child rows use `gen_random_uuid()`; only tenant rows themselves use deterministic UUIDs (`…000A0` / `…000B0`).

### F11 [Minor]: USING == WITH CHECK symmetry has no automated guard (see also S2 Major)
- **Fix**: Add runtime check: `ASSERT NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND policyname ~ 'tenant_isolation' AND COALESCE(qual::text, '') != COALESCE(with_check::text, ''))`. Failure message names the asymmetric policy.

### F12 [Minor]: Risk #5 reasoning about `current_setting('app.tenant_id')` comparison incorrect
- **Evidence**: `tenant_id::uuid = ''::text` raises `invalid input syntax for type uuid` (an error), not silently false. NULL → `uuid = NULL` → NULL → falsy in USING.
- **Fix**: Restate Risk #5: when unset, returns NULL → falsy. Setting to `''` raises an error — do NOT use `SET app.tenant_id = ''`; either leave unset or use a valid UUID.

### F13 [Minor]: Discovery brittleness on schema/column-name conventions
- **Fix**: Add comment in SQL file: convention is `public` schema + `tenant_id` column; drift = silent exclusion. The discovery query is in lockstep with `check-migration-drift.mjs`.

### F14 [Minor]: SQL-injection safety of `format('%I', t)` not documented in SQL
- **Fix**: Add comment near `EXECUTE format()` explaining `%I` is the safe identifier-quoting specifier; table names from `information_schema` / `pg_policies` are trusted system catalog data; never widen to `%s` or to user input.

### F15 [Minor]: Plan does not state rename-handling
- **Fix**: One-line note in "How auto-discovery handles drift": "Renames are auto-handled — `information_schema` and `pg_policies` reflect post-rename state. The alias map in `check-migration-drift.mjs` is needed only for static migration-text analysis, not at runtime."

## Security Findings

### S1 [Major]: `SET LOCAL` semantics — risk if file is wrapped in transaction
- **File**: plan:78, :138, :194 (Risk #6)
- **Evidence**: Same as F5. Plan's reason ("DO is a transaction") is wrong; the correct guarantee is "psql autocommits each top-level statement → each DO is its own implicit transaction". Wrapping in BEGIN/COMMIT would let `SET LOCAL` from one block leak into others.
- **Attack vector**: future maintainer (not malicious) wraps in transaction → SET LOCAL `app.bypass_rls=on` from Block 4 leaks into next Block 2/3 invocation in the same session → predicate regression false-greens → reaches production.
- **Fix**: See F5. Use `SET app.tenant_id = ...` + explicit `RESET app.tenant_id` / `RESET app.bypass_rls` at end of every block. Add defensive guards.

### S2 [Major]: USING != WITH CHECK divergence is unguarded
- **File**: plan:39, :177 (Out of scope §3)
- **Evidence**: Plan exempts mutation tests on the assumption that the project's `tenant_isolation` template uses identical USING and WITH CHECK clauses. No automated check enforces this.
- **Attack vector**: developer typo (asymmetric clauses, e.g., `USING (tenant_id = ...)` + `WITH CHECK (true)`) → tenant A's app can INSERT rows with `tenant_id = '<B>'` (cross-tenant write). SELECT-only test passes.
- **Fix**: Promote F11 from Minor to Major. Add the `qual::text != with_check::text` runtime guard. Failure message: "Policy <name>: USING and WITH CHECK clauses differ — add INSERT/UPDATE/DELETE assertions to rls-cross-tenant-verify.sql or normalise the policy".

### S3 [Major]: Floor `>= 23` does not catch silent policy removal
- **File**: plan:79, :139, :184
- **Evidence**: A future migration that drops `foo_tenant_isolation` and adds a new tenant-scoped table would keep count constant; floor passes.
- **Attack vector**: developer | `DROP POLICY foo_tenant_isolation` (intentional refactor that misses replacement, OR ALTER TABLE recreate that forgets the policy) | `passwd_app` queries `foo` — if FORCE RLS still on, default-deny (functional break, caught by app tests); if FORCE was also dropped, all rows visible (silent confidentiality breach).
- **Fix**: Augment with a "policies must not silently shrink" check. Either: (a) commit `scripts/rls-policy-manifest.txt` (one line per `<table>:<policy>` pair) and diff-check in CI, OR (b) require the floor to **equal** (not `>=`) the manifest count, OR (c) extend `check-migration-drift.mjs` to verify both `tenant_id` column AND `*_tenant_isolation` policy exist for every model. Recommend (c) — minimal new infrastructure.

### S4 [Minor]: Bypass-channel test codifies `count = 2 when bypass = on` — locks in soft GUC
- **File**: plan:78, :138, :246
- **Evidence**: `app.bypass_rls` is a custom GUC; Postgres allows any role to SET it. NOBYPASSRLS attribute is independent. SQL injection on a `passwd_app` session can `SET app.bypass_rls = 'on'` and defeat RLS entirely.
- **Fix**: Add a comment to the verify SQL: `-- NOTE: app.bypass_rls is a soft GUC — any SQL-level access to passwd_app session can defeat it. RLS is one layer; do not rely on it as the sole tenant boundary.` Out of scope for this plan to harden the GUC; in scope to document.

### S5 [Minor]: Floor-bump in same PR has no two-step approval
- **File**: plan:79, :184, :220 (Scenario 1)
- **Evidence**: Decrementing the floor in the same PR that removes a policy is one integer change; CI green.
- **Fix**: Either (a) derive floor dynamically (cannot be wrongly bumped), OR (b) add `scripts/rls-cross-tenant-*.sql` to `.github/CODEOWNERS` requiring a security-team reviewer. Plan recommends (a).

### S6 [Minor]: SQL injection — `format('%I', t)` is safe; document for completeness
- **Evidence**: `passwd_app` lacks `CREATE` on schema public (`ci.yml:437`); `t` comes from system catalog. No injection.
- **Fix**: Add defensive `ASSERT t ~ '^[a-z_][a-z0-9_]*$'` belt-and-suspenders.

### S7 [Minor — R34]: Existing `rls-smoke-seed.sql` covers only 7 of ~52 tables (adjacent gap)
- **Evidence**: `scripts/rls-smoke-seed.sql:30-57` seeds 7 tables; `rls-smoke-verify.sql:18-33` asserts on those 7. Pre-existing narrow scope.
- **Fix**: As part of this plan, decide between: (a) replacing `rls-smoke-verify.sql`'s static list with an auto-discovered loop asserting `count = 0` for all `_tenant_isolation` tables when no GUC is set; OR (b) explicitly state in the plan that the new cross-tenant verify supersedes the existing without-GUC verify and decide whether to extend or retire the existing files. Plan currently says "existing files NOT modified" — re-examine.

### S8 [Minor — RS4]: PII in committed artifacts — clean.

## Testing Findings

### T1 [Critical]: EXPECTED_MIN_TENANT_SCOPED_TABLES = 23 vs ~52 actual — duplicate of F1
- Merged with F1 above; preserved here for severity tracking.

### T2 [Critical]: `LIKE '%_tenant_isolation'` excludes `team_policies` bare-named policy — duplicate of F2
- Merged with F2 above; preserved here for severity tracking.

### T3 [Major]: Negative-case validation manual-only; no automated regression test for the gate's own correctness
- **File**: plan:154-163
- **Evidence**: 4 negative cases (USING true / wrong column / dropped bypass / seed gap) listed as a manual ritual. No CI step exercises the failure path of the new test. A future refactor of `rls-cross-tenant-verify.sql` (e.g., changing `ASSERT count = 1` to `>= 1` to accommodate a "shared" tenant) would silently turn the gate into a vacuous pass.
- **Fix**: Add a fourth step to the rls-smoke job: `Cross-tenant verify negative test`. The step (1) creates a temporary `CREATE OR REPLACE POLICY foo_tenant_isolation ON <one_table> USING (true) WITH CHECK (true)`; (2) runs `rls-cross-tenant-verify.sql`; (3) `expect exit != 0`; (4) restores the original policy. Sequencing note (T10 from Functionality): cross-session SAVEPOINTs do not work; the bad policy must be created in a real transaction and explicitly dropped/restored after, with a `trap` to ensure restoration even if verify-step fails for another reason.

### T4 [Major]: count = 1 conflates seed bugs with policy bugs — duplicate of F6
- Merged with F6 above; preserved here for severity tracking.

### T5 [Major]: Block 4 with `app.tenant_id` still set is redundant with Blocks 2/3
- **File**: plan:78, :138
- **Evidence**: With current OR-template `(bypass=on OR tenant_id=GUC)`, both clauses can be simultaneously satisfied. Block 4 cannot distinguish "bypass clause works" from "tenant filter happens to pass too". A future migration changing OR to AND would already be detected by Blocks 2/3.
- **Fix**: Block 4 must `RESET app.tenant_id` first (or `SET LOCAL app.tenant_id = ''` — but per F12, that errors on UUID cast → use `RESET`). Then `SET LOCAL app.bypass_rls = 'on'`. With tenant filter explicitly disabled, count = 2 proves the bypass clause alone admits both rows.

### T6 [Major]: Manual-test.md file promised but not delivered with plan
- **File**: plan:167
- **Evidence**: Plan references `docs/archive/review/verify-rls-predicate-manual-test.md` but file does not exist. The manual-test list in the plan body lacks expected outputs, exact connection strings for both roles, and how to confirm an adversarial run failed correctly.
- **Fix**: Inline the full manual-test content in the plan with explicit expected outputs and exit codes. (Or commit `verify-rls-predicate-manual-test.md` alongside the plan; recommend inlining since it's small.)

### T7 [Minor]: No SQL syntax check at PR-review time
- **Fix**: Optional. Defer.

### T8 [Minor]: Path-filter / branch-protection coverage not audited
- **File**: plan:104-110
- **Evidence**: `rls-smoke` job has `if: needs.changes.outputs.app == 'true' || ci == 'true'`. Plan doesn't audit whether `changes` filter covers `prisma/migrations/**` and the new SQL paths.
- **Fix**: Add to "CI integration" section: "Path filter `needs.changes.outputs.app` must include `prisma/migrations/**` and `scripts/rls-cross-tenant-*.sql`. Required-status checks (branch protection) must include `rls-smoke`. Verified at implementation time."

### T9 [Minor]: Coverage check failure-attribution adequate IF T4/F6 is adopted
- No separate fix.

### T10 [Adjacent — Functionality]: Negative-test SAVEPOINT crosses session boundaries
- **Note**: T3's fix proposal needs adjustment. `passwd_user` (creates bad policy) and `passwd_app` (runs verify) are separate connections — SAVEPOINTs do not span them. The negative test must DROP/CREATE the policy in committed transactions, then explicitly restore the original definition after, using a `trap` or `EXIT` handler.
- **Routing**: Functionality refinement to T3.

### RT2 caveat: ASSERT halts on first failure
- **Evidence**: PL/pgSQL `ASSERT` aborts the block on first failure. If 5 tables are broken, only the first is reported.
- **Fix**: Acceptable (consistent with existing rls-smoke-verify). Document in plan: "ASSERT halts on first failure; debug locally to find all broken tables".

## Adjacent Findings (routed)

- F16 → Testing (covered by T3)
- F17 → Security (covered by S2)
- S9 → Functionality (covered by F1)
- S10 → Testing (covered by T3)
- T10 → Functionality (refinement to T3, see above)

## Quality Warnings

None — Ollama merge unavailable; manual dedup performed. No findings flagged for VAGUE / NO-EVIDENCE / UNTESTED-CLAIM by orchestrator review.

## Recurring Issue Check

### Functionality expert
- R1 N/A
- R2 HIT — `EXPECTED_MIN_TENANT_SCOPED_TABLES` hardcoded and wrong (F1)
- R3 HIT — undercoverage of ~30 tables (F1); bare policy excluded (F2)
- R4 N/A
- R5 HIT (minor) — transaction reasoning inaccurate (F5)
- R6 N/A
- R7 HIT — silent exclusion via LIKE pattern (F2); silent exclusion of column-without-policy (F8)
- R8 HIT — nullable mcp_clients tenantId (F3); negative tests not committed (F16/T3)
- R9-R13 N/A
- R14 OK
- R15 OK
- R16 HIT (minor) — local-runbook missing `passwd_app` role creation
- R17-R28 N/A
- R29 N/A
- R30 HIT — schema-drift gaps (F2)
- R31 N/A
- R32 OK
- R33 N/A
- R34 OK
- R35 HIT (minor) — manual-test.md not delivered (T6)
- R36 N/A

### Security expert
- R1-R28 N/A
- R29 N/A
- R31 N/A
- R32 OK
- R33 N/A
- R34 HIT — existing rls-smoke-verify.sql narrow scope (S7)
- R36 N/A
- RS1 N/A
- RS2 N/A
- RS3 OK — `format('%I', …)` is safe given current grants (S6)
- RS4 OK — no PII (S8)

### Testing expert
- R1 HIT — "23" floor SSoT violation (T1)
- R2-R31 N/A or related to other findings
- R32 PARTIAL — strong RLS layer test, but does NOT exercise application's runtime path that sets `app.tenant_id` via Prisma client wrapper. Plan should state this.
- R33 see T8
- R34 N/A
- R35 HIT — manual-test.md not delivered (T6)
- R36 N/A
- RT1 N/A — no mocks
- RT2 OK — all assertions achievable in psql + DO; ASSERT halts on first failure (caveat noted)
- RT3 see T1 — derive dynamically to avoid 3-place SSoT
