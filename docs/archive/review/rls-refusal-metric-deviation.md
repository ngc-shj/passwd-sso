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

## Red-proof record (A9)
All mutations were applied to scratch copies under the session scratchpad and run through a scratch vitest config (`mergeConfig` over the repo's unit or integration config, `root` = repo, `resolve.alias` pointing the module at the mutated copy, test paths on the CLI). The unmutated copy through the same config ran green first: unit 110 tests exit 0, integration 18 tests exit 0. Each row below exited 1 unless stated.

| Mutation | Cell(s) that went red |
|---|---|
| drop the `code` check | A1 P0001 cell; "no SQLSTATE" cell |
| force `exact` (drop the exact-frame check) | A1 outer-frame cell; A1 unqualified-frame cell |
| delete the frame gate in `handleServerError` (`exact` forced, `none` not returned) | A5 look-alike "does not count a look-alike raised from another function" (integration) |
| message regex without `^` / without `$` | A1 "text before the message" / 64-char table, text after table, newline after table |
| hint regex without `^` / without `$` | A1 "text before the hint" / 65-char purpose, newline in hint, trailing newline |
| drop the hint check | A1 missing-hint cell (+13 others) |
| `mentioned` only after the first line | A1 unqualified-frame cells, refusal and warning |
| remove the catch's fixed stderr line | A1 throwing sink (refusal listener), throwing sink (notice listener), two-failures-in-a-window |
| drop the fallback's rate-limit gate | A1 two failures in one window / later window |
| rate-limit key without kind | A3 warning then refusal → two lines |
| skip the rate limit on refusals | A3 repeated refusal → one line |
| drop the `createClient` attach | A2 single-client ErrorResponse |
| drop the pool attach | A2 both pool refusal cells; pooled-notice cell |
| `prependListener` → `.on` on the pool path | A2 pool cell with the preceding throwing listener |
| remove the probe from `createPool` | A7 createPool throws; probe-runs-once; throws-twice |
| memoize before probing | A7 "throws again on a second createPool call" |
| probe a property pg lacks | A7 real-pg allow cell (and every cell that builds a pool or client) |
| drop the refusal arm of `failOnReports` | unit "throws, naming both refusal helpers"; integration "failOnReports fails on a refusal no cell took" |
| drop the `counted` check in `expectBypassRefusal` | A6 "throws when the refusal was not counted, on a connection outside pool-factory" |
| drop the ≥1-refusal check in `expectSwallowedBypassRefusal` | A6 "throws when the statement resolves after a granted statement" |
| `SET` before `BEGIN` in A5 (D1) | A5 post-ROLLBACK baseline check ("expected 'error' to be 'notice'") |
| delete the `rls_bypass_refused` TF resource (scratch copy of monitoring.tf) | A4 file errors at describe time ("no resource …") |
| change the resource's `for_each` | A4 "iterates the five service log groups" |
| A8 stderr: script swallowing a refusal (D4) | A8 `not.toMatch` assertion |

Not reddened by the mutation the plan named: forcing `exact` does not affect the A1 other-function look-alike cell, because a `where` that names no `rls_bypass_admits` is dropped before the exact check; that cell guards the `none` branch, which the "delete the frame gate" row reddens at integration level.

## D7 — Step 2-5 self-check: unparsed path guarded too (R3/R49, Major)
`logUnparsed()` called the logger unguarded, and with `handleServerError` now prepended ahead of pg's own `errorMessage` handler, a logger that throws on an unparsed refusal would have escaped into pg's parser callback — C1's "never throws into pg" covered only the sink call. Both writes now share one guarded path: a failing logger write falls back to the fixed stderr line (`writeUnparsedToStderr`), itself guarded. New cells "a logger that throws on an unparsed report" (refusal and notice listeners, plus a working-logger allow cell). Red-proof: removing the try/catch in `logUnparsed` on a scratch copy reddens both listener cells (exit 1; unmutated control 3 passed, exit 0).

Other self-check findings fixed: the `POOL_RULE_ALLOWLIST` header now names the listener-less test stand-ins it already exempted (R49/R18, Minor); comments and the gate's error text say "report listeners" rather than "notice listener" (R3, Minor); the red-proof record above was added (RT7).

## D8 — Phase 3 round 1 full-suite run
`npx vitest run` after the round-1 fixes: 24656 passed; failures were the six known `backup-db` Group B cells and two repo-wide scans that timed out under load (`route-policy-manifest` assertion 6 at 11.3 s against a 10 s limit; `check-fail-closed-routes-have-test` real-repo cell at 73 s against 60 s). Neither touches this change's files; run on their own they pass (727 passed, exit 0). Build exit 0.
