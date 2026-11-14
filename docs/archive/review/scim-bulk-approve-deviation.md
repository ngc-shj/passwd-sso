# Coding Deviation Log: scim-bulk-approve

Deviations from `scim-bulk-approve-plan.md` and the measurements the plan asked to be recorded.

## D1 — C6 measurement: the cap stays at 100

Command (worktree database `passwd_sso_wt_1005`, no worker process on it):

```
npx vitest run --config vitest.integration.config.ts --reporter=verbose \
  src/__tests__/db-integration/scim-bulk-approve.integration.test.ts
```

`--reporter=verbose` is needed for the lines to print: the default reporter hides a passing
test's `console.log`. Three runs, each line the max of 5 timed runs after one warm-up:

```
[B7] kind=approve n=100 max_ms=308.1 statements=453 statements_n10=93
[B7] kind=reject n=100 max_ms=285.1 statements=453 statements_n10=93
[B7] kind=approve n=100 max_ms=369.3 statements=453 statements_n10=93
[B7] kind=reject n=100 max_ms=250.4 statements=453 statements_n10=93
[B7] kind=approve n=100 max_ms=332.6 statements=453 statements_n10=93
[B7] kind=reject n=100 max_ms=332.2 statements=453 statements_n10=93
```

- Condition 1 (local max < 1500 ms): worst 369.3 ms.
- Condition 2 (statements × 3 ms < 3000 ms): 453 × 3 = 1359 ms. 3 ms is the plan's assumption
  (VE3); locally the request spent about 0.8 ms per statement (369.3 / 453).
- The count scales with rows: 453 at 100 rows, 93 at 10 — 4 statements per row plus 53 fixed.

## D2 — Red-proofs (scratch copies only)

Method: a mutated copy of one module under the session scratchpad, a scratch vitest config
aliasing the module to the copy, the real test file on the command line. Controls: the
unmutated copy ran green; a copy that throws at entry turned the cells red, so the alias applied.

| Mutation | Cell red | Observed |
|----------|----------|----------|
| drop the approver's `keyDistributed` requirement | B2 | `expected 200 to be 403` |
| drop the role pin and the CAS's `role` term | B1 | stale row `"approved"`, expected `"role_changed"` |
| drop `lockTeamsAgainstRotation` in approve | B4 | `no backend blocked on pid <n> within 10000ms` |
| drop the pre-read's pending filter (bulk-approve route) | B5c | `expected 409 to be 200` |
| advisory-lock order made to differ between the two requests | B6 | `expected 409 to be 200` (deadlock detected) |
| swallow a row's audit failure and continue | B8 | resolved with 200, expected a rejection |

B4 goes red through its parked-waiter proof (without the team lock the bulk request never parks),
not through its final assertions; that is the cell detecting the lock's absence, and the final
state it would otherwise assert is the same with or without the lock.

Batch C's page tests were red-proved the same way (cap removed, tenant-inactive rows included,
retry rebuilt from the current view, the all-`not_found` branch removed: each failed its test).

C8 rehearsal: on a scratch copy carrying `tenant-row-lock.ts` and `prisma/schema.prisma` from
`fix/departed-member-leaked-authority` (`git show HEAD:<path>`), `scim-admission.test.ts` ran 3
failed / 23 passed / 1 skipped without the condition (the three refusal tests: equal, after,
NULL `admittedAt`), and 26 passed / 1 skipped with it. On this branch the signal is absent: the
four `runIf(hasDepartedActorCheck)` tests are skipped and the absence test runs.

## D3 — Implementation choices the plan left open

- The new constants are imported by path (`@/lib/constants/team/scim-admission`), not through
  `src/lib/constants/index.ts`, as the sibling `rotate-key.ts` and `invitation.ts` are.
- Page: the skipped-count toast uses `toast.error` (the page has no warning toast). When nothing
  succeeded and the outcomes are mixed, only the skipped toast is shown — no "0 approved" success
  toast (C5 named the two toasts but not this case).
- Page: the ADMIN line in the approve dialog uses the `text-destructive` theme token.
- B5b also asserts the request waited at least `TEAM_KEY_LOCK_TIMEOUT_MS − 250 ms` before its
  409, to show the 409 is the lock budget and not an earlier refusal.
- B8's control (the same three rows admit once the fault is lifted) shares one test with the
  fault run, since the rows are still pending after the rollback.
- Gate rule 7 also covers the `import x = require()` form and a bare `@/lib/audit` specifier.

## D4 — pre-PR `rls-cross-tenant SQL parse` on the shared dev database

