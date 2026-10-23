# Plan: verify-sentinel-audit-chain

Issues: `#936` (implement), `#933` (analysis only — see "#933 findings").
Branch: `feat/verify-sentinel-audit-chain`, base `origin/main` ec689fb85.
Revision 4 — after plan-review round 3 (`verify-sentinel-audit-chain-review.md`).

## Project context

- Type: `mixed` (web app + workers + scripts). Tests: unit + real-PostgreSQL integration + CI.
- Verification environment constraints: none beyond the dev DB; the worker runs locally.

## Objective

`scripts/audit-chain-verify-worker.ts` walks each tenant's audit chain under `withTenantRls`, which
refuses the `__system__` sentinel by design (a context scoped to it would expose every
unattributable audit row). So the sentinel's chain is never verified; since `#932` the tick leaves
it out of the counts and logs `SENTINEL_CHAIN_UNVERIFIABLE` when its `audit_chain_enabled` is true.
Verify the sentinel like every other tenant: read its anchor and chained rows under a named bypass
grant that names only `auditChainAnchor` and `auditLog`.

The worker is the only verifier that can reach the sentinel: the maintenance endpoint requires an
admin of the tenant, and `20260901090000_forbid_system_tenant_membership` rules that out for
`__system__`.

## Contracts

### C1 — grant
`BYPASS_GRANT.AUDIT_CHAIN_VERIFY_SENTINEL_READ = defineGrant(SYSTEM_MAINTENANCE, ["auditChainAnchor",
"auditLog"])`. Control class, two layers (R49):
- table set — detection (report-mode WARNING) now, preventive for code using the helpers after
  `#921`; not a boundary against code that issues SQL (GUCs are settable by any role);
- row scope (the sentinel only) — each query's `WHERE tenant_id = $1`, plus the C2 assertions on
  the anchor read and the walk; the chained-row count has the `WHERE` alone. No database control:
  the grant admits every tenant's rows of the two tables.

### C2 — verifier read path
- The three reads (anchor, chained-row count, bounded walk; all `WHERE tenant_id = $1`) move into
  one function shared by both paths.
- `verifyTenantChain(tenantId, deps)` takes no scope option: the sentinel
  (`tenantId.toLowerCase() === SYSTEM_TENANT_ID`, the predicate `withTenantRls` refuses on) reads
  under `withBypassRls(…, AUDIT_CHAIN_VERIFY_SENTINEL_READ, { timeout, maxWait })`; every other
  tenant under `withTenantRls` as today.
- The bypass path is a separately exported `verifyChainUnderSentinelGrant(tenantId, deps)`, named
  for what it does, so integration tests can run it on throwaway tenants instead of the shared
  sentinel. Misuse on another tenant reads only that tenant's rows (row assertion below).
- Precondition on the bypass path, via `readBypassState` (the single reader of the bypass GUCs):
  throw `BYPASS_CONTEXT_MISSING` unless the state is non-null, `bypassRls === "on"`, `purpose` and
  `tables` equal `BYPASS_GRANT.AUDIT_CHAIN_VERIFY_SENTINEL_READ`'s (the constant, not a value
  passed in); values read are `JSON.stringify`'d into the message. Detection for an inert bypass.
- Row assertions on the bypass path: the anchor read selects `tenant_id` and returns at most one
  row, with `tenant_id === tenantId`; every walked row's `tenant_id` equals `tenantId`. Otherwise
  throw `BYPASS_SCOPE_VIOLATION`, whose message carries the expected and the offending tenant id
  only — never a row id or metadata.

### C3 — runTick
- The sentinel is verified every tick like every other tenant, whatever its `audit_chain_enabled`
  (a chain enabled once and then disabled keeps its rows and anchor, and stays verified). With no
  anchor it costs the anchor lookup and the chained-row count.
- Cost (R53), measured on the dev DB: `audit_logs` has no index on `chain_seq`, so the count visits
  every row of the tenant. Measured with the production statement (`… WHERE tenant_id = $1 AND
  chain_seq IS NOT NULL`) bound to the largest tenant (11,662 of 12,469 rows, so the planner chose
  a sequential scan): 1.7 ms, 528 shared buffers, all hits — a warm cache. A 1,000,000-row sentinel
  is ~42k heap pages; read cold that is seconds, not tens of seconds, against the 60 s
  `AUDIT_CHAIN_VERIFY_TX_TIMEOUT_MS`. Every ordinary tenant already pays the same
  query each tick. A partial index on `(tenant_id, chain_seq) WHERE chain_seq IS NOT NULL` is not
  added here (a migration building an index on `audit_logs`).
- `tenantCount` / `verifiedTenantCount` / the `tick incomplete %d/%d` denominator include it;
  `SENTINEL_CHAIN_UNVERIFIABLE` is removed. Enumeration-failure reasons unchanged.
- Files whose text changes with it: worker header and runTick comments; `check-bypass-rls.mjs`
  `ALLOWED_USAGE` comment for the worker; `scripts/checks/worker-policy-manifest.json`
  (`tenantScoped.reason`); `docs/operations/alerts.md` (the `tenantCount` paragraph, the
  `SENTINEL_CHAIN_UNVERIFIABLE` bullet and its recovery text); the integration test comment.
