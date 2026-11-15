# Plan: rls-refusal-metric (#1048)

Branch: `feat/rls-refusal-metric` (worktree `passwd-sso-1048`, database `passwd_sso_wt_1048`, enforce mode).
Review record: `rls-refusal-metric-review.md` (finding IDs cited below).

## Project context

- Type: `mixed` (web app + workers + Terraform)
- Test infrastructure: `unit + integration` (+ CI/CD; real-DB integration suite; mocked `terraform test` only)
- Verification environment constraints:
  - **V1** — No real AWS: no `terraform plan/apply`, no `aws` CLI. Filter matching is verified offline against `infra/terraform/monitoring.tf` with `TerraformConfig` (`src/__tests__/helpers/hcl-subset.ts`) and `matchesFilterPattern` (`src/__tests__/helpers/cloudwatch-filter-pattern.ts`). The per-log-group production canary is `blocked-deferred` to #921's attestation checklist (SC2): it needs the deployed services; the offline test proves each sink's line matches the filter and that the filter iterates the five-group map.
  - **V2** — Integration DB is the worktree's own enforcing `passwd_sso_wt_1048`. Workers are not run as processes; their pools come from the same factory (C4).

## Objective

On an **enforcing** database, `RlsBypassNotGranted` counts a refused bypass even when the WARNING that precedes the refusal never reaches the client — under a role-, database- or session-level `client_min_messages = error` — and even when the caller swallows the 42501.

**What it does not change (F-01/S1).** In report mode — #921's pre-flip observation window, and any database un-flipped by the emergency lever — no exception is raised, so the WARNING remains the only signal and a raised `client_min_messages` still silences it. The grant audit's refusal of such a setting and #921's detection precondition stay in force for those states.

## Why the issue's proposal is not sufficient

#1048 proposes a filter on error lines whose `errorLogFields` code is `42501`. A swallowed refusal logs no error line, and `{name, code}` cannot tell a bypass refusal from a plain `permission denied`. The ErrorResponse itself always reaches the client (`client_min_messages` tops out at `error`, and a statement-ending error is always sent), so the count is taken on the connection in `src/lib/db/pool-factory.ts`, before any caller can swallow it. Verified by execution against `passwd_sso_wt_1048` (review: functionality and security probes): under `client_min_messages=error` the notice is suppressed and the ErrorResponse arrives as `{code:"42501", message:"RLS_BYPASS_NOT_GRANTED: <table>", hint:"bypass purpose <purpose>", where:"PL/pgSQL function public.rls_bypass_admits(text) line 21 at RAISE"}`; the WARNING's `where` is the same frame at line 19.

## Technical approach

- pg 8.23.1 `Connection` emits `errorMessage` for each ErrorResponse (`node_modules/pg/lib/connection.js:139-143`), including extended-protocol queries; `client.connection` exists from construction. The factory adds its listener with `prependListener` so it runs before pg's own handler on both the `createClient` and pool paths (S4); the rejection settles in a microtask, so the sink records before any caller's catch.
- Same metric, same alarm (`RlsBypassNotGranted`, `Sum >= 1`). One refusal produces a warning line and a refusal line when both reach the client; the metric already counts lines, not statements.
- No SQL, no migration.

## Contracts

### C1 — Refusal listener, shared source predicate