`scripts/pre-pr.sh` runs that step against the shared dev database `passwd_sso` in
`passwd-sso-db-1`, not this worktree's database. It fails there with
`[E-RLS-BYPASS-ROUTINE] share_creator_admitted no longer sets exactly …`. That database carries
the migrations of the unmerged `fix/departed-member-leaked-authority`
(`20261114000000_team_member_admitted_at` … `20261114000300_team_webhook_creator`, listed in its
`_prisma_migrations`), which change that routine; this branch's
`scripts/rls-cross-tenant-verify.sql` is unchanged from `origin/main` and describes the routine
as it is on `main`. The step's inputs are untouched by this branch, and CI runs it against its
own freshly migrated database. Not run to green locally for that reason.

## D5 — `check-bypass-rls` pool rule: one allowlist entry

C6 counts statements with a spy on `pg`'s `Client.prototype.query` in B7. `check-bypass-rls`'s pool
rule refuses any use of the `pg` `Client` binding other than `new` outside the pool factory, so the
full unit suite failed on `check-bypass-rls.test.mjs` ("names every real BYPASS_GRANT member…") with
`Client used other than by new` in the new integration test file. The file is added to
`POOL_RULE_ALLOWLIST` with its reason (it builds no connection), as seven other test files are.
The plan's C7 table did not list this gate.

## D6 — Phase 2 verification

- `npm run lint`: exit 0. `npx next build`: exit 0.
- `npx vitest run` (full): 1165 of 1167 files passed. The two failing files:
  - `scripts/__tests__/check-bypass-rls.test.mjs`, 1 test — D5; passes after the allowlist entry
    (`node scripts/checks/check-bypass-rls.mjs` exit 0; the test re-run alone, exit 0).
  - `scripts/__tests__/backup-db.test.mjs`, 6 tests in "Group B — validation by a real
    pg_restore": the test reaches `pg_restore` through `docker compose exec db`, and from a git
    worktree compose derives another project name and finds no `db` service. The script and the
    test are byte-identical to the primary checkout's (`diff -q`), where the file passes 239/239.
- Integration: `scim-bulk-approve.integration.test.ts` 11/11 (three runs),
  `scim-team-admission-approval.integration.test.ts` 46/46, both against `passwd_sso_wt_1005`.

## D7 — Red-proofs added after the Phase 2 self-check (T1)

The self-check found the plan's gate red-proofs and its "per-row transactions → B8" unrecorded.
Run on scratch copies; the worktree was not touched.

Gate rule 7 (`check-team-rotation-input-lock.mjs`), one mutation of a scratch copy of the gate at
a time, the unchanged self-test file run against it. Control: 87 passed on the real tree and on
the unmutated scratch copy. Every mutation failed a test that names its clause:

| Mutation of the gate | Self-tests that failed |
|----------------------|------------------------|
| V7(b): `@/` specifiers not resolved | "refuses a fifth file importing the module by alias" (+12 using `@/` fixtures) |
| V7(b): relative specifiers not resolved | "…by relative path", "…a relative import that spells the extension", "…a literal require()" (+2) |
| V7(b): `import()` not read | "refuses a literal import() of the module" (+1) |
| V7(b): `export … from` not read | "refuses export * from the module", "…export { … } from…", "…re-export … even from an admission route" |
| V7(b): path compared by substring | "accepts a page importing the near-named constants file" (the allow fixture) |
| V7(c): `lockTenantRows` call check removed | "refuses an admission route calling lockTenantRows" |
| V7(d): routes also allowed `logAuditInTx` | "refuses an admission route importing logAuditInTx…" (+2) |
| V7(d): only `@/lib/audit/audit` judged | "…importing enqueueAudit from audit-outbox", "…enqueueAuditInTx from audit-outbox-in-tx" |
| V7(d): module also allowed `logAuditAsync` | "refuses the module importing logAuditAsync" |
| V7(a): allowlist back on the approve route | "passes the admission module's approve CAS…", "refuses the approve CAS's scimApprovalPending: false in the old home…" |

Per-row transactions: a scratch copy of the bulk-approve route that opens one
`withTeamTenantRls` transaction per target, aliased in for the integration file. Control 11/11.
Mutated: B8 red (`scim_approval_pending: false` where `true` was expected — the rows admitted
before the failing audit call stayed committed), and also B5b (rows committed before the lock
conflict) and B6 (`expected 'settled' to be 'blocked-on-parked'`: with per-row locks the second
request no longer queues behind the first).
