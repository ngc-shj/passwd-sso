# Plan: bypass-model-grants-and-nesting-fail-closed

Closes #909 and #910. Implements #911 in report mode; the enforce flip, together with every test that only enforcement needs, is SC5 (user decision after round 3).

## Project context

- **Type:** web app (Next.js 16 + Prisma 7 + PostgreSQL 16, FORCE RLS), plus the outbox, retention-GC and anchor-publisher workers and the operator scripts.
- **Test infrastructure:** unit, integration (real Postgres, `ci-integration.yml`), E2E and CI/CD (`rls-smoke`, `rls-gate-fixtures`).
- **Verification environment constraints:**
  - **E1:** the dev workers share the dev DB. Integration tests refuse to run while they are up. Nothing in this PR commits a mode change.
  - **E2:** rollback paths cannot be exercised locally. Report mode makes every path admit-only.
    - Stand-in: an old-code cell, run with no listener, asserts admission (verifiable-CI).
  - **E3:** on RDS the table owner is NOSUPERUSER/NOBYPASSRLS. Operator scripts and SECURITY DEFINER bodies therefore report there.
    - Report mode is admit-only, so no RDS-specific test is needed in this PR. Their enforce-mode cells are SC5's.
  - **E4:** the `e2e` job runs as superuser, so E2E is not evidence. Integration as `passwd_app` is.
  - **E5:** RDS server logs are not exported (`infra/terraform/database.tf`), so production observation goes through the app log pipeline (C7).
    - Verifiable-CI: the notice reaches the structured log line, and that line matches the metric filter pattern.
    - Deploy-time: the filters exist in the log groups (Terraform).

## Objective

1. **#911.** The database reports, without refusing, every bypassed statement that examines a row of an RLS table outside its grant. Every production writer of the bypass GUCs declares its tables through one helper. The application logs each report so it can be measured.
2. **#909/#910.** A transaction in which a nested RLS context was refused does not commit, even when the refusal was caught.

## Requirements

- **R1.** Report mode: such statements succeed. Each policy expression that examines a row of an ungranted table raises a `WARNING rls_bypass_not_granted table=<t> purpose=<p>`. None is raised when no row is examined.
  - Tests assert presence per (table, purpose), never counts.
- **R2.** No other server message reaches application logs. The pools run at the default `client_min_messages`, and the listener drops anything that does not match exactly.
- **R3.** Every production path that turns bypass on goes through `setBypassGucs`. Every read of the bypass GUCs goes through `readBypassState`.
- **R4.** The transaction holding a refused nested context rolls back.
  - Stated limits:
    - detached work after the outer callback resolved;
    - a caught outer call.
  - Both are still logged.
- **R5.** No new soundness G rules.
- **R6.** Bypass scans and lookups do not regress (D3).

## Design decisions

- **D1. Rollout (user decision).**
  - This PR ships report mode: admission plus a WARNING.
  - SC5 replaces `public.rls_bypass_enforced()` once the SC5 preconditions hold.
  - The mode is DDL owned by the migration role. App roles cannot change it: they have no CREATE on `public`, and policies bind by OID (probed).
  - A replacement takes effect for prepared plans (probed).
- **D2. Grants.**
  - A grant is a named `{ purpose, models }`.
  - Call sites share a grant only when their sets are equal.
  - Grants replace `ALLOWED_USAGE`'s model lists and `ALLOWED_VIA`.
- **D3. Predicate form (probed, 1,000,000 rows).**
  - The old predicate scans in 62.8 ms.
  - A bare per-row call takes 616 ms.
  - `(SELECT public.rls_bypass_admits('t'))`, `PARALLEL SAFE`, takes 45.8 ms as an InitPlan and is required.