- `docs/operations/alerts.md` replaces the removed reason with what enabling the chain on
  `__system__` now means:
  - its default 365-day retention (`20260902120000`) purges rows without renumbering `chain_seq`,
    so once rows age out the walk reports TAMPER at the first retained row. Keeping the chain off is
    the default recommendation; clearing the retention instead brings back the unbounded growth
    that migration exists to stop (outsiders can create these rows), which also feeds TRUNCATED.
    The existing "disable the chain" SQL stays as the recovery;
  - its row volume is driven by unauthenticated pre-auth inflow and system events, so it is the
    tenant most likely to exceed `AUDIT_CHAIN_VERIFY_MAX_ROWS` and report TRUNCATED; the remedy is
    raising that and `AUDIT_CHAIN_VERIFY_TX_TIMEOUT_MS`.

### C4 — manual-test script (side fix)
`scripts/manual-tests/mcp-replay-audit-verification.ts`'s `withTenantRls` helper sets the bypass
GUCs on `tx` but its callbacks query the global `prisma`, another connection. Pass `tx` to the
callback and use it. It connects as a superuser (`MIGRATION_DATABASE_URL`), so RLS does not apply
either way; this is correctness of the helper, not a visibility change.

## #933 findings (no grant change)

24 grants name `tenant`.
- 19 reach `tenants` through Prisma: stripping `tenant` from every grant on a scratch copy makes
  `npm run check:bypass-rls` report `prisma.tenant … not in BYPASS_GRANT.<name>` for each.
- 4 the gate does not judge reach it through raw SQL or a self-setting site, read by hand:
  `AUDIT_ANCHOR_PUBLISH` (`tx.tenant.findMany`), `AUDIT_OUTBOX_ENQUEUE` (`enqueueAuditBulk`'s
  `SELECT EXISTS … FROM tenants`), `OUTBOX_DRAIN` (`SELECT audit_chain_enabled FROM tenants`),
  `RETENTION_HEARTBEAT` (`enqueueAuditInWorkerTx`'s `SELECT EXISTS … FROM tenants`).
- 1 is unevidenced: `MANUAL_MCP_REPLAY_VERIFICATION`'s only consumer is a manual script that runs
  as a superuser, so no RLS decision ever reads its model list, and the gate records it as used but
  does not judge it. Left as is; recorded in the `#933` closing comment.
- No trigger needs `tenant`: `enforce_tenant_id_from_context`, the one invoker-rights function
  reading `tenants`, returns first when `app.bypass_rls = 'on'`.

## Testing strategy

No test changes the sentinel's `audit_chain_enabled` or writes rows for it: on the shared DB a
committed flag would be acted on by the outbox worker and the anchor publisher irreversibly.

- Unit (`scripts/__tests__/audit-chain-verify-heartbeat.test.mjs`): the stub records, per
  transaction, the GUC values `$executeRaw` wrote and the `$transaction` options, answers the
  `current_setting` reads from what was written (and gains `$queryRaw` for `readBypassState`), and
  keys its row/anchor fixtures and overrides by tenant id, so a case states the sentinel's own
  fixture rather than inheriting another tenant's. Cases:
  - the sentinel is routed to the bypass path; its transaction wrote `bypass_rls = on` and the
    grant's purpose and tables; it is counted with no `verify threw` (allow);
  - `BYPASS_CONTEXT_MISSING` asserted by message on each axis: `bypass_rls` not `on`, `purpose`
    differs, `tables` differ, `readBypassState` returns no row;
  - `BYPASS_SCOPE_VIOLATION` asserted by message: a foreign anchor row; the sentinel's own anchor
    followed by a foreign one (`[own, foreign]` — the at-most-one-row half); a foreign walked row
    (the sentinel fixture has an anchor so the walk runs);
  - the sentinel transaction's own recorded options carry the stated timeout;
  - existing cases change with the contract: every `trackTenantOrder` list gains the sentinel in its
    enumeration position; the "leaves the sentinel out of the counts" and "`[SYSTEM_TENANT_ID]`
    alone → `tenantCount` 0" cases and the `SENTINEL_CHAIN_UNVERIFIABLE` case are rewritten; the
    count and denominator assertions shift by the sentinel.
- Integration (`audit-chain-verify-worker-rls.integration.test.ts`, as `passwd_app`):
  `verifyChainUnderSentinelGrant` on throwaway tenant A while tenant B also has a chain — healthy
  (`ok`, `anchorChecked`, `totalVerified === CHAIN_LENGTH`) and tampered (`firstTamperedSeq === 2`);
  `verifyTenantChain(SYSTEM_TENANT_ID)` returns without error, and its result matches what a
  superuser reads of the sentinel — no anchor: `totalVerified === 0` and `ok === (chained === 0)`;
  an anchor: `anchorChecked` and `totalVerified` = rows with seq ≤ the anchor's, capped. On a clean
  CI DB this proves routing and that the precondition holds on a real database, not visibility
  (the tenant-A cell proves that). `runTick`'s `tenantCount` equals the superuser count of all
  tenants including the sentinel.
- Red proofs (scratch copy), each naming what goes red: routing the sentinel to the tenant path →
  the integration sentinel case throws `RlsSentinelContextRefused`; precondition removed → the
  unit `BYPASS_CONTEXT_MISSING` cases; row assertions removed → the unit `BYPASS_SCOPE_VIOLATION`
  cases; the anchor row-count check removed → the `[own, foreign]` case; row assertion removed and the walk's `WHERE` dropped → the integration tenant-A case (B's
  rows join the walk); a grant missing `auditLog` → the integration tenant-A case, through
  `setup.ts`'s report check (the sentinel case reads no rows, so may not emit the WARNING); the
  timeout dropped on the bypass call → the unit timeout case.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | sentinel read grant | locked |
| C2 | verifier bypass read path, precondition, row assertion | locked |
| C3 | runTick verifies the sentinel every tick; docs | locked |
| C4 | manual-test script uses tx | locked |
