# Coding Deviation Log: rls-refusal-metric

## D1 — A9 row for the A5 baseline check reworded
The plan's mutation "`SET LOCAL` → `SET`" cannot redden the post-ROLLBACK baseline check: a plain `SET` issued inside the transaction is also undone by `ROLLBACK`, so the baseline holds either way (observed: exit 0). The mutation the check exists for is a setting that outlives the transaction; `SET client_min_messages = error` moved before `BEGIN` reddens it ("expected 'error' to be 'notice'", exit 1). Plan row updated.

## D2 — `team-member-key-prune.integration.test.ts` refusal cell takes `{ counted: false }`
Discovered when the full integration suite ran with C3's counted-refusal check: the cell's connection is a raw `pg.Client` with its own notice listener, outside pool-factory, so no refusal is counted. This is the C3 raw-connection case (like the `rls-bypass-grants` cell T-F1 named); the plan's member set for it missed this second instance. Applied `{ counted: false }` with a comment.

## D3 — Extra integration cell for `failOnReports`'s refusal arm
A6 planned unit cells for `failOnReports`; an integration cell ("failOnReports fails on a refusal no cell took, and drains it") was added as well, so the refusal arm is also proven against the real sink.

## D4 — A8 red-proof needed a second mutant to isolate the `not.toMatch` line
The first mutant (grant narrowed to `user`) made the script exit non-zero, so the cell went red before the stderr assertion ran. A second mutant keeps the script's own work intact and adds one bypass that reaches `users` outside the grant and swallows the 42501 (relative imports rewritten to absolute paths so the copy loads from a git-ignored path). With it the script succeeds and the cell fails on the assertion itself: `expected '…' not to match /"_logType":"rls\.bypass_(not_granted|…/`, stderr carrying `{"_logType":"rls.bypass_refused","table":"users","purpose":"system_maintenance"}` (exit 1; unmutated control exit 0). Both mutants deleted.

## D5 — Integration-suite failures outside this change
`npm run test:integration` on the worktree database reports failures in `retire-dcr-cleanup-worker`, `revoke-public-connect`, `audit-db-grants` (`passwd_dcr_cleanup_worker` still holds CONNECT on `passwd_sso_wt_1048`) and `bootstrap-rds-roles` (no compose `db` service for this worktree). The same four files fail on origin/main `27968fb28` against the same database (18 failed, verified in a detached checkout), so they are the worktree database's state, not this change. CI runs on a fresh database.

The full unit suite (`npx vitest run`, exit 1) fails only `scripts/__tests__/backup-db.test.mjs` Group B (6 cells, "no pg_restore reachable"): a known limit of running that file from a git worktree, independent of this change. 24648 other tests pass, no unhandled errors.

## D6 — Step 2-5 mechanical hook dispositions
- check-propagation: `expectBypassNotices` / `expectBypassRefusal` signature changes (return type renamed to `BypassReport`, optional second parameter) are source-compatible; every caller typechecks and passes.
- check-hardcoded-reuse: `"_logType"` (JSON key in test assertions) and `"name"` coincide in bytes with `LOGTYPE_PROP` in a lint gate and `AC_NAME` in the extension's form detector; different concepts, not replaced.
- check-orphaned-checks: `src/workers/audit-outbox-worker.test.ts` is a unit test whose name matches the hook's `audit` keyword, not a gate script.
- check-deployment-artifact (R35, Tier-1 for `monitoring.tf`): `rls-refusal-metric-manual-test.md` added.