- **D4. Reporting channel.**
  - `RAISE WARNING` reaches clients at the default `client_min_messages=notice` and the server log at `log_min_messages=warning`.
  - No pool option is needed, so LOG traffic (statement text, bind parameters, auto_explain) never reaches the app (S3-1, RP3-4).
  - The WARNING channel can still be suppressed by a URL `options=`, `PGOPTIONS` or a role-level `client_min_messages` above `warning`.
    - `createPool` rejects a config whose `options`, connection-string `options`, or `PGOPTIONS` names `client_min_messages`. It has a unit test and a mutation row (R5-M3).
    - SC5's per-group canary detects the role-level case (S4-3).
  - The database adjudicates: the WARNING names table and purpose. That covers trigger bodies, SECURITY DEFINER bodies and every connection with a listener.

## Contracts

### C1. Database functions and policies

- **`public.rls_bypass_enforced() RETURNS boolean`:**
  - `LANGUAGE sql IMMUTABLE PARALLEL SAFE`;
  - `false`. Only SC5 changes it.
- **`public.rls_bypass_admits(table_name text) RETURNS boolean`:**
  - `LANGUAGE plpgsql STABLE PARALLEL SAFE`, `SET search_path = pg_catalog, pg_temp`;
  - not SECURITY DEFINER, not LEAKPROOF;
  - the call is schema-qualified.
  - **Bypass off:** `false`.
  - **Granted:** `table_name = ANY(string_to_array(current_setting('app.bypass_tables', true), ','))` gives `true`. The match is exact, untrimmed elements.
  - **Otherwise:**
    - purpose is printed as `left(p,64)` if it matches `^[a-z0-9_-]+$`, else `<invalid>`;
    - `RAISE WARNING 'rls_bypass_not_granted table=% purpose=%'`;
    - then, if `public.rls_bypass_enforced()`, raise `42501` with message `RLS_BYPASS_NOT_GRANTED: <table>` and a HINT naming the purpose. The WARNING is emitted first, so a refusal stays observable after SC5 (RP3-6). If not enforced, return `true`.
- **Privileges** (every step names both functions, S4-1):
  - `REVOKE ALL … FROM PUBLIC` on both functions.
  - `GRANT EXECUTE` to `passwd_app`, `passwd_outbox_worker`, `passwd_retention_gc_worker`, `passwd_anchor_publisher` and `passwd_dcr_cleanup_worker`, granted in two places:
    - in the migration (`IF EXISTS`);
    - in every role-creation path that can run after migrating:
      - `ci-integration.yml`'s bootstrap step (which runs after `migrate deploy`, RP3-1);
      - `bootstrap-rds-roles.mjs`, guarded per function by `to_regprocedure(...) IS NOT NULL` so re-runs converge;
      - initdb runs before migrations and is covered by the migration.
  - The integration `setup.ts` asserts `has_function_privilege(<role>, …, 'EXECUTE')` for both functions and each role it connects as. A missing grant on `rls_bypass_enforced()` would turn report mode into a refusal (probed, S4-1).
  - `db-grants-manifest.json` is regenerated.
- **Policies:**
  - All 57 policies (`pg_policies WHERE schemaname='public'`, `system_settings_bypass` included) put `(SELECT public.rls_bypass_admits('<own table>'))` in place of the bypass branch in USING and WITH CHECK.
  - The migration generates the statements from the catalog. It then asserts that every policy names its own table in both expressions and that none still contains `app.bypass_rls`.
- **Invariant:** a bypassed statement that raised no WARNING reached rows only of granted RLS tables. Exceptions:
  - FK actions of granted writes (probed);
  - definer bodies owned by an RLS-exempt role (dev only).
- **Control class:** detection only in this PR. It guards against code that does not write the bypass GUCs. It is not a boundary against code that can issue SQL (in-band `set_config`, probed).
  - Non-RLS tables are out of scope.
  - Rejected alternative: a login role per grant.
- **Adjudication authority:** the PostgreSQL policy evaluator.

### C2. Grant registry, writer, reader

