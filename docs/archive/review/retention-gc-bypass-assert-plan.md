# Plan: retention-gc-bypass-assert (#874)

Six retention-gc sweep functions take a caller's `Prisma.TransactionClient` and set `app.bypass_rls` on it themselves. `set_config(…, true)` is transaction-local, so a future caller that runs one of them inside its own transaction would leave the RLS bypass on for the rest of that transaction.

#873 moved the audit-outbox `*InTx` seams to the opposite rule: a module-private wrapper sets the GUC, and the seam only asserts it (`assertAuditWriteBypass`). This plan applies the same rule to retention-gc.

## Project context

- **Type:** `service` (a worker process in the Next.js repo).
- **Test infrastructure:** `unit + integration`, plus CI. The real-Postgres tests live under `src/__tests__/db-integration/`, and the `ci-integration` workflow runs them on `src/workers/**` changes with the `passwd_retention_gc_worker` role provisioned.
- **Verification environment constraints:**
  - **VE1:** locally, the integration tests need Postgres with no live `retention-gc-worker` or `audit-outbox-worker` on the same database (CLAUDE.md). This is `verifiable-local`: stop the compose workers, run `npm run test:integration`, then restart them. CI runs no worker alongside.

## Member set (R42)

**Derivation:** the functions in `src/workers/retention-gc-worker/sweep.ts` whose first parameter is a `Prisma.TransactionClient` and whose body runs `set_config('app.bypass_rls'`.

| Member | Needs the bypass today |
|---|---|
| `sweepExpiryEntry` | when `entry.globalDelete` |
| `sweepGuardedExpiryEntry` | when `entry.globalDelete` |
| `sweepAuditProvenanceEntry` | when `entry.globalDelete` |
| `sweepAuditLogs` | always |
| `sweepPerTenantAge` | always |
| `sweepExpiredAccessRequests` | always |

These are not members:

- `sweepTrashEntry` opens its own per-tenant transactions, and the `sweepOnce` heartbeat opens its own transaction. Both set the GUC today; that `set_config` moves into `inSweepTx` (C1).
- `enqueueAuditInWorkerTx` reads the GUC (it accepts `bypass_rls = 'on'` or a matching `tenant_id`) but never sets it, and stays as it is.

No production code outside the worker calls a member.

## Contracts

### C1: a module-private wrapper owns the bypass