- `export function handleServerError(msg: { code?: string; message?: string; hint?: string; where?: string }): void` in `src/lib/db/pool-factory.ts`.
- **One source predicate for both listeners (S2, R48).** `bypassAdmitsFrame(where): "exact" | "mentioned" | "none"` — `exact` when the first line of `where` (innermost frame) contains `public.rls_bypass_admits(text)`; `mentioned` when `where` contains `rls_bypass_admits` anywhere, the first line included, and the verdict is not `exact` (N-02); otherwise `none`. A comment beside it records that the qualified spelling depends on the function's `SET search_path = pg_catalog, pg_temp`: if that is ever dropped, real reports become `mentioned` → unparsed → alarm, never silent. `handleServerNotice` switches to it.
- Refusal accepted only when: `code === "42501"` AND frame `exact` AND `message` matches `^RLS_BYPASS_NOT_GRANTED: ([a-z0-9_]{1,63})$` AND `hint` matches `^bypass purpose ([a-z0-9_-]{1,64}|<invalid>)$` → sink `{ kind: "refusal", table, purpose }`.
- `42501` with frame `exact` or `mentioned` but any other field not matching → the existing `rls.bypass_notice_unparsed` line (shared slot, no content), so drift alarms rather than reads as zero. Same rule for the notice listener with `01000`.
- Anything else → dropped; no part logged.
- Never throws into pg: field reads are typed, regexes anchored, and the sink call is wrapped in try/catch in both listeners (F-03). A sink failure is not a silent zero (R2-S1, N-03): the catch writes the fixed content-free line `{"_logType":"rls.bypass_notice_unparsed"}` to stderr inside its own nested try, behind the shared unparsed rate-limit slot (R3-S2), so the existing unparsed filter counts it.
- **Fails closed when pg's listener API is missing (F-02, S3, R2-S2).** `assertListenerSupport()` runs on every `createPool` / `createClient` call until it has passed once (only success is memoized; a failed probe throws on every call): it constructs an unconnected `new pg.Client()` and throws unless `connection.prependListener` is a function. `checkedConfig` refuses a `Client` or `native` override, so the probed class is the class the pool and `createClient` instantiate; no per-instance check follows (T2-3). The probe does not prove pg still emits `errorMessage`; event-name drift is caught by A5 in CI, not at runtime. A test seam `resetListenerSupportProbe()` sits beside `resetBypassNoticeRateLimit()`.
- Control class: **detection or audit only** (the database's 42501 is the denial). Adjudication authority: the backend's ErrorResponse fields as parsed by pg-protocol. Code that can issue arbitrary SQL can forge a report (a quoted `pg_temp` function name) or swallow one (`DO … EXCEPTION`), as the report-mode migration already states; that class is out of scope.
- Known gaps: (a) a refusal caught inside SQL by a handler that does not re-raise. Member set from the live catalog: `SELECT n.nspname, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.prosrc ~* 'EXCEPTION\s+WHEN' AND n.nspname NOT IN ('pg_catalog','information_schema')` — today `tenant_claim_events_purge_for_tenant` and `share_creator_admitted`, both `EXCEPTION WHEN OTHERS THEN RAISE;` (S6). (b) Connections outside the factory (C4).

### C2 — One sink, two kinds

- `BYPASS_REPORT_KIND = { WARNING: "warning", REFUSAL: "refusal" } as const`; `BypassNotice` gains `kind`. The notice listener emits `warning`.
- `productionBypassNoticeSink`: warning → `_logType: "rls.bypass_not_granted"` (unchanged); refusal → `logger.warn({ _logType: "rls.bypass_refused", table, purpose }, "rls.bypass_refused")`. Rate limit keyed per (kind, table, purpose), per process, per minute.
- `stderrBypassNoticeSink`: same `_logType` mapping.
- One registration covers both kinds. Registrants: `git grep -l "registerBypassNoticeSink(" -- src scripts` (10 files incl. the factory and two unit tests). Production/script registrants all use the stderr sink and need no call change.
- Consumers: CloudWatch filter reads `_logType`; the operator reads `table`, `purpose`; the integration sink reads `kind`, `table`, `purpose`.
- Test fixtures this contract and C1 change (R19, F-02, N-01, T2-4, T2-5):
  - Exact-shape sink assertions gain `kind`: `src/lib/db/pool-factory.test.ts`, `src/__tests__/lib/prisma.test.ts`.
  - Unqualified `where` fixtures move to the qualified frame (`git grep -n "rls_bypass_admits(text)" -- src scripts | grep -v "public\.rls_bypass_admits"`): `pool-factory.test.ts`, `pool-factory.metric-filter.test.ts`, `src/__tests__/lib/prisma.test.ts`. The unqualified form survives only as the A1 drift cell. The ja fixture is constructed from PostgreSQL's message catalog (`PL/pgSQL関数public.rls_bypass_admits(text)の19行目 - RAISE`); the worktree server has no translations installed, so it is not an observed string.
  - Connect fixtures handing the pool `connect` handler a bare `EventEmitter` (`pool-factory.test.ts`, `src/__tests__/lib/prisma.test.ts`) pass a real unconnected `pg.Client`, or, where `pg` is mocked, `Object.assign(new EventEmitter(), { connection: new EventEmitter() })`.
  - The three `vi.mock("pg")` suites (`src/__tests__/lib/prisma.test.ts`, `src/lib/prisma.test.ts`, `src/workers/audit-outbox-worker.test.ts`) gain a `Client` on the export the factory reads (`default` where the mock is default-shaped).

### C3 — Integration suite counts refusals

- `bypass-notice-sink.ts`: warnings to the existing buffer as `{ table, purpose }` (kind stripped; existing `notices` assertions unchanged), refusals to `bypassRefusalBuffer()`. `failOnReports` moves into this module (unit-testable) and fails on untaken refusals as well; its message names both helpers.
- `expectBypassRefusal(fn, { counted = true } = {})` also drains refusals and returns them; with `counted` it throws unless a refusal for the parsed `table` was recorded; with `counted: false` it throws unless none was (for connections deliberately outside the factory — T-F1: `rls-bypass-grants.integration.test.ts` raw-pool cell).
- New `expectSwallowedBypassRefusal(fn)` → `{ warnings, refusals }` for code that catches the refusal itself (F-04). Contract: `fn` must resolve (the helper throws if it rejects) and at least one refusal must be recorded (T2-6).

### C4 — Process coverage (member set)

- Factory users: `git grep -lE "\bcreate(Pool|Client)\(" -- src scripts ':!**/__tests__/**' ':!**/*.test.*'` → app (`src/lib/prisma.ts`), `audit-outbox-worker`, `retention-gc-worker/index.ts`, `audit-anchor-publisher`, `scripts/audit-chain-verify-worker.ts`, and four operator scripts (`tenant-domain.ts`, `migrate-account-tokens-to-encrypted.ts`, `migrate-webhook-secrets-v1-to-v2.ts`, `manual-tests/mcp-replay-audit-verification.ts`).
- Alarmed: the five services, one log group each in `local.rls_bypass_report_log_groups`. The four operator scripts write to the operator's stderr only; not alarmed (S5).
- Outside the factory, repo-wide: `git grep -nE "new (pg\.)?(Pool|Client)\(" -- ':!**/__tests__/**' ':!**/*.test.*' ':!node_modules'` minus the factory → `scripts/audit-db-grants.mjs`, `scripts/bootstrap-rds-roles.mjs`, `scripts/rls-enforce-preflight.mjs`, `scripts/pre-pr.sh`, `prisma/seed.ts`, `e2e/helpers/db.ts`, `load-test/setup/seed-load-test-users.mjs`. None sets `app.bypass_rls` (re-check with `git grep -n bypass_rls -- <files>` in Phase 2).
- psql runbooks that open a bypass as an app role (`git grep -ln "app.bypass_rls" -- docs/operations`): interactive, the refusal is on the operator's terminal; documented exception (F-07).

### C5 — Terraform filter and docs

- `aws_cloudwatch_log_metric_filter.rls_bypass_refused`: `for_each = var.enable_monitoring ? local.rls_bypass_report_log_groups : {}`, name `${local.name_prefix}-rls-bypass-refused-${each.key}`, pattern `{ $._logType = "rls.bypass_refused" }`, metric `RlsBypassNotGranted` / `${local.name_prefix}/App`, value `1`, default `0`. Alarm description names all three `_logType`s; the locals comment says what each filter counts.
- Docs: `docs/operations/alerts.md` (new `## rls.bypass_refused`; "only trace" sentence; un-flip sentence qualified by `client_min_messages`; unparsed paragraph covers refusals and names a throwing log sink as the other cause (R3-S1); Datadog query; "both filters" → three), `docs/operations/deployment.md` (Enforcing-mode paragraph, lines on `client_min_messages` hiding reports scoped to report mode, checklist "both metric filters" → three, canary also checks `rls.bypass_refused`, an enforcing-only `SET client_min_messages = error` canary), `docs/security/security-review.md`, `docs/security/tenant-boundary-matrix.md`, `docs/security/threat-model.md` where they say the WARNING is what makes a caught refusal visible (F-05).
- Forbidden patterns:
  - `pattern: errorLogFields\(.*42501` — reason: the count must not depend on a caller logging the error.
  - `pattern: \.on\("errorMessage"` in `src/lib/db/pool-factory.ts` — reason: must be `prependListener` (S4).

## Acceptance criteria

- **A1 (C1, unit)**: exact fields → one refusal; `<invalid>` purpose, localized `where` first line, 63-char table and 64-char purpose → accepted. 64-char table, 65-char purpose, suffix after table, prefix before `RLS_BYPASS_NOT_GRANTED`, prefix before `bypass purpose`, newline in hint, missing hint → one unparsed line, content not logged. Look-alike: exact message+hint with `where` from another function → nothing, `logger.warn` not called (T-F2). Outer-frame mention (`…\nSQL statement "… rls_bypass_admits …"`) → unparsed, not a refusal (S2). Unqualified innermost frame (`PL/pgSQL function rls_bypass_admits(text) line 21 at RAISE`) with 42501, and with 01000 → one unparsed line each, paired with the qualified frame counting (N-02, R2-S3). Plain `permission denied` 42501 → nothing, `logger.warn` not called. `code` `P0001` with otherwise exact fields → nothing. `{}` → no throw, nothing. Throwing sink → no throw out of the listener and exactly one fixed unparsed line on stderr; two failures in one window → one line, a later window → a second; working sink → no such line.
- **A2 (C1, unit, real pg, unconnected clients)**: emitting the refusal ErrorResponse on `createClient(...).connection` reaches the sink. Pool path (T2-1): a throwing `errorMessage` listener is added to a real unconnected `pg.Client`'s `connection` (standing in for the handler pg adds in `_connect`), the client is handed to the factory pool's `connect`, and the refusal is emitted inside try/catch → the sink still recorded it; the same cell without the throwing listener → exactly one refusal. No listener-identity or order assertion.
- **A3 (C2, unit)**: production sink writes `rls.bypass_refused` / `rls.bypass_not_granted` by kind; warning then refusal for one (table, purpose) → two lines; a second identical refusal within the window → still one; stderr sink mirrors.
- **A4 (C5, unit)**: the production and stderr sinks' refusal lines each match the `rls_bypass_refused` pattern read via `TerraformConfig`, judged by `matchesFilterPattern`; a line with another `_logType` does not; the filter publishes to the alarm's metric/namespace and iterates `local.rls_bypass_report_log_groups` (pinned to five by the existing test).
- **A5 (C1+C3, integration)**: read a baseline `SHOW client_min_messages` on the checked-out client, then `BEGIN`, `SET LOCAL client_min_messages = error`, `SHOW` = `error`, open a bypass whose grant omits a table holding a row, on one client checked out of a `createPool` pool with explicit `BEGIN` … `ROLLBACK` (no Prisma commit semantics on an aborted transaction), run as the last statement before `ROLLBACK` a statement in a catch that asserts SQLSTATE 42501 then swallows, so `fn` resolves → via `expectSwallowedBypassRefusal`: warnings `[]`, refusals `[{table, purpose}]`; after `ROLLBACK`, `SHOW client_min_messages` on the same checked-out client, before release, equals the baseline (the `LOCAL` did not leak; N3-02, R3-1). The look-alike `DO` cell first asserts the caught error is SQLSTATE 42501 with the exact `RLS_BYPASS_NOT_GRANTED: <table>` message (R3-4). Negative and look-alike cells drain both buffers explicitly around `fn` through the `bypass-notice-sink.ts` accessors and assert both empty (N3-03); the paired default-setting cell is their positive control. Paired cell at default setting → one warning and one refusal. Look-alike `DO` block raising the exact message/hint as `passwd_app` → nothing counted. Negative: precondition `has_table_privilege('passwd_app','tenant_claim_events','SELECT') = false`, `SELECT` caught with SQLSTATE 42501 → both buffers empty. A test comment records that a session/`LOCAL` value stands in for role/database level (same GUC, applied when each message is sent).
- **A6 (C3)**: full integration suite green with refusal draining; helper self-tests: a raw-pool refusal makes `expectBypassRefusal` throw "no refusal counted"; `{ counted: false }` passes on it; `expectSwallowedBypassRefusal` throws when `fn` rejects, and throws when `fn` resolves after a granted, non-refused statement (R3-2); `failOnReports` unit cells for both buffers.
- **A7 (C1 fail-closed)**, in its own file with `vi.resetModules()` + `vi.doMock("pg", …)` + dynamic import per cell: with a pg whose `Client` lacks `connection`, `createPool` and `createClient` throw, and a second `createPool` call throws again; real pg → both succeed, and a spied `Client` constructor shows the probe ran once across two `createPool` calls (`createClient` constructs `Client` itself, so it is not counted; R3-3); `checkedConfig` refuses `Client`/`native`. The three `vi.mock("pg")` suites import cleanly.
- **A8 (T-F9)**: `operator-scripts-rds-shaped.integration.test.ts` asserts `not.toMatch(/"_logType":"rls\.bypass_(not_granted|refused|notice_unparsed)"/)`.
- **A9 red-proofs**, one mutation each, naming the assertion it reddens; source mutations on scratch copies of the module under the scratch-vitest-alias method: drop `code` check (A1 P0001 cell); drop `exact`-frame check (A1 look-alike + A5 look-alike); drop `^` / `$` on the message regex (A1 prefix / suffix cells); same for the hint regex; drop hint check (A1 missing-hint cell); restrict `mentioned` to lines after the first (A1 unqualified-frame cells); remove the catch's fixed line (A1 throwing-sink cell); drop the fallback's rate-limit gate (A1 two-failures cell); `SET client_min_messages = error` moved before `BEGIN` in A5, a setting that survives the rollback (A5 post-ROLLBACK baseline check; see deviation D1); drop the ≥1-refusal check in `expectSwallowedBypassRefusal` (A6 granted-statement self-test); key rate limit without kind (A3 two-lines cell); skip rate limit on refusals (A3 repeat cell); drop `createClient` attach (A2); drop pool attach, and `prependListener` → `.on` on the pool path (A2 pool cell with the throwing listener); remove the probe (A7 `createPool` throw cell); memoize before probing (A7 throws-twice cell); probe a property pg lacks (A7 real-pg allow cell); drop refusal arm of `failOnReports` (A6); drop `counted` check (A6 self-test); delete the TF resource / change its `for_each` (A4). A8: the mutated script (narrowed grant) lives in a git-ignored path inside the repo, selected through `redProofOverride` (refused under CI); the red run must show `"_logType":"rls.bypass_refused"` on stderr, not an import error (T2-8).

## Testing strategy

Unit: `src/lib/db/pool-factory.test.ts`, `pool-factory.metric-filter.test.ts`, the three `vi.mock("pg")` suites, a `bypass-notice-sink` unit test. Integration: new `src/__tests__/db-integration/rls-bypass-refusal-count.integration.test.ts`, helper self-tests in `bypass-refusal-helper.integration.test.ts`. Gates: `npx vitest run`, `npm run test:integration`, `npx next build`, `terraform fmt -check` + mocked `terraform test`.

## Considerations & constraints

### Scope contract

- **SC1** — Detecting a raised `client_min_messages` between deploys stays a #921 precondition for report-mode windows; this PR covers enforcing mode only. Owner: #921.
- **SC2** — Production canary per log group (V1). Owner: #921 checklist.
- **SC3** — Arbitrary-SQL forgery/swallow (C1). Owner: none; same out-of-scope statement as the report-mode migration.

### User operation scenarios

- Enforcing; operator sets `ALTER ROLE passwd_app SET client_min_messages = error`; a SCIM path whose grant misses a table is refused and the route swallows it → `rls.bypass_refused` in the app group → alarm.
- The audit-chain-verify worker (stderr sink) is refused → stderr JSON `rls.bypass_refused` in its group → alarm.
- Grant fault (`permission denied`) anywhere → no RLS line.
- Un-flipped (report mode) with the same role setting → nothing counts; the grant audit refuses the setting on the next deploy (unchanged).

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | Refusal listener, shared source predicate, lazy fail-closed probe | locked |
| C2 | One sink, two kinds; `rls.bypass_refused` | locked |
| C3 | Integration suite counts refusals; helpers | locked |
| C4 | Process coverage member set | locked |
| C5 | Terraform filter + docs | locked |