- **`src/lib/tenant-rls-grants.ts`** (not re-exported from `tenant-rls.ts`) exports:
  - `BYPASS_GRANT` and `BypassGrant`;
  - `MODEL_TABLE`, a literal map, unit-tested against `Prisma.dmmf`;
  - `setBypassGucs(tx, grant, { tenantId? })`, which sets four transaction-local GUCs, `app.bypass_tables` `,`-joined with no spaces;
  - `setLockTimeout(tx, ms: number)` (S3-5);
  - `readBypassState(tx)`. Its member set comes from `grep -rn "current_setting('app\.bypass_" src scripts`:
    - `audit-outbox-in-tx.ts:35`
    - `audit-outbox.ts:59`
    - `sweep.ts:129,192`
    - `audit-outbox-worker.ts:93`
    - `assert-bypass-rls-active.ts:45`
- **`withBypassRls(prisma, fn, grant, options?)`** replaces `purpose`. A wrapper that forwards a grant takes a `BypassGrant` parameter.
- **`withTenantRls`** pins `app.bypass_rls='off'` and `app.bypass_tables=''`.
- **Member set:** 226 calls (`grep -rn '\bwithBypassRls(' src scripts --include='*.ts' --include='*.tsx' | grep -v '\.test\.\|__tests__/'` returns 229 lines, minus 3 comments).
- **Grant sources:**
  - the gate's reach;
  - raw SQL in the reached code;
  - invoker trigger bodies on granted tables;
  - `audit_logs` for the definer callers;
  - WARNINGs observed in tests (C7).

### C3. Self-setting paths

- **Grants per transaction function,** with pure grant functions exported:
  - **`enqueueAudit*`:** `audit_outbox`, `tenants`.
  - **Outbox drain:** `audit_outbox`, `audit_logs`, `audit_chain_anchors`, `audit_deliveries`, `audit_delivery_targets`, `webhook_deliveries`, `tenants`.
  - **Delivery batch:** `audit_deliveries`, `audit_delivery_targets`, `audit_outbox`, `audit_logs`.
  - **Webhook delivery:** `webhook_deliveries`, `team_webhooks`, `tenant_webhooks`, `audit_outbox`, `audit_logs`.
  - **Separate grants:** the reapers, the retention purge, the error recorders, the direct audit write and the depth read.
  - **Anchor publisher:** `system_settings`, `audit_chain_anchors`, `tenants`, with `tenantId: SYSTEM_TENANT_ID`.
  - **Retention GC:** `grantForEntry(entry)`, plus the `access_requests` expiry and the heartbeat.
  - **Operator scripts:** `tenant-domain.ts` and both `migrate-*` scripts take grants.
  - **`scripts/manual-tests/mcp-replay-audit-verification.ts`:** moves to `setBypassGucs` (S3-6).

### C4. Static gate

- **Check 3:**
  - per-call reach against the call's grant;
  - forwarded grants are charged at production callers;
  - `ALLOWED_USAGE` becomes a file allowlist only;
  - `ALLOWED_VIA` folds into grants;
  - `ALLOWED_PURPOSES` is derived.
- **Writer rule:** a SQL lexer runs over raw-SQL string and template arguments, with literal concatenation constant-folded. Outside `tenant-rls.ts` and `tenant-rls-grants.ts`, it fails the run on:
  - a statement-leading `SET`, `RESET` or `ALTER … SET`;
  - a `DO` block;
  - `EXECUTE`;
  - any `set_config` identifier token, whether plain, quoted, `pg_catalog.`-qualified or `U&`.

  This is a writer check against honest code. Runtime-built SQL is outside its reach (S3-4).