- **Signature:** `inSweepTx<T>(workerPrisma: PrismaClient, bypass: boolean, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>`. It is module-private: not exported (S1, following #873's private `setBypassRlsGucs`).
- **Behaviour:** it opens `workerPrisma.$transaction`. When `bypass` is true, the first statement is `set_config('app.bypass_rls', 'on', true)` (transaction-local), and then `fn(tx)` runs. It returns `fn`'s result and propagates its rejection.
- **What uses it:**
  - every `sweepOnce` dispatch, passing `bypass` = `entry.globalDelete === true` for the three entry-gated kinds, and `true` for the others;
  - the access-request status sweep;
  - the heartbeat;
  - `sweepTrashEntry`'s per-tenant transactions. The blob delete still runs after the wrapper resolves, which is after the commit (F4).
- **Result:** the only `set_config('app.bypass_rls'` left in `sweep.ts` is inside `inSweepTx`.
- **Least privilege kept (S2):** an entry without `globalDelete`, such as `verification_tokens`, still runs with no bypass.

### C2: each member asserts the bypass it needs, never sets it

- **Signature:** `assertSweepBypass(tx: Prisma.TransactionClient, expected: boolean): Promise<void>`, module-private. It reads `current_setting('app.bypass_rls', true)` and throws `Error("retention-gc sweep requires the RLS bypass state its entry declares")` unless the value matches:
  - **When `expected` is true:** the value must be `on`. A null, an empty string `''` (what a pooled connection returns after an earlier tx-local set), any other value, or a missing row is denied.
  - **When `expected` is false:** the value must not be `on`. An entry that does not declare `globalDelete` never runs under a caller's bypass.
  - **A missing row** denies for both values of `expected` (func R2-F3).
  - **A failed query** propagates.
- **Placement:** the first expression in each member that references its tx parameter (a `tx.*` call or `tx` passed as an argument; test R2-3), awaited and on the member's own tx parameter. The `sqlIdentifier` validation prologue may come before it. Each member's own `set_config` is removed.
  - Entry-gated members pass `entry.globalDelete === true`.
  - The other three pass `true`.
- **`globalDelete`:** it remains the runtime switch, honoured by the dispatcher (C1) and checked by the member (C2). The boot-time validators and the docs stay as they are, apart from the sentences that say the member sets the GUC.
- **Control class:** `fail-closed verification gate`. Absent, wrong and errored states deny before the member touches a row.
- **Adjudication authority:** the database's `current_setting` on the same transaction the member then uses.
- **Invariants (app-enforced):**
  - (a) `sweep.ts` contains exactly one `set_config('app.bypass_rls'`, inside `inSweepTx`;
  - (b) every function declaration in `sweep.ts` whose first parameter's written type annotation is `Prisma.TransactionClient` (the annotation text, not an inferred type, so the unannotated `(tx) =>` callbacks are not selected; func R2-F2), other than `enqueueAuditInWorkerTx` and `assertSweepBypass` (exempt by name), calls `assertSweepBypass` as its first `tx.*` call.
- **Forbidden pattern:** `set_config('app.bypass_rls'` anywhere in `sweep.ts` outside `inSweepTx`. `index.ts` must contain none either.
- **Purpose GUC (SC2, S4):** no RLS policy or trigger reads `app.bypass_purpose`. A grep of `prisma/` finds none; only app-side assertions read it. So a purpose would only show that the transaction came from this wrapper. That matters only if the wrapper were reachable from outside the worker, and C1 keeps it private.

## Testing strategy

- **Existing unit tests (T1).**
  - Migrate the fakes in `sweep-sql.test.ts`, `sweep-per-tenant-age.test.ts` and `sweep-access-request-expiry.test.ts` to a `$queryRaw` that answers by SQL text, not by call order. The assert's read selects only `bypass_rls`; `enqueueAuditInWorkerTx`'s read also selects `tenant_id`.
  - Rewrite the two tests that pin the member-side `set_config` ("sets bypass_rls before the UPDATE", "globalDelete entry sets the bypass_rls GUC in-tx") as "the member issues no `set_config`".
  - Keep the `enqueueAuditInWorkerTx` "rejects when … 'off'" test pointed at enqueue's own guard: the assert's read sees `on`, and enqueue's read sees `off`.
- **Per-member deny (T2).**
  - **Recorder:** a strict recording tx (a Proxy over every method and model). For each member, and for each deny input, the only recorded call is the single `current_setting` read, and the C2 error is thrown.
  - **Deny inputs:** null, `'off'`, `''`, `[]`, and a rejected query. For an entry-gated member, also a non-`globalDelete` entry reading `on`, and one reading `[]`.
  - **Allow:** paired with each deny; the member proceeds. A non-`globalDelete` entry reading `''` is allowed (T9).
  - **Fakes:** the migrated fake's `bypass_rls` answer defaults to the entry's declared state, so the existing `verification_tokens` composite-key test keeps passing (test R2-4a).
- **Wrapper (T6).**
  - **`inSweepTx`, tested only through `sweepOnce`** (no exported seam, which would bring S1 back; sec R2-1):
    - `set_config` comes before `fn`, on the same tx;
    - its third argument is `true`;
    - with `bypass: false` it issues no `set_config`;
    - it returns `fn`'s result and propagates its rejection.
  - **Dispatcher:** drive `sweepOnce` with a `$transaction` whose fake tx answers `current_setting` from its own state, so `on` only after a `set_config` on that tx. Assert that:
    - no count is `-1`;
    - `entry_failed` is never logged;
    - each entry-gated non-`globalDelete` entry ran without a `set_config`.
- **Source invariants (T8).** ts-morph over `sweep.ts`:
  - the member set is derived by C2(b)'s rule and must equal the six;
  - for each member, the first expression referencing its tx parameter is `await assertSweepBypass(<own tx param>, …)`;
  - exactly one `set_config('app.bypass_rls'` in the file, inside `inSweepTx`;
  - none in `index.ts`;
  - `inSweepTx` and `assertSweepBypass` are not exported (sec R2-1).
- **Integration.**
  - **Worker-role direct callers (T5):** the 9 calls that ran a member on `ctx.retentionWorker.prisma` with no GUC need it now. They use a test helper in `src/__tests__/db-integration/helpers.ts` that runs the transaction-local `set_config` exactly as `inSweepTx` does, so the wrapper stays private (S1). The calls are:
    - access-request-expiry-sweep, `runSweep`;
    - append-only-logs;
    - directory-sync-logs;
    - emergency-access;
    - forensic-credentials;
    - history-trim;
    - notifications;
    - security-records ×2.
  - **Superuser direct callers** already set the GUC and stay as they are.
  - **Production composition (new):** `sweepOnce(ctx.retentionWorker.prisma, …)` covers the NOBYPASSRLS role plus `inSweepTx`, which no existing test covers (every `sweepOnce` call there uses superuser). To be non-vacuous (test R2-1), it:
    - seeds an expired row in an RLS-enabled `globalDelete` table (`sessions`), whose deletion needs the wrapper's GUC;
    - seeds an expired `verification_tokens` row, the real-DB check of the `bypass: false` path;
    - asserts both rows exist before the sweep and are gone after it;
    - asserts no count is `-1`;
    - pre-deletes other expired rows of those tables in `beforeEach`, so a backlog cannot fill the batch;
    - removes the heartbeat `audit_outbox` rows for `SYSTEM_TENANT_ID` in `afterEach`.
  - **Guard (T3, T4):** for one EXPIRY `globalDelete` entry and for `sweepPerTenantAge`, on `ctx.su.prisma` (a superuser ignores RLS, so only the assert can stop the write):
    - inside a plain `$transaction` with no GUC, assert `rejects.toThrow(<C2 message>)` and let the transaction commit;
    - the seeded eligible rows are still present;
    - a positive control on the same fixture, with the GUC set, deletes them.
- **Red-proof (T7),** on a scratch copy, one mutation at a time:
  - the assert removed, once per member;
  - the assert moved after the write;
  - the assert not awaited;
  - a `set_config` reinserted into a member;
  - the assert moved after another `tx.*` call;
  - the wrapper's `set_config` made a no-op;
  - the wrapper's `is_local` set to `false`;
  - the `expected` argument hard-coded to `true`;
  - `assertSweepBypass` ignoring `expected=false` (accepting `on`);
  - the dispatcher's `bypass` hard-coded to `true`.
- **Full run:**
  - `npx vitest run`;
  - `npx next build`;
  - `npm run test:integration`, with the workers stopped;
  - `scripts/pre-pr.sh`.

## Also updated

- **Comments that describe member-side setting:**
  - the `sweep.ts` header (INV-C2b);
  - the `sweepPerTenantAge` docstring;
  - the TODO at the provenance member.
- **`index.ts`:** the `globalDelete` note.
- **`scripts/checks/worker-policy-manifest.json`:** the retention-gc `tenantScoped.reason` (S5, F6, T10).

## Scope contract

- **SC1:** no purpose GUC for retention-gc (see C2).
- **SC2:** `enqueueAuditInWorkerTx`'s own guard is unchanged.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | a module-private `inSweepTx` owns the bypass, honouring `globalDelete` | locked |
| C2 | each member asserts the bypass state its entry declares, never sets it | locked |
