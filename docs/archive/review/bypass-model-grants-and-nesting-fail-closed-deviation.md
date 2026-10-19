# Deviation log: bypass-model-grants-and-nesting-fail-closed

Departures from the plan (revision 4.1) made during implementation, and why.

## D1. `readBypassState` returns `null` when no row comes back

- **Plan:** `readBypassState(tx)` returns the four GUCs; it did not say what happens with no row.
- **Implemented:** the return type is `BypassState | null`. Every caller treats `null` as "bypass not active" and denies:
  - `audit-outbox-in-tx.ts`;
  - `audit-outbox.ts`;
  - `audit-outbox-worker.ts` (`assertAuditWriteBypass`);
  - `sweep.ts` (`assertSweepBypass`, `enqueueAuditInWorkerTx`);
  - `assert-bypass-rls-active.ts`.
- **Why:** an early version collapsed "no row" into an object of `null` fields. Some callers compared those fields against an expected value, so they could pass a sweep that expected the bypass off. The `null` return makes the missing row a separate case that the type forces each caller to handle. Pinned by `tenant-rls-grants.test.ts` and `sweep-bypass-assert.test.ts`.

## D2. Detached nested work (R4 limit) is still refused; only the rollback is lost

- **Plan:** detached work that starts after the outer callback resolved is a stated limit: it is not rolled back, and it is logged.
- **Observed:** AsyncLocalStorage carries the outer context into the detached promise. So the detached nested call is still refused (`INVALID_RLS_NESTING: … is forbidden`) and logged. What the limit loses is only the rollback: the outer transaction had already committed.
- **Effect:** the integration cell asserts that the detached call is refused and that the outer write committed. R4's wording ("not rolled back, still logged") holds.

## D3. E5 cell is a unit test, not an integration cell

- **Plan:** the E5 cell drives the production sink into a captured pino stream, and checks the line against the filter pattern parsed from `monitoring.tf`.
- **Implemented:** `src/lib/db/pool-factory.metric-filter.test.ts`. It feeds a server notice through `handleServerNotice` into the real `loggerOptions` pino instance, then checks:
  - `_logType` appears exactly once on the raw line;
  - the parsed `monitoring.tf` filter pattern matches the line;
  - the filter's `for_each` names exactly the app, outbox-worker and retention-GC log groups.
- **Why:** no database is needed for this check, and it is red-proven on scratch copies (pattern renamed; one log group removed).

## D4. Grant derivation used the gate's per-call reach dump

- **Plan:** grants come from the gate's reach, raw SQL, trigger bodies, the `audit_logs` definer callers, and WARNINGs observed in tests.
- **Implemented:** the reach was taken from a scratch copy of `check-bypass-rls.mjs` that dumped per-call reach. The dump showed 221 calls: 67 with a set of reached models, and 15 empty (raw SQL only, so their tables were added by reading the SQL). The scratch gate is not part of the change.
- **Pending:** the "WARNINGs observed in tests" source needs the integration run against the migrated dev database. Any table it reports is added to the grant that reached it.

## D5. Second migration: the tenant branch moves into a sub-SELECT

- **Plan:** C1 rewrites only the bypass branch.
- **Found by the integration run:** the old bypass branch, `COALESCE(current_setting('app.bypass_rls'), '') = 'on'`, let the planner fold the whole `OR` to true when estimating a bypassed statement, so the tenant branch was never evaluated. The new branch is an InitPlan, which the planner cannot fold. So planning now evaluates `current_setting('app.tenant_id', true)::uuid`. On a pooled connection where an earlier transaction set `app.tenant_id`, the GUC has reverted to `''`, and `''::uuid` raises 22P02.
- **Who is affected:** a bypass that sets `app.bypass_rls` without `app.tenant_id`. New code always sets `NIL_UUID` through `setBypassGucs`. The pre-change retention sweep does not, so a code-only rollback would have broken retention GC, and the plan's claim that report mode admits on every rollback path would have been false.
- **Fix:** `20261019000001_rls_tenant_branch_initplan` rewrites the tenant branch of all 56 policies to `tenant_id = (SELECT current_setting('app.tenant_id', true)::uuid)`. An InitPlan is evaluated lazily, so the cast runs only when the bypass branch is false. All four cases keep their previous outcomes:

  | Bypass | `app.tenant_id` | Outcome |
  |---|---|---|
  | on | `''` | admitted |
  | off | `''` | 22P02, the loud missing-context failure that `health.ts` classifies |
  | off | a tenant | that tenant's rows |
  | off | NIL | no rows |

  Plans are unchanged: the old shape was also a filter, not an index condition. `current_setting` is now evaluated once per statement instead of once per row.
- **Rejected alternative:** `NULLIF(current_setting(...), '')::uuid`. It turns the loud missing-context error into a silent empty result, which existing code and tests rely on not happening.
- **Guards:**
  - `rls-cross-tenant-verify.sql` Block 1 `[E-RLS-TENANT-INITPLAN]`, with negative case 13;
  - the integration cell "admits a bypass without app.tenant_id on a connection where an earlier transaction set it";
  - the 7 retention-GC least-privilege cells, which failed with 22P02 before the fix.

## D6. A report depends on the plan, not on whether a row matches

- **Plan:** R1 says no WARNING is raised when no row is examined. The test plan's "no-row cell" used an ungranted point lookup with no match.
- **Observed:** RLS quals run before the query's own filter (security barrier). Under a seq scan, the policy runs on every row the scan reads, so a lookup that matches nothing still reports the table. A pk index scan that finds nothing does not. Whether a statement reports is therefore plan-dependent.
- **Changed:** the cell now uses a statement that scans nothing (`WHERE false`). A second cell forces a seq scan and asserts that a lookup with no match does report.
- **For SC5:** in enforce mode, an ungranted lookup can be refused or not depending on the plan, even when it would return nothing. The enforce evidence cannot rely on "this path never matches a row of table T". Every table a path's statements can scan must be in its grant.

## D7. The static gate follows Prisma relations (user decision, 2026-10-20)

- **Plan:** no static relation traversal. Grants missing a table would come from the WARNINGs observed in tests.
- **Observed:** the integration run reported grants missing tables that are reached only through relations: nested `select`/`include`, relation filters in `where`, nested writes. Adding those tables to their grants then failed the gate's stale-model check, because the gate could not see them reached.
- **Decision (user):** the gate follows relations. The walker in `check-required-user-relation.mjs` is generalised into a shared lib, and `check-bypass-rls` Check 3 counts relation-reached models as reach. A call with an argument the walker cannot read is undecidable for staleness, like raw SQL.
- **Effect:** relation paths no test exercises are also checked in CI, and the stale-model check stays accurate. The test-time WARNINGs remain a second, DB-adjudicated source.