- **Pool rule:** `new pg.Pool`, `new Pool`, `new pg.Client`, `new Client` and `new PrismaPg` are allowed only in `src/lib/db/pool-factory.ts`.
  - The member set is derived by AST over `src`, `scripts` and `src/__tests__/db-integration` (F1/T4-1).
  - The factory also exports `createClient`.
  - `scripts/audit-chain-verify-worker.ts` moves to `createPool`.
  - Allowlist (R5-M2). Each entry marks a superuser or no-bypass site, in place, with a reason:
    - `bootstrap-rds-roles.mjs` and `audit-db-grants.mjs` (S4-4);
    - the `setup.ts` probe client;
    - the superuser clients in `bootstrap-rds-roles.integration.test.ts` and `audit-db-grants.integration.test.ts`;
    - the old-code cell's listener-less pool.
  - The no-bypass `passwd_app` clients in `tenant-claim.integration.test.ts` use `createClient`.
- **Function rule:** no raw-SQL argument or file outside `prisma/migrations` contains a `CREATE [OR REPLACE] FUNCTION|PROCEDURE` token sequence. This covers the mode functions (RP3-9), and also function-level `SET app.…` clauses and `$$`-quoted `set_config` bodies, which the writer rule cannot see (S4-2).
  - File scope: `src`, `scripts` and `.github`.
  - Allowlist (R5-M2): the negative-test SECURITY DEFINER probe (`rls-cross-tenant-negative-test.sh` Case 9) and gate fixture strings under `scripts/__tests__`.
