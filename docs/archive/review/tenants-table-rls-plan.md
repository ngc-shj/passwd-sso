# Plan: tenants-table-rls

Issue: #923 (SC6 of `bypass-model-grants-and-nesting-fail-closed-plan.md`).
Decision (user): `tenants` gets a policy — bypass-admits OR `id = app.tenant_id`.

## Project context

- Type: web app + workers + operator scripts (Next.js 16, Prisma 7, PostgreSQL 16).
- Test infrastructure: unit + integration (real Postgres) + E2E + CI/CD.
- Verification environment constraints:
  - **V1** — RDS is not reachable from dev. On RDS the migration/owner role is the master user
    (`rds_superuser`, no BYPASSRLS), so FORCE RLS applies to it there, while in docker/CI the owner
    `passwd_user` is SUPERUSER and ignores RLS. The policy's effect on `passwd_app`,
    `passwd_outbox_worker` and `passwd_retention_gc_worker` (created and asserted NOBYPASSRLS by
    `bootstrap-rds-roles.mjs` and audited by `audit-db-grants.mjs`) is `verifiable-local`. The
    effect on the owner role on RDS is `blocked-deferred`; cost: owner-side reads are operator
    runbook SQL (C7) and future data migrations (SC3).
  - **V2** — Integration tests cannot run while the compose workers run (CLAUDE.md):
    `verifiable-local` after stopping them; `verifiable-CI`.

## Objective