- **Follow-ups:** `check-rls-read-context.mjs` and `RAW_BYPASS_GUC_RE` follow the helpers.
- **Fixtures:**
  - the real grants module and a `dmmf` stub;
  - every grant spelling;
  - every writer spelling (S3-4's list), plus a function with a `SET` clause;
  - the pool and function rules;
  - a real-repo cell asserting every grant is named.
- **Control class:** fail-closed verification gate (development aid).

### C5. A refused nested context fails its transaction

- **Mechanism:**
  - `TenantRlsContext.refusedNesting` is set by `assertNoActiveRlsContext`.
  - `withTenantRls` and `withBypassRls` check it after `fn(tx)` resolves, inside the transaction, and throw `INVALID_RLS_NESTING: a nested RLS context was refused inside this <helper>`.
  - An error thrown by `fn` itself takes precedence.
- **State-tightening member set** (derived from the schema):
  - writes to the token, credential and lockout models: `Session`, `ExtensionToken`, `ApiKey`, `McpAccessToken`, `McpRefreshToken`, `DelegationSession`, `OperatorToken`, `ServiceAccountToken`, `WebAuthnCredential`, `VerificationToken`, and the `User` lockout fields;
  - `enqueueAuditInTx` and `logAuditInTx`.

  Each call site inside an RLS callback is listed in the review, with an assertion that it runs no nested-capable best-effort side effect.
- **Control class:** enforceable for nesting started before the outer callback resolves; detection only for the R4 limits.

### C6. Tests and CI

- **Unit:**
  - `MODEL_TABLE` against `dmmf`;
  - `setBypassGucs` (four GUCs, `tenantId`, no spaces);
  - `setLockTimeout`;
  - `readBypassState`;
  - `withBypassRls` with a grant;
  - `withTenantRls` pinning;
  - the C5 mock;
  - the listener:
    - accepts only `severity==='WARNING'`, a `where` containing `rls_bypass_admits`, and a full-line match of `^rls_bypass_not_granted table=([a-z0-9_]{1,63}) purpose=([a-z0-9_-]{1,64}|<invalid>)$`;
    - when `where` matches but the line does not, logs the constant `_logType: "rls.bypass_notice_unparsed"` with no content (S4-4);
    - a synthetic statement or parameter notice carrying a secret causes zero logger calls;
    - the rate-limit map is bounded.
- **Integration, as `passwd_app` / worker roles, with `assertRlsApplies`:**
  - **Positive controls (T3-1, T4-1, T4-2).** An ungranted read of a seeded row produces a WARNING in the test sink when made through:
    - a `createPool` pool (the factory);
    - `ctx.app.prisma`, now built by `createPrismaForRole` via the factory (the `tenant-claim` probe pools likewise);
    - `@/lib/prisma` (the singleton).

    Per-worker attach points are covered by the AST pool rule, not by cells. No integration cell connects under a `setup.ts`-guarded `application_name`.
  - **Purpose sanitisation in the DB (T3-8, F3/T4-5).** A single-table point read with one InitPlan. "Exactly one record" is the deliberate count exception: it proves there is no forged second record.
    - a newline-forged purpose yields `purpose=<invalid>`;
    - a 200-character valid purpose yields its 64-character prefix;
    - a 200-character purpose with an invalid character yields `<invalid>`.
  - **Old-code cell:** a pool without the listener, bypass on, `app.bypass_tables` unset, is admitted (E2).
  - **Exact-membership cells:** `delegation_sessions` does not admit `sessions`; `service_accounts` does not admit `accounts`.
  - **No-row cell:** an ungranted point lookup with no match returns empty and raises no WARNING.
  - **C5:**
    - the four outer/inner combinations, each asserting that the row `fn` wrote is absent after the rejection (RT8);
    - the `fn`-throws precedence;
    - no flag leak to a sibling transaction;
    - the detached limit (the outer commits);
    - side-effect rows at caught sites.
  - **E5 cell (T4-7):** the production sink drives a captured pino stream. The raw line holds exactly one `"_logType"` and matches the filter pattern parsed from `monitoring.tf`. The test also asserts one filter per log group (app, outbox worker, retention GC), each bound to its own `log_group_name`.
  - **Sink-routing units (T4-4):**
    - with nothing registered, `getLogger().warn` receives `_logType: "rls.bypass_not_granted"`;
    - the script entry routes to stderr.
- **The whole existing integration suite as report-mode evidence:**
  - the C7 test sink fails `afterEach` on any unexpected WARNING;
  - deliberate cells drain through `expectBypassNotices(fn)`;
  - a file-level `afterAll` backstop catches late, detached notices (T3-14);
  - this is the "WARNINGs observed in tests" grant source.
- **rls-smoke:**
  - **Block 1:** catalog `[E-RLS-BYPASS-TABLE]`. Every policy's `polqual` and `polwithcheck` call `public.rls_bypass_admits('<own relname>')` in a sub-SELECT, and none contains `app.bypass_rls`.
  - **Block 4:** sets `app.bypass_tables` to every discovered table and expects no WARNING (psql stderr).
  - **New report block, placed after Block 4:**
    - leaving one table out yields its WARNING;
    - `system_settings` is seeded in the rls-smoke seed, with `count(*) > 0` asserted first (T3-11);
    - an EXPLAIN JSON check shows an InitPlan and no per-row SubPlan.
  - **`RESET app.bypass_tables`** goes in Block 5.
  - **WARNING runner (T4-3).** psql exits 0 on WARNING, so blocks emit `\warn` markers. One wrapper, `scripts/rls-verify-run.sh`, captures stderr and asserts the WARNING set per block: none in Block 4, exactly the left-out table in the report block. All three runners use it: `ci.yml`, `pre-pr.sh` and `rls-cross-tenant-negative-test.sh`.
  - **`pre-pr-rls-whitelist.test.mjs`** is updated (T3-17).
  - **`rls-cross-tenant-negative-test.sh`:**
    - `CANONICAL_POLICY_SQL` and Case 2 move to the new form;
    - mutations (wrong literal, old `COALESCE`, bare call) each expect `[E-RLS-BYPASS-TABLE]`;
    - the existing cases keep their own codes (R5-M1):
      - Case 1 carries `(SELECT public.rls_bypass_admits('rls_negative_test')) OR true`;
      - Case 4 carries `… AND false`;
      - the new assertion runs after `[E-RLS-NULL]` and `[E-RLS-SYM]` in Block 1, so `[E-RLS-COUNT-A]` and Block 4's `[E-RLS-BYPASS]` keep a mutation that reaches them.
- **Existing tests updated,** member sets by command:
  - `grep -rln "bypass_rls\|bypass_purpose\|setBypassRlsGucs\|BYPASS_PURPOSE" src scripts --include='*.test.*'`
  - `grep -rln "set_config('app.bypass_rls'\|SET LOCAL app.bypass_rls" src/__tests__/db-integration`
  - `retention-gc-tx-fakes.ts`
  - the outbox worker fake
  - the mock `Pool` classes (`src/lib/prisma.test.ts`, `src/__tests__/lib/prisma.test.ts`, `audit-outbox-worker.test.ts`), which now accept `on('connect')`.
- **Helpers:** take a grant.
- **CI:**
  - the ci-integration bootstrap step grants EXECUTE;
  - path filters gain `src/lib/tenant-rls-grants.ts` and `src/lib/db/pool-factory.ts`.

### C7. Notice capture

- **`src/lib/db/pool-factory.ts`:**
  - `createPool(config)` builds every pool, and `createPrismaClient(pool, logOptions)` builds every Prisma client.
  - The factory attaches a `notice` listener on `connect`.
  - The listener resolves the sink at notice time from a process-level registry (`registerBypassNoticeSink`, RP3-3/T3-1). The registry defaults to the production sink, and tests override it (T4-4).
- **Production sink:** `getLogger().warn({ _logType: "rls.bypass_not_granted", table, purpose })`.
  - It is rate-limited per (table, purpose) per process, and the map is bounded.
  - Script entries register a stderr sink.
- **Test sink:**
  - `setup.ts` registers it before any pool exists;
  - it buffers per test and is never rate-limited;
  - it carries the test id;
  - it never throws into production code.
- **Metric filters:** `monitoring.tf` gains one metric filter per log group, `{ $._logType = "rls.bypass_not_granted" }`, for app, outbox worker and retention GC (T3-6). The anchor publisher has no log group, and that gap is listed for SC5.

### C8. Documentation, deploy note, issues

- **Doc lines to rewrite:**
  - `security-review.md:261,296`
  - `tenant-boundary-matrix.md:101-103`
  - `threat-model.md:93,95`
  - the `check-bypass-rls` header
  - the `tenant-rls.ts` docblocks
- **What they say:**
  - in this release, ungranted bypass reach to rows of RLS tables is reported and admitted;
  - the report is logged per (table, purpose) per process per rate window;
  - refusal starts at SC5;
  - C1's escapes;
  - C5's scope and limits.
- **Deploy note:**
  - C5 ships enforcing (F2). Before release, query production logs for `rls.nesting_refused` over a window, and list each (opening, active) pair with the site that produces it. If that cannot be done, state that C5 is accepted unobserved.
  - Report mode is admit-only on every rollback path.
  - After a code-only rollback, old code has no listener. Reports then reach only the RDS server log, which is not exported, and are unrated.
- **Issues:**
  - #910 and #909 close, with the limits stated.
  - #911 stays open.
  - New issues: SC2, SC5 (with its preconditions), SC6, SC7, SC8.

## Testing strategy

C6. Mutations; each needs a green base first, and each must turn its named test red:

| Contract | Mutation | Red test |
|---|---|---|
| C1 | wrong table literal | `[E-RLS-BYPASS-TABLE]` (negative-test) |
| C1 | old `COALESCE` branch | `[E-RLS-BYPASS-TABLE]` (negative-test) |
| C1 | bare call (no sub-SELECT) | `[E-RLS-BYPASS-TABLE]` (negative-test) |
| C1 | WARNING removed | the positive-control cells |
| C6 | Block 4 omits a table from `app.bypass_tables` | `rls-verify-run.sh` (Block 4 expects none) |
| C6 | the wrapper's stderr check removed | the report block (expects its WARNING) |
| C1 | sanitisation regex loosened | the forged-purpose cell |
| C2 | `MODEL_TABLE` drops a table | unit vs `dmmf` |
| C2/C3 | a grant drops a table that a suite test reads | `afterEach` sink |
| C4 | a model removed from a grant | `rls-gate-fixtures` |
| C4 | a `set_config` outside the allowlist | writer fixture |
| C4 | a pool built outside the factory | pool fixture |
| C5 | the post-`fn` check removed | four-combination cell |
| C7 | the listener not attached in the factory | factory and `ctx.app` positive controls |
| C7 | `createPrismaForRole` reverts to `new pg.Pool` | pool-rule fixture and the `ctx.app` positive control |
| C7 | a worker builds its pool outside the factory | pool-rule fixture |
| C7 | the registry default becomes a no-op | sink-routing unit |
| C7 | `createPool` stops rejecting `client_min_messages` | the `createPool` options unit |
| C7 | the listener accepts any notice | the synthetic-secret unit test |

## Considerations & constraints

- **Risk:** a missing grant on a path no test drives, or whose rows did not exist, is invisible until production reports it. SC5 does not flip until production reports are zero over a window and the SC5 preconditions hold.

### Scope contract

- **SC1.** The `enforce_tenant_id_from_context` trigger keeps its `bypass_rls` short-circuit.
- **SC2.** The SECURITY DEFINER audit functions do not check context. Follow-up issue.
- **SC3.** Orphaned blobs.
- **SC4.** Static-gate soundness work (R5).
- **SC5.** The enforce flip and everything only it needs. Follow-up issue. Its preconditions:
  - **CI enforce pass:**
    - an explicit `RLS_PASS=report|enforce` selector, refused unless `rls_bypass_enforced()` matches;
    - a single flip script on ephemeral databases, guarded by a `COMMENT ON DATABASE` marker;
    - the shipped-false assertion.
  - **Positive per-grant evidence records:** purpose, `current_user`, role attributes.
  - **A scratch-DB procedure:**
    - every `*_DATABASE_URL` exported;
    - refuse to start when `.env.local` overrides any of them;
    - a marker guard on the flip and on `dropdb --force`.
  - **A seed-all-RLS-tables fixture** derived from `pg_policies`.
  - **Per-table refusal cells.**
  - **tenant-domain and migrate-script cells** under an injected NOBYPASSRLS role, each paired with an allow cell.
  - **The definer cell** under a NOBYPASSRLS owner.
  - **The `invalidateUserSessions` enforce cell,** plus error-level logging at best-effort revocation catches.
  - **A positive canary per log group** observed before the zero window starts. The anchor publisher gets a log group.
  - **Production and its rollback target** at or above this release.
  - **The OR-arm order question** (T3-19).
- **SC6.** `tenants` has no RLS. Follow-up issue.
- **SC7.** `pg_db_role_setting` is not audited. Follow-up issue.
- **SC8.** The existing `monitoring.tf` filters match `$._logType = "app"`, which the logger no longer emits. Follow-up issue: an adjacent, pre-existing defect.

## User operation scenarios

- **Every authenticated request:** `getSessionAndUser` is covered by the suite, and any WARNING fails it.
- **Sign-in:** adapter methods and the `audit_logs` definer path.
- **Lockout:** a C5 state-tightening member.
- **Notification and webhook dispatch:** detached, the R4 limit.
- **Workers and operator scripts:** per-function grants. Reports come through the factory's listener.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | Report-mode functions, privileges, policies | locked |
| C2 | Grant registry, writer, reader, pins | locked |
| C3 | Self-setting paths' grants | locked |
| C4 | Gate: per-call grants, writer/pool/function rules | locked |
| C5 | Refused nesting fails its transaction | locked |
| C6 | Tests and CI (report mode) | locked |
| C7 | Notice capture: pool factory, sinks, metric filters | locked |
| C8 | Docs, deploy note, issues | locked |