Put `tenants` under the same RLS model as every other tenant-scoped table, so an application query
on `tenants` that did not establish its scope sees no rows, and so a bypass grant naming (or not
naming) `tenant` means something at the database level (#911 report mode, #921 flip).

## Requirements

- R1. `tenants` has ENABLE + FORCE RLS and one policy `tenants_tenant_isolation` whose USING and
  WITH CHECK are `(SELECT public.rls_bypass_admits('tenants')) OR id = (SELECT (current_setting('app.tenant_id', true))::uuid)`.
- R2. Every production path that reads or writes `tenants` keeps its behavior (member set below).
- R3. A `tenants` statement with no bypass and no tenant scope behaves like one on any other RLS
  table: no rows while `app.tenant_id` was never set in the session, 22P02 once it reverted to `''`.
- R4. A bypass whose grant does not name `tenants` is reported (WARNING), not refused, until #921.
- R5. `check-rls-read-context` (a fail-closed gate over its SEARCH_DIRS, with the MISSED shapes its
  header lists) rejects a bare-client `tenants` read, as it does for every other RLS table.

## Member set (R42)

Derived by a read-only audit and re-derived independently by two plan reviewers (no missed member).
Commands (all with `-g '!*.test.ts' -g '!**/__tests__/**'`):

1. `rg -n '\.tenant\.(findUnique|findUniqueOrThrow|findFirst|findFirstOrThrow|findMany|update|updateMany|create|createMany|upsert|delete|deleteMany|count|aggregate|groupBy)\b' src scripts cli extension load-test`
2. `rg -n -U -P '\btenant\s*:\s*(true|\{)' src scripts -g '!scripts/checks/**'` (relation select/include/filter/connect)
3. `rg -n -i -P '(from|join|update|into|delete\s+from)\s+("?public"?\.)?"?tenants"?\b' src scripts cli load-test`
4. Live migration functions whose body mentions `tenants` (latest definition per name, minus dropped).
5. Callers reaching (3)'s caller-dependent member: `rg -n '\blogAuditInTx\(|\benqueueAuditInTx\(' src scripts -g '!scripts/checks/**'`.

Structural result: every model with a `tenant` relation is itself an RLS table (all 55 relation
fields use `fields: [tenantId]`; models outside `rls-cross-tenant-tables.manifest` are
VerificationToken, Tenant, TenantClaimEvent, SystemSetting, none with a Tenant relation). A child row
visible under a tenant scope therefore already has `tenant_id = app.tenant_id`, and under a bypass
`check-bypass-rls` charges relation reach to the grant.

| Site | Today | Verdict | Contract |
|---|---|---|---|
| `sweepTrashEntry` tenant enumeration (`src/workers/retention-gc-worker/sweep.ts`) | bare `workerPrisma.tenant.findMany`, outside `inSweepTx` | BREAKS (trash purge lists 0 tenants) | C2 |
| `runTick` tenant enumeration (`scripts/audit-chain-verify-worker.ts`) | bare `prisma.tenant.findMany` as `passwd_app` | BREAKS (verifier inert, silently) | C3 |
| `enqueueAuditInTx` probe `SELECT EXISTS (SELECT 1 FROM tenants …)` (`src/lib/audit/audit-outbox-in-tx.ts`) | runs in the caller's tx; 8 sites run under grants without `tenant`: AUDIT_WRITE_DIRECT_OUTBOX (share-links ×2, account-lockout ×2), VAULT_RESET_EXECUTE, EMERGENCY_ACCESS_VAULT_READ, TENANT_REALIGN_AFTER_ACTIVATION, TENANT_DOMAIN_BACKFILL_APPLY | NEEDS-GRANT (WARNING now, refusal after #921) | C4 |
| `enqueueAuditBulk` probe, `enqueueAuditInWorkerTx` probe, `checkChainEnabled` | raw SQL under a grant fixed in the same function, naming `tenants` | OK | — |
| `enforce_tenant_id_from_context` users bootstrap branch (`INSERT INTO tenants`) | reached only with no bypass and no `app.tenant_id` | OK, error source moves | C5 |
| Operator runbook SQL on `tenants` (`docs/operations/alerts.md`) | runs as the RDS master user | needs a transaction-scoped tenant scope | C7 |

## Contracts

### C1 — migration: RLS on `tenants`

- New migration: ENABLE + FORCE RLS on `tenants`, policy `tenants_tenant_isolation` per R1, the
  tenant branch in the sub-SELECT form so `[E-RLS-TENANT-INITPLAN]` (verify SQL) holds.
- Invariant: an application query on `tenants` from a NOBYPASSRLS role reaches only the row of the
  tenant its scope helper set, unless it runs under a bypass.
- Control class: **enforceable boundary against application query paths that establish scope only
  through `setTenantGucs` / `setBypassGucs` / `with*Rls`** — a query that forgot its scope sees
  nothing. It is **not** a boundary against code that can issue SQL as these roles: `app.tenant_id`
  and `app.bypass_rls` are session GUCs any role can set (the report-mode migration states the same
  scope). The GUC-independent controls are table privileges (SC5). The grant-name part is
  **detection only** (report mode) until #921. Adjudicator: the PostgreSQL policy evaluator.
- Acceptance (as `passwd_app`; outcomes pinned per connection state):
  - (a1) fresh connection, no context → `[]`; (a2) after a bypass transaction on the same session
    (`app.tenant_id` reverted to `''`) → 22P02.
  - (b) scope A → exactly A's row.
  - (c1) scope A, `UPDATE … WHERE id = B` → 0 rows, B unchanged (read back under scope B);
    (c2) scope A, `INSERT` of a fresh non-existent id → 42501; scope C (a childless tenant created
    for the cell as superuser and removed by the test's cleanup), `UPDATE tenants SET id = <fresh> WHERE id = C` (visible under USING,
    refused by WITH CHECK) → 42501. SQLSTATE pinned exactly; fresh ids so a widened WITH CHECK lets
    the statement succeed and the cell goes red.
  - (d) bypass with a grant naming `tenants` → A and B present by id, no report.
  - (e) bypass with a grant not naming it → rows returned and a `tenants` report.
  - FORCE and ENABLE are asserted from `pg_class` (C6), since a non-owner cannot observe FORCE.

### C2 — retention GC: trash enumeration under a bypass

- A declared `listTrashRetentionTenants(tx: Prisma.TransactionClient)` calls
  `assertSweepBypass(tx, true)` first (as every tx-taking sweep does) and reads the tenant list;
  `sweepTrashEntry` obtains it through `inSweepTx` with
  `grantForTables(BYPASS_PURPOSE.SYSTEM_MAINTENANCE, ["tenants"])`. The per-tenant transactions are
  unchanged (the blob delete still runs after each commit).
- Acceptance: a new integration cell runs `sweepTrashEntry` as `passwd_retention_gc_worker` and the
  seeded tenant's expired trash row is deleted (deterministic; the existing dispatch test's "no -1"
  depends on pooled-connection state). `listTrashRetentionTenants` is exported and joins
  `sweep-bypass-assert.test.ts`'s per-member deny/allow cells.

### C3 — audit-chain verifier: tenant enumeration under a bypass, empty is an error

- `runTick` reads the tenant list through `withBypassRls(prisma, …, BYPASS_GRANT.SYSTEM_MAINTENANCE_TENANT_LOOKUP)`
  (existing grant; same purpose and model set, registry rule D2), with an ALLOWED_USAGE entry for
  `scripts/audit-chain-verify-worker.ts` in `check-bypass-rls.mjs`.
- An empty enumeration is an error, not a healthy tick: the `__system__` tenant always exists, so
  0 tenants means the read lost its scope. The tick still emits its heartbeat, with
  `erroredTenantCount >= 1` (the field the deployed alert in `docs/operations/alerts.md` keys on),
  and a `tick incomplete` line with reason `TENANT_ENUMERATION_EMPTY`. It does not throw: a throw
  skips the heartbeat and leaves only the absence alarm, which cannot tell "inert" from "dead".
  `alerts.md`'s "equivalent by construction" sentence and recovery text cover the empty case
  (recovery as for a lost RLS scope).
- The no-RLS comment and `worker-policy-manifest.json`'s reason text are updated.
- Acceptance: an integration cell runs `runTick` as `passwd_app`; its heartbeat `tenantCount` equals
  the superuser count of `tenants`, `erroredTenantCount` is 0. A unit cell forces the enumeration
  to `[]` and asserts the heartbeat's `erroredTenantCount > 0` and the `TENANT_ENUMERATION_EMPTY` line.

### C4 — `enqueueAuditInTx` drops its `tenants` probe

- The probe is removed; `audit_outbox_tenant_id_fkey` (not DEFERRABLE, so checked at the INSERT;
  referential integrity checks bypass row security, PostgreSQL docs, "Row Security Policies")
  rejects an unknown tenant in the same transaction, on RDS as well.
- Position analysis: the probe and the INSERT are consecutive statements in the caller's
  transaction; nothing commits between them. Callers that catch:
  `rg -n -B6 '\blogAuditInTx\(|\benqueueAuditInTx\(' src scripts -g '!*.test.ts' -g '!**/__tests__/**' | rg 'try \{|catch'`
  → only `account-lockout.ts`, whose `try` is outside the transaction. Both failures abort the
  transaction; only the error text changes (FK 23503).
- The scope assertion (`readBypassState`) stays first.
- `scripts/checks/raw-sql-usage.txt` drops the entry for this file (its only raw call).
- `enqueueAuditInWorkerTx` keeps its probe on purpose (its grant is fixed and names `tenants`); its
  "mirrors enqueueAuditInTx" comment says so.
- Acceptance: integration cell — `enqueueAuditInTx` under AUDIT_WRITE_DIRECT_OUTBOX for an existing
  tenant produces no report (red if the probe is restored, because the probe examines that row);
  with an unknown tenant id it rejects and writes no row.

### C5 — `enforce_tenant_id_from_context` unchanged

- The users bootstrap branch already cannot commit: the BEFORE trigger's `INSERT INTO tenants` runs
  first and, after C1, is refused by the `tenants` WITH CHECK; before C1 the `users` WITH CHECK
  refused the row. Same outcome (statement aborted, nothing written). No migration change.
- Acceptance: on a fresh connection, a users INSERT with no context and NULL `tenant_id` fails with
  42501 and a message naming `tenants` (red before C1, which names `users`); no `tenants` row left.

### C6 — gates and verification scripts know `tenants`

- `check-rls-read-context.mjs`: its RLS table set adds `tenants` from a constant (the manifest stays
  `tenant_id`-keyed for `[E-MANIFEST-*]` and COLPARITY). The "no policy" self-test moves to
  `prisma.verificationToken` (the fixture schema gains that model); a new cell fails on a bare
  `prisma.tenant.findMany`.
- `check-migration-drift.mjs`: an explicit Check A branch for `tenants` (ENABLE, FORCE,
  `tenants_tenant_isolation`), independent of `hasTenantId`; the dead `RLS_EXEMPT_TABLES` goes.
  Self-test cells: missing ENABLE / FORCE / policy → red each; all present → green.
- `rls-cross-tenant-verify.sql`: a `tenants` block placed before Block 2's first `SET LOCAL
  app.tenant_id`, in this order: (a1) (before the block's own `SET LOCAL`), the
  `relrowsecurity AND relforcerowsecurity` flags, then (b), (c1), (c2) — so the fatal checks run
  even where the seed-dependent ones fail. A/B checked by id (the sentinel and smoke-seed tenants
  also exist). (c2) commits no row (pre-pr runs this against the long-lived dev DB): `INSERT` of a
  fresh id under scope A0, and under scope A0 `UPDATE tenants SET id = <fresh> WHERE id = A0`, each
  inside a sub-block catching `insufficient_privilege` only. Two codes: the seed-independent
  checks (flags, (a1)) are fatal everywhere; the seed-dependent checks ((b), (c1), (c2)) use their
  own code, which `scripts/pre-pr.sh` adds to its unseeded-dev allow-list beside COUNT-A/B/BYPASS.
  Block 4b's discovery drops its `relname <> 'tenants'` exclusion, so its marker-checked WARNING set
  covers (e). (d) is covered by the integration cell (setup.ts `afterEach`), not the verify SQL.
  The `tenant_id`-keyed exclusions stay, each pointing to the block.
- `rls-cross-tenant-negative-test.sh` (CI-only harness, already committing ALTERs on its CI database;
  excluded from the BEGIN/ROLLBACK rule below): a case that drops the tenant branch of
  `tenants_tenant_isolation` (symmetric, keeps the bypass branch, so Block 1's `[E-RLS-SYM]` /
  `[E-RLS-BYPASS-TABLE]` pass and the block is reached), expects the block's code, and restores the
  policy immediately after the case (as `run_case_8_force_rls` does), from a `pg_get_expr` snapshot
  of `polqual`/`polwithcheck` taken before the ALTER, and asserts the restored text equals the
  snapshot; `cleanup()` restores from the same snapshot as the fallback.
- Control class: **fail-closed verification gate** over bounded scan roots; adjudicators: ts-morph
  AST (read-context gate), migration text (drift gate), PostgreSQL catalogs (verify SQL).

### C7 — operator runbook SQL

- `docs/operations/alerts.md`'s queries on `tenants` / `audit_logs` all target the `__system__`
  tenant. On RDS (owner under FORCE) they run inside a transaction-scoped, read-only tenant scope,
  with no bypass:
  `BEGIN READ ONLY;` / `SET LOCAL app.tenant_id = '00000000-0000-4000-8000-000000000002';` /
  the query or `\copy` / `ROLLBACK;` — each on its own line, no `;` after `\copy` (psql takes the
  rest of a `\copy` line as its arguments).
  The tenant branch admits exactly that tenant's rows in both tables, nothing is reported, it keeps
  working after #921, `SET LOCAL` + `ROLLBACK` leave nothing on the session, and `READ ONLY` refuses
  accidental writes. The doc states never to `ALTER ROLE/DATABASE … SET app.*` (`audit-db-grants.mjs`
  already flags it). Already needed for `audit_logs`; now also for `tenants`.
- SC3 note in `docs/operations/deployment.md`: data migrations reading `tenants` on RDS set the
  scope or bypass GUCs transaction-locally.
- Acceptance: every `tenants` / `audit_logs` query in the runbook sits inside such a block (review
  step), and each block, including the `\copy` form, is executed once against the dev DB as a
  NOBYPASSRLS role to show it returns the sentinel rows.

## Testing strategy

- New `src/__tests__/db-integration/tenants-rls.integration.test.ts`: C1, C4, C5 cells.
- C2 / C3 cells drive the real functions as their real roles.
- Reports: setup.ts's `afterEach` (`failOnReports`) fails any test that produced an unexpected
  report, so a green full integration suite is the member-completeness check for paths the suite
  executes. The four `toContainEqual` report assertions in `rls-bypass-grants.integration.test.ts`
  (`rg -n toContainEqual src/__tests__/db-integration`) move to exact equality so an extra `tenants`
  report cannot be absorbed; `definer-audit-functions-grant` (PR for #922) gets the same once merged.
- Existing unit tests updated with the change: `sweep-trash.test.ts`, `sweep-isolation.test.ts`,
  `sweep-dispatch-bypass.test.ts` (the fake `tx.tenant.findMany` returns one tenant; the count and
  the enumeration transaction's `app.bypass_tables` are asserted, so the per-tenant trash
  transactions stay covered), `audit-outbox.test.ts` (the probe once-mocks leave the
  `enqueueAuditInTx` paths, stay on the bulk path), `audit-chain-verify-heartbeat.test.mjs` (the stub
  `$transaction` serves the enumeration transaction separately: it hands a tx with `tenant`, does
  not consume the per-tenant order, and does not apply `failFor`), `check-rls-read-context.test.mjs`.
- Mutations — file mutations on a scratch copy; DB mutations inside `BEGIN … ROLLBACK` or a
  throwaway database, never the shared dev DB:

| Contract | Mutation | Expected red |
|---|---|---|
| C1 | tenant branch dropped | (b) cell, verify block, negative-test case |
| C1 | WITH CHECK widened to `true` | (c2) cell (42501 pinned, fresh ids) |
| C1 | tenant branch without sub-SELECT | `[E-RLS-TENANT-INITPLAN]` |
| C2 | bare `workerPrisma.tenant.findMany` restored | C2 cell, read-context gate |
| C3 | bare read restored | C3 cell, read-context gate |
| C3 | empty-enumeration check removed | C3 unit cell (`erroredTenantCount > 0`) |
| C4 | probe restored | C4 report cell (existing tenant row) |
| C5 | `tenants` RLS disabled: superuser `BEGIN; ALTER TABLE tenants DISABLE ROW LEVEL SECURITY; SET LOCAL ROLE passwd_app;` + the users INSERT; `ROLLBACK` (app and workers stopped: ACCESS EXCLUSIVE) | message names `users`, not `tenants` |
| C6 | `tenants` removed from the read-context constant | new self-test cell |
| C6 | drift-gate `tenants` branch removed | drift self-test cells |

## Considerations & constraints

- Scope contract:
  - SC1 — #921 (enforce flip) turns C1 (e) into a refusal.
  - SC2 — grants that name `tenant` without needing it are not trimmed here. Before #921 this needs
    revisiting: the flip turns over-naming into over-admission. Follow-up issue.
  - SC3 — RDS owner-side reads in future data migrations must set a scope or bypass GUCs transaction-locally (V1); documented (C7).
  - SC4 — `check-bypass-rls` charging raw-SQL tables is not built; C4 removes the only
    caller-dependent member, and after #921 PostgreSQL refuses such a read itself.
  - SC5 — `REVOKE DELETE ON tenants FROM passwd_app` (no production caller deletes tenants; a table
    privilege is the GUC-independent control). Follow-up issue: a privilege change across initdb,
    bootstrap, manifest.
  - SC6 — `passwd_anchor_publisher` / `passwd_dcr_cleanup_worker` are outside RDS convergence and
    `audit-db-grants` AUDITED_ROLES. Follow-up issue.
- E2E helpers and `load-test/setup/seed-load-test-users.mjs` write `tenants` as `passwd_user`
  (superuser): unaffected. Integration helpers write as superuser + bypass GUCs: unaffected.

## User operation scenarios

- Sign-in (Google/SAML/passkey/magic link): tenant lookup under AUTH_* grants naming `tenant`.
- First sign-in creating a tenant: `tenant.create` under AUTH_CREATE_USER.
- Tenant admin editing policy: `tenant.update` under TENANT_TEAM_POLICY_LOOKUP.
- Share link create/revoke, account lockout, vault reset, emergency-access auto-promote, SCIM
  activation realign, `tenant-domain backfill-owning-column --apply`: audit enqueue (C4).
- Hourly retention GC trash purge (C2); audit-chain verifier tick (C3); operator retention check (C7).

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | RLS + policy on `tenants` | locked |
| C2 | retention GC trash enumeration under a bypass | locked |
| C3 | verifier enumeration under a bypass; empty is an error | locked |
| C4 | `enqueueAuditInTx` drops the `tenants` probe | locked |
| C5 | bootstrap trigger branch unchanged | locked |
| C6 | gates and verify scripts know `tenants` | locked |
| C7 | operator runbook SQL | locked |
