# Plan: audit-emit-tx-fold

Closes issue `#819` (SC7 + SC9, carried forward from PR `#818`).

**Revision 4 — final.** Three review rounds are recorded in
`audit-emit-tx-fold-review.md` (31, 25 and 31 merged findings). Findings are cited
as `M*` (Round 1), `N*` (Round 2), `P*` (Round 3).

Revision 4 is a **deletion**. Round 3 established that design Criticals had been
zero for two rounds while the plan's own prose kept generating them: nine of its
findings were factual claims about the tree that the plan had imported from a
previous round's measured tables and compressed wrongly. **The measurements live
in the review artifact; this document carries obligations and acceptance
criteria.** Gate-behaviour tables, call-site figures and per-file mock
enumerations are gone from here for that reason — not because they were unhelpful,
but because restating a measurement is how it becomes false.

Findings that only building the implementation can settle are in
**`## Carried-Forward Plan Findings`** at the end, each with an Anti-Deferral
entry. Phase 2 Step 2-1 reads that section.

## Project context

- **Type**: web app (Next.js 16 App Router + Prisma 7 + PostgreSQL 16, multi-tenant with RLS)
- **Test infrastructure**: unit (vitest) + real-DB integration + E2E + CI/CD + AST-based static gates under `scripts/checks/`
- **Verification environment constraints**:
  - **VE1 — integration tests cannot share a database with a running worker.** `docker compose stop audit-outbox-worker retention-gc-worker` first, restart after. Criteria naming an integration test are `verifiable-local` under this precondition, `verifiable-CI` unconditionally.
  - **VE2 — the Prisma-Proxy fold is only observable against a real database.** Measured; the probe transcript is in the review artifact's Round-1 Background.
  - **VE3 — no `blocked-deferred` path.**

## Objective

Close a latent fail-open in the audit emit path, and make the RLS nesting guard
reject all four nesting combinations, which its own comment already claims.

**The defect.** `prisma` is a Proxy. While an RLS context is active it does not
open a transaction for `$transaction` — it invokes the callback with the *outer*
transaction client. `enqueueAudit` / `enqueueAuditBulk` call `prisma.$transaction`
and then three `set_config`s; under an active context those land on the
**caller's** transaction, and PostgreSQL does not roll a transaction-local GUC
back when an `AsyncLocalStorage` scope exits.

**Its reach today.** Reaching that through `logAuditAsync` requires the enclosing
context to be a **tenant** context *and* `params.tenantId` to be supplied —
without it, `resolveTenantId` opens `withBypassRls`, which the *existing* guard
already rejects inside a tenant context. **No such site exists.** The one live
in-context emit sits in a **bypass** context, where the only GUC the fold forges
is `app.bypass_purpose`. So this closes a class with **zero exploitable members
today**, and the right test for a future emit is "is the enclosing context a
tenant context?".

## Requirements

1. An audit emit issued while an RLS context is open must not alter that
   context's GUCs, and must not write a row that could precede or outlive the
   caller's transaction unnoticed.
2. Outside an RLS context the emit is inline, as today. The
   `src/workers/audit-anchor-publisher.ts` emits inside a bare
   `prisma.$transaction` are unchanged.
3. `logAuditInTx` / `enqueueAuditInTx` keep their behaviour; C0 adds two callers.
4. Opening an RLS context while another is active is rejected in all four
   combinations.
5. `logAuditAsync` still never throws.

## Technical approach

Four contracts, shipped as one commit-range in the order **C0 → C1 → C2 → C3**,
bisectable at each commit (`npx vitest run` and `npm run test:integration` pass at
each, not only at the tip). The ordering is load-bearing:

- **C0 before C3** — today's auto-promote emit is bypass-in-bypass, which the
  guard allows; with C3 applied and C0 not, every emergency-access auto-promotion
  would produce zero audit rows and one dead-letter.
- **C2 with C1** — C1 alone changes the tenant-context-with-explicit-`tenantId`
  cell from folded-and-atomic to independently committed, which would let a row
  precede a rollback. C2 is what stops C1 creating that cell. (Three of the four
  in-context cells reach `enqueueAudit` today and all three change the same way;
  only tenant × absent is already blocked by the existing guard.)

## Contracts

### C0 — both `EMERGENCY_ACCESS_ACTIVATE` emitters become atomic

**Member set (R42), derived from the action:**

```bash
grep -rn 'AUDIT_ACTION\.EMERGENCY_ACCESS_ACTIVATE' src --include='*.ts' \
  | grep -vE '\.test\.|__tests__'
```

Four lines: **two production emitters** plus two registrations in
`src/lib/constants/audit/audit.ts` (`AUDIT_ACTION_VALUES`, the `EMERGENCY` group).

| # | Emitter | C0 |
|---|---|---|
| E1 | `src/lib/emergency-access/vault-auto-promote.ts` — wait-period auto-promotion | `logAuditInTx(tx, tenantId, …)` on the route's bypass transaction |
| E2 | `src/app/api/emergency-access/[id]/approve/route.ts` — owner's early approval | the transition's `withUserTenantRls(userId, fn)` is opened into `resolveUserTenantId(userId)` + `withTenantRls(prisma, tenantId, tx => …)`, yielding both the `tx` and the `tenantId`. `withUserTenantRls`'s signature is unchanged (SC3). |

`EMERGENCY_ACCESS_ACTIVATE` is added to `CRITICAL_ACTIONS` in
`scripts/checks/check-critical-audit-atomic.mjs`. **That gate is action-scoped: it
is satisfied by any one atomic site**, so it cannot close this class and is not
relied on to. Both members are disposed of here.

**Control class:** **enforceable boundary** — the row cannot commit without the
state change, because `enqueueAuditInTx` writes on the caller's `tx`. The gate
beside it is a **fail-closed verification gate over the action, not over the
site**. **Adjudication authority:** the PostgreSQL transaction.

**Invariants:**

- **I0.1:** at both emitters the success-path audit is written via `logAuditInTx`
  on the transaction that performed the state change.
- **I0.2 — the emit covers every path on which the CAS succeeded.** In E1,
  `transition()` flips `REQUESTED → ACTIVATED` inside the caller's transaction and
  two exits then return before today's emit (`revokedAt !== null`;
  `!encryptedSecretKey || !granteeKeyPair`). Neither throws, the route returns 403,
  and the transaction **commits** — leaving `ACTIVATED` with no audit row
  (`N10`, a real pre-existing defect). **Mechanism, named rather than left open
  (`P14`):** widen the pre-CAS select with `ownerId` and emit immediately after
  `transition()` returns `{ok:true}`, before the re-fetch. The alternative —
  emitting after the re-fetch — cannot cover the `!updated` arm, where there is no
  object to read `ownerId` from. That arm is unreachable in practice (the re-fetch
  runs in the transaction that just locked the row) and is recorded as such rather
  than left as a silent third member.
- **I0.3:** the CAS loser emits nothing. The placement after `{ok:true}`
  guarantees it.
- **I0.4 — the emitted row carries an outcome discriminator** (`P4`). After I0.2
  the action is emitted on three outcomes — escrow released, `revoked`,
  `no_escrow` — and C0's own rationale ("the operation hands a grantee the owner's
  escrowed vault key material") is true of one. On this path
  `EMERGENCY_ACCESS_ACTIVATE` is the **only** record that key material moved: the
  vault GET emits no `EMERGENCY_VAULT_ACCESS`. So both emitters add
  `metadata.outcome` — `"released" | "revoked" | "no_escrow"` for E1,
  `"released"` for E2. Additive metadata, **not** a new action value, which would
  be an R12 propagation across the action group, i18n and the UI label and icon
  maps. Consumers of the action value (the audit-log row label, the action-icon
  map, `AUDIT_ACTION_GROUP.EMERGENCY`) switch on none of it today; the field
  exists so one can, and an absent key means "written before this change".
- **I0.5 — tenant resolution, per emitter** (`P3`). Three primitives exist and
  they are not interchangeable: `resolveTenantId` reads `User.tenantId` (NOT NULL,
  FK-backed, never throws); `resolveUserTenantId` reads the single active
  `TenantMember` (returns `null` on a deactivated-only membership, **throws** on
  two active ones); `resolveUserTenantIdFromClient` is the in-transaction form of
  the second. **E1 uses `tx.user.findUnique(...).tenantId`** — what
  `resolveTenantId` does today, and what keeps I0.6's argument true. **E2 uses
  `resolveUserTenantId`**, because that is the tenant its RLS context must be
  opened on, and `enqueueAuditInTx` compares the passed `tenantId` against
  `current_setting('app.tenant_id')` — so the row's tenant and the context's must
  come from one resolution. The two can diverge (SCIM can create an active
  membership in tenant B for a user whose `User.tenantId` is A); where they do,
  E2's row follows the context. Stated rather than asserted equal.
- **I0.6 — the emit can now deny.** `logAuditInTx` throws where `logAuditAsync`
  swallowed. `enqueueAuditInTx`'s GUC arm passes at both emitters (E1's route has
  opened `withBypassRls`; E2 opens `withTenantRls` on the resolved tenant) and its
  tenant-existence arm passes because E1's `User.tenantId` is FK-backed. The
  reachable failures are transport-level ones that would have failed the mutation
  anyway, and a throw **rolls the CAS back**, so the grant stays `REQUESTED` and
  the next request retries. The trade is a retryable 500 instead of a silently
  unaudited escrow release.
- **I0.7 — E2's transaction contains only the state change and its audit**
  (`P13`). The grantee lookup and `sendEmail` stay strictly **after** the
  `withTenantRls` call returns. Folding them in is the natural edit and is wrong
  twice: a `withBypassRls` inside a tenant context throws under the *existing*
  guard, and `void sendEmail(...)` inside an open transaction is R9's shape.
- **I0.8 — attribution otherwise unchanged.** The row's `userId` stays the acting
  user; `logAuditInTx` emits no `auditLogger.info` line and runs no
  `assertEnqueueableUserId`, matching every other `logAuditInTx` site — so
  deployments with `AUDIT_LOG_FORWARD=true` stop seeing this action in the
  forwarded stream. For E1 the record is filed under the **grantee's** tenant in
  personal scope, so the vault owner's tenant admins do not see it; that is
  pre-existing and preserved deliberately (SC4).

**Forbidden pattern, with a runner** (`P7`):

- `pattern: logAuditAsync` **in `src/lib/emergency-access/vault-auto-promote.ts`**
  — reason: this file's one emit is the atomic one. Enforced by a
  `run_step "Static: emergency-activate-atomic"` in `scripts/pre-pr.sh`, in the
  established grep idiom of the `Static: no-deprecated-logAudit` step. Revision 3
  demoted this to a review aid on the claim that `pre-pr.sh` runs only
  `node scripts/checks/*.mjs` steps; that claim was false. The step must assert
  the file exists before grepping, so "file not found" and "no match" are not
  spelled the same. Verified not to match its own fix (`logAuditInTx` does not
  match `logAuditAsync`), and file-scoped so the two deliberate
  `void logAuditAsync` sites elsewhere stay out of scope.

**Acceptance criteria.** Each is labelled **[D]** discriminating (red before the
named contract, green after) or **[R]** regression (green both ways). A pin
labelled [D] that comes up green fails the procedure **by name** — "pin not
discriminating; fixture wrong or the pin measures the wrong thing" — and is never
recorded as satisfied.

- **[D/C0]** Both `revoked` and `no_escrow` produce their 403 **and** exactly one
  audit row carrying the matching `outcome`, with `status = ACTIVATED` asserted
  positively **first** so "no row because the fixture never promoted" cannot read
  as a pass. The live arm is `no_escrow` via `!granteeKeyPair`; the `revoked`
  state is a **defensive branch** — no transition produces
  `status = REQUESTED ∧ revokedAt ≠ null` — so its fixture is built by direct SQL
  and labelled as such (`P19`).
- **[D/C0]** A promotion whose transaction fails after the emit leaves no row
  **and** `status = REQUESTED` with `activatedAt` null.
- **[D/C0]** E2: the row is visible **inside** the transition's transaction and
  absent after a forced rollback.
- **[D/C0]** With `enqueueAuditInTx` forced to reject once, the request fails, the
  grant stays `REQUESTED`, and a **second** request succeeds — proving the failure
  is retryable, not terminal (`I0.6`).
- **[R]** Two concurrent vault GETs past the wait period produce exactly one row;
  the loser produces none. **Already implemented** as T17 in
  `centralize-state-transitions.integration.test.ts` — pre-existing coverage, not
  new work (`N9`).
- **[R]** The grantee still receives the vault payload on the first GET; the
  owner's early approval still returns `{status: ACTIVATED}` and still sends the
  grantee email.
- **[D/C0]** **Gate reach, stated correctly** (`P1`): removing **both**
  `logAuditInTx` calls makes `check-critical-audit-atomic.mjs` exit non-zero
  naming the action; with both present it exits 0 **and** prints its
  `all N security-critical actions` banner, so an ENOENT (also non-zero) is
  distinguishable from a violation. Removing **one** leaves the gate green — that
  run is recorded as *evidence of the action-scoped limit*, never as a pass.
  Revision 3's criterion asserted the opposite and was green under its own
  mutation.

### C1 — the outbox transaction is opened on the un-proxied client

**Change:** `enqueueAudit` / `enqueueAuditBulk` open their transaction on
`prismaBase` instead of `prisma`. Nothing else changes; the three inline
`set_config` calls stay as they are.

**Control class:** **enforceable boundary** — a caller cannot cause a fold because
the client it would fold onto is not the one the function uses. **Adjudication
authority:** the PostgreSQL backend, `txid_current()`.

**Invariants:**

- **I1.1 (app-enforced, test-pinned — not gate-checked):** neither opener in
  `src/lib/audit/audit-outbox.ts` uses the proxied client. Rounds 1–3 attributed
  this enforcement to two different gates in turn and both declined it: the
  question "which client opened the transaction" is not one
  `check-rls-read-context.mjs` decides. The enforcement is the acceptance
  criterion below, which observes `txid_current()` and the GUCs directly. **It is
  quantified over both openers and must be pinned on both** (`P10`).
- **I1.2:** `enqueueAuditInTx` keeps its caller-supplied `tx` and issues no
  `set_config`.
- **I1.3 (documentation, R29):** two docblocks become false and are corrected in
  the same commit — `assertOpenableTenantContext`'s two reasons for writing no
  audit row (C1 falsifies the first, C3 the second, since after C3 reaching that
  function implies no context is active), and
  `check-rls-read-context.mjs`'s SEARCH_DIRS comment claiming `src/lib/health.ts`
  is the only `src/lib` member of its class.

**Member set (R42):**

```bash
grep -rnE 'prisma(Base)?\.\$transaction' src/lib/audit/                    # 2
grep -rnE 'enqueueAudit\b|enqueueAuditBulk\b' src --include='*.ts' \
  | grep -v audit-outbox.ts | grep -vE '\.test\.|__tests__'                # 4
```

Two openers; the callers are `src/lib/audit/audit.ts` (the import plus one call
each) plus a prose mention in `tenant-rls.ts`'s docblock.

**Also in C1:** `src/lib/audit/audit-outbox.ts` is added to
`check-rls-read-context.mjs`'s scan roots. This is a **second, independent
control** — it does not enforce I1.1. What it catches is a bare-client statement
in the module and the bulk path's GUC setters; what it cannot see is which client
`$transaction` was called on.

**Acceptance criteria:**

- **[D/C1]** Inside an open `withTenantRls` context, a direct `enqueueAudit`
  writes under a **different `txid`** and leaves the outer transaction's
  `app.bypass_rls`, `app.tenant_id` and `app.bypass_purpose` unchanged.
- **[D/C1]** The same for `enqueueAuditBulk` with a two-payload batch. Two
  mutations that redden the same test are not two pins.
- **[R]** Both openers still write their rows — one row, and N rows for a batch of
  N, asserted by count.
- **[D/C1]** `check-rls-read-context.mjs` is green on the module, and each of two
  mutations reds it: a bare-client `auditOutbox.create` at module top level, and
  deleting `enqueueAuditBulk`'s GUC setters.

### C2 — an audit emit inside an RLS context is refused, loudly

**Change:** `logAuditAsync` / `logAuditBulkAsync` check `getTenantRlsContext()`
after their synchronous prefix; when a context is active they emit a dead-letter
under a dedicated reason and return **without writing**.

Revision 2 specified a deferral queue instead. It had zero live members after C0,
and two rounds found its failure modes (a silently dropped late push, a
seal/drain boundary, per-thunk error isolation) faster than they could be
specified away. What the deferral bought — a future in-context emit still gets its
row, after commit — is given up knowingly (SC2).

**Control class:** **enforceable boundary.** The check lives inside the emit
functions, so every caller inherits it. **Adjudication authority:**
`getTenantRlsContext()`, the same store the Proxy consults (R48). That authority
rests on `tenantRlsStorage` not being `run(...)` outside `tenant-rls.ts`; no
non-test caller does today.

**Live members: zero, after C0.** C2 is preventive. Stating that is its own R49
obligation — a boundary described as closing live defects when it closes none
invites the next reviewer to skip a control on its strength. What justifies
building it is that roughly half the tree's emit call sites already supply an
explicit `tenantId` — half of the exploitable precondition — and C1 changes what
the other half does when it arrives. (The proportion is measured in the review
artifact; three derivations of it disagreed on the exact counts and agreed on
"about half", which is all the argument needs.)

**Invariants:**

- **I2.1:** no emit performs a database write while an RLS context is active.
- **I2.2:** `buildOutboxPayload`, the `auditLogger.info` line and
  `assertEnqueueableUserId` run **before** the context check, on both paths, so a
  refused emit still produces its structured line and a malformed id still
  produces exactly one `invalid_user_id` dead-letter.
- **I2.3:** the refusal's dead-letter carries a **dedicated reason constant**
  (`emit_inside_rls_context`), distinct from `logAuditAsync_failed`.
- **I2.4 — the adjudicator's absence is not silence** (`P15`). I2.2 places the
  check inside `logAuditAsync`'s existing `try`, so an unresolvable
  `getTenantRlsContext` — a test stubbing `@/lib/tenant-rls` without it — would be
  caught and dead-lettered as `logAuditAsync_failed`, with the emit silently
  skipped: a control violation, a database blip and a broken mock all spelled
  alike, which is what I2.3 exists to prevent. `src/lib/audit/audit.ts` therefore
  asserts at **module load** that the symbol resolves, failing the suite at import
  rather than at call time and leaving the never-throws contract untouched.
  Writing `getTenantRlsContext?.()` in production instead is forbidden: it
  converts a broken mock into a silently inline path.
- **I2.5 — the refusal is reachable by an operator** (`P8`). `deadLetterLogger`
  sets `_logType: "audit-dead-letter"`, which
  `infra/fluent-bit/fluent-bit.conf` excludes by default; the exclusion is
  justified in `docs/operations/alerts.md` on the premise that the **two**
  remaining reasons fire only when the database is unreachable, "and in that state
  nothing durable can be written anyway". C2 adds a third reason that fires with a
  healthy database and writes no row, so neither the forwarder nor the
  sentinel-count query that replaced the old alert can see it. **This PR carves the
  new reason out of the exclusion and updates that enumeration.** Without it,
  C2's "fails loudly" is false as shipped.
- **I2.6:** the structured JSON line stays synchronous. It is **not** a
  compensating control — `auditLogger` is disabled unless
  `AUDIT_LOG_FORWARD=true`. The always-emitted record is `deadLetterLogger`.
- **I2.7:** `logAuditInTx` is unaffected. It is the correct in-context path.
- **I2.8 — declared residual: the refusal misfires on a detached continuation**
  (`P2`). `tenantRlsStorage.run` binds the store to the callback's whole async
  subtree, so work started **inside** an opener callback still reads the store
  after the transaction has closed — the one configuration where an inline enqueue
  would have been correct post-C1, and C2 refuses it. Zero live members. The
  remedy for a contributor who hits it is **not** "move the emit past the
  transaction" (the store is not the transaction): it is to leave the ALS scope
  (`tenantRlsStorage.exit`) or not to start the work inside the callback.

**Member set (R42):**

```bash
grep -nE '^export async function (logAuditAsync|logAuditBulkAsync|logAuditAsyncBothScopes)' \
  src/lib/audit/audit.ts                                                   # 3
```

`logAuditAsyncBothScopes` delegates to `logAuditAsync`; it is listed so the
enumeration is not read as two. `logAuditBulkAsync` is **not** a delegate — it has
its own synchronous prefix, its own `assertEnqueueableUserId` filter with an
empty-batch early return, and a catch that emits one dead-letter per entry — so it
needs its own pins (`P16`).

**Consumer impact.** C2 changes no persisted shape, no persisted value and no
timing for any emit that runs today; it removes a row only in a configuration with
no members. Tenant resolution stays at call time.

**Acceptance criteria:**

- **[D/C2]** Tenant context, `tenantId` supplied: no row; exactly one
  `emit_inside_rls_context` dead-letter. *(The GUC half of this cell belongs to
  C1's criteria — at the C1 commit the GUCs are already unforged, so only the
  no-row clause discriminates C2. `P18`.)*
- **[D/C2]** Bypass context, no `tenantId`: same.
- **[D/C2]** Tenant context, `logAuditBulkAsync` with two well-formed entries:
  `enqueueAuditBulk` not called; the dead-letter count stated explicitly and
  asserted (the singular path's convention gives one line per entry).
- **[D/C2]** Tenant context, `logAuditAsyncBothScopes`: two refusals, one per
  scope, proving the delegation inherits the control.
- **[R]** No context: `logAuditAsync` enqueues once with the resolved tenant;
  `logAuditBulkAsync` calls `enqueueAuditBulk` once with all payloads.
- **[R]** No context, one malformed and one well-formed id in a batch: two
  `auditLogger.info` calls, exactly one `invalid_user_id` dead-letter, exactly one
  `enqueueAuditBulk` call carrying one payload. A batch of one malformed entry
  produces zero enqueue calls (the empty-batch early return) — a different cell,
  and named as one.
- **[D/C2]** Tenant context **and** a malformed id: exactly one
  `invalid_user_id` line and exactly one `emit_inside_rls_context` line, zero
  rows — the cell that discriminates a check placed too early (`I2.2`).
- **[R]** `logAuditInTx` inside a context: row visible in the caller's
  transaction, gone on rollback.

### C3 — the RLS nesting guard rejects all four combinations

**Change:** `withTenantRls` and `withBypassRls` each throw `INVALID_RLS_NESTING`
when **any** context is active. `assertOpenableTenantContext` stays **strictly
after** the nesting guard, so a nested sentinel call keeps reporting the nesting.
Both messages are reworded, keeping the `INVALID_RLS_NESTING:` prefix so the
existing message-based assertions stay green.

**Control class:** **enforceable boundary** — with the qualification that a caller
which swallows the throw sees no denial. C2 removes the audit path's swallower;
other best-effort callers remain (SC1 states the consequence).
**Adjudication authority:** `getTenantRlsContext()`.

**Invariants:**

- **I3.1:** no RLS context is opened while another is active, in any of the four
  combinations.
- **I3.2 (documentation, R29):** the guard's comment describes what the guard
  does. It claims all four today while implementing two.

**Member set (R42)** — reproduced independently by four scans:

| # | Site | Kind | Disposition |
|---|------|------|-------------|
| N1 | `src/app/api/teams/[teamId]/route.ts` — `withTenantRls` inside `withTeamTenantRls`'s callback | tenant-in-tenant, same id | **Flatten:** drop the inner wrapper and rewrite the block's three `tx.*` uses to `prisma.*`, which the Proxy delegates to the open transaction. `collectEntryAttachmentRefs` accepts `TxOrPrisma`. |
| N2 | `src/lib/auth/session/auth-adapter.ts` — `resolveEffectiveSessionTimeouts` inside `createSession`'s `withBypassRls` | bypass-in-bypass, on a **cache miss only** | **Flatten by hoisting** above the opener; the helper needs only the user id and provider. The same file already hoists two other calls out of this block for this reason. |
| N3 | `src/app/api/emergency-access/[id]/vault/route.ts` | bypass-in-bypass | **Removed by C0** — `logAuditInTx` opens no context. |

**Non-members**, recorded so a later scan's five hits are not read as regressions:
`src/lib/mcp/oauth-server.ts` calls `derivePasskeyState` inside a `withBypassRls`
callback at two sites but passes `tx`, and that helper opens a context only on the
no-`tx` branch.

**Residual:** three opener call sites forward a **bare identifier** rather than an
inline function (`withVaultTenantRls`, declared separately inside each of two
vault route handlers, and `run` in `passkey-enforcement.ts`), so no
callback-walking scan enters their bodies. All three were resolved by reading;
none reaches an opener or an emit. Separately, `withUserTenantRls` /
`withTeamTenantRls` open a **bypass** context before the tenant one, so a call to
either from inside a context would throw at the bypass step — no such call exists.

**Forbidden pattern:** `allowNested|skipNestingGuard|force.*[Nn]esting` — no
suppression argument is added (R36). Review aid; no runner, and unlike C0's this
one guards against a shape that does not exist yet, so a runner would have nothing
to assert against.

**Acceptance criteria.** **Already green in `src/lib/tenant-rls.test.ts`, cited as
pre-existing and not re-counted as coverage:** tenant-in-bypass rejected,
bypass-in-tenant rejected, a **cross-kind** sequential pair not rejected, both
openers opening normally with no context, and the tenant-in-bypass sentinel
ordering case.

- **[D/C3]** The two new denials, asserted individually: tenant-in-tenant and
  bypass-in-bypass. Not a table loop, which an unconditional throw would satisfy.
- **[R]** The two **same-kind** sequential pairs, which the existing cross-kind
  test does not cover. Adjacency measured against the predicate the code
  implements (`getTenantRlsContext() !== undefined` at entry).
- **[R]** Concurrent siblings: `Promise.all([withTenantRls(…), withTenantRls(…)])`
  from one async context — both read the store before either enters `run`, so both
  open and neither throws. C3 rejects nesting, not sibling concurrency;
  `logAuditAsyncBothScopes` makes the cell reachable. Deterministic without a
  sleep.
- **[D/C3]** The guard throws **before** `prisma.$transaction` is called, asserted
  for the two new combinations in the existing style ($transaction / $executeRaw
  call counts do not increase) — a guard throwing from inside the callback would
  already have run `set_config`.
- **[D/C3]** Ordering, **in the combinations C3 newly covers** (`P-Q10`): a
  `withTenantRls` nested **inside `withTenantRls`** carrying `SYSTEM_TENANT_ID`,
  and one carrying a non-canonical id, each throwing `INVALID_RLS_NESTING` and not
  `RlsSentinelContextRefused`. Assert the error class **and** the message prefix
  separately, since C3 rewords both messages.
- **[R]** A non-nested sentinel call still throws `RlsSentinelContextRefused` with
  `refusal: SENTINEL`.
- **[D/C3]** **Sign-in on a cold `resolveEffectiveSessionTimeouts` cache** — N2's
  condition, and why C3 is fail-closed on an operational-recovery path (a cold
  cache is the state after every deploy). No venue exists today; the venue is a
  new integration test driving `adapter.createSession` against the real database
  with the module cache cleared via its exported `clear` (asserted positively) and
  the real `session-timeout` loaded. Both cells asserted — warm × flattened and
  cold × flattened — recording that warm × *unflattened* is green today and would
  stay green if the flatten were wrong. Pin the TTL boundary by setting
  `expiresAt` exactly at `Date.now()` (the `>` comparison puts it on the miss
  side); no `sleep`.
- **[D/C3]** **N1's flatten** — its own route test mocks both openers as
  passthroughs and never asserts on them, so the flatten is invisible there. The
  venue is an integration test deleting a team through the collect-then-cascade
  path, asserting the collected refs match the rows that existed (non-empty for a
  team with attachments) and that the cascade touched only the target team's rows.
- **[R]** The full unit suite and `npm run test:integration` pass — the empirical
  check on the member set, since a missed site now denies rather than leaks.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C0 | Both `EMERGENCY_ACCESS_ACTIVATE` emitters atomic; emit covers every CAS-success path and carries an outcome discriminator; action enrolled in `CRITICAL_ACTIONS` | locked |
| C1 | Outbox transaction on `prismaBase`; I1.1 app-enforced and pinned over both openers | locked |
| C2 | In-context emits refused with a dedicated dead-letter reason, load-time adjudicator assertion, and a forwarder carve-out | locked |
| C3 | Nesting guard rejects all four combinations; N1/N2 flattened | locked |

## Testing strategy

- **Integration (real DB, VE1)** — C0's four [D] cells and E2's atomicity; C1's
  two `txid`/GUC cells and the two gate mutations; C2's GUC-adjacent halves; C3's
  cold-cache sign-in and the team-delete flatten. Fixtures are marker-scoped, use
  no `tenant_id`-only predicate, keep the actor's `users` row alive, and assert the
  sentinel-tenant `audit_outbox` **delta** is zero in `afterAll`, registered at
  acquisition.
- **Unit (`src/lib/tenant-rls.test.ts`)** — C3's two new denials, the two same-kind
  sequential allow cells, the sibling-concurrency cell, the pre-`$transaction`
  throw, and the two ordering cases by error class.
- **Unit (`src/__tests__/audit.mocked.test.ts`, real `tenant-rls`)** — C2's routing
  cells across all three emit functions.
- **Gate self-test** — C0's both-removed / both-present / one-removed runs.
- **Before completion**: `npx vitest run`, `npx next build`, and
  `scripts/pre-pr.sh` on the **committed** diff.

**Pre-fix red proof.** Applies to **[D]** pins only, and each names the commit it
discriminates against, since the range is bisectable. A [D] pin green at its named
parent commit is mislabelled and fails by name. A pin whose pre-fix failure
mentions `INVALID_RLS_NESTING` is measuring the pre-existing guard, not the fold.

## Considerations & constraints

- **Connection-pool behaviour.** The class is "any emit reachable inside a
  transaction with no active RLS context", and its members are the anchor
  publisher's emits inside its own `prisma.$transaction`. C1 introduces no new
  overlap there because **the publisher builds its own `PrismaClient` and pool**,
  so the emit's transaction was never on the same client as the publisher's.
- **What this does not fix.** The three database-unreachable dead-letter sites
  remain log-only, as `resolveTenantId`'s existing TODO records.

### Scope contract

- **SC1 — a CI gate deriving C3's member set from the tree.** Revisions 1–2
  specified `check-rls-nesting.mjs`; two rounds could not settle its mechanism in
  prose. *Anti-Deferral: out of scope, owned by a follow-up issue. **Worst case,
  measured and corrected from revision 3's understatement:** a missed nesting site
  is a denied request only where the caller propagates — roughly 40 opener call
  sites sit under a catch that does not rethrow, several documented as deliberate
  ("never block the auth/lockout flow", "best-effort"), and there a nesting is
  **silent**. The "or by the test suite" disjunct is close to zero: the
  overwhelming majority of test files that mock `@/lib/tenant-rls` replace an
  opener with a passthrough, and only three integration files call the real
  openers. Likelihood low — all three current members are removed by this PR.
  Cost of doing it here — its mechanism needs to be built and measured rather than
  specified, which is Phase-2 work for a control that is not the boundary.***
- **SC2 — deferring in-context emits to after the caller's commit.** *Anti-Deferral:
  out of scope. Worst case — a future in-context emit loses its row rather than
  getting it late; likelihood low (zero members, and the refusal is recorded);
  cost — a per-context queue whose seal/drain boundary, late-push handling and
  per-thunk error isolation each produced a review finding faster than they could
  be specified. `logAuditInTx` covers the atomic case and moving the work out of
  the ALS scope covers the rest; the deferral is the third answer and should be
  built against a real member.*
- **SC3 — threading `tx` through `withUserTenantRls` / `withTeamTenantRls`.**
  *Anti-Deferral: the deferral already recorded in `src/lib/tenant-context.ts`
  stays. Worst case — the two `eslint-disable` lines remain; likelihood certain;
  cost — a public-contract change across 126 `withTenantRls` call sites.*
- **SC4 — owner-side visibility of an emergency-access activation.**
  *Anti-Deferral: pre-existing and preserved deliberately, out of scope. **Mechanism,
  corrected:** the owner's admins are blind because of the **scope**, not the
  tenant — `/api/tenant/audit-logs` filters `scope IN (TENANT, TEAM)` — so
  re-filing the row under the owner's tenant would change nothing. **Cost,
  corrected:** a close is cheaper than revision 3 stated — `/api/audit-logs`
  already surfaces emergency rows to the owner through a `metadata.ownerId`
  OR-branch, and E1's emit already carries `ownerId`, so adding the action to that
  branch would give the owner personal visibility with no second emit. The open
  question is a product one: whether an owner should see an *activation* as well
  as a *vault access*. Deferred on that question, not on cost.*
- **SC5 — whether `assertOpenableTenantContext`'s refusal should emit an audit
  row.** C1 and C3 falsify both reasons its docblock gives for not emitting; I1.3
  corrects the docblock either way. *Anti-Deferral: the emit is out of scope.
  Worst case — a tenancy-control trip stays visible only in app logs; likelihood
  low (no caller reaches it, and it throws); cost — it needs a system-attributed
  actor and a proof that the emit cannot recurse into the refusal it reports.*
- **SC6 — the anchor publisher's `void logAuditAsync` inside an open
  `$transaction`.** R9's shape, pre-existing, benign for a reason that is a
  property of its **call arguments** rather than of any guard: every publisher emit
  supplies an explicit `tenantId`, so `resolveTenantId` early-returns and opens
  nothing. *Anti-Deferral: out of scope, follow-up issue. Worst case — a future
  edit dropping a `tenantId` there reintroduces the fold class in a process C3
  cannot see, because no ALS store exists in it; likelihood low; cost — that
  worker's emit path is a different transaction discipline. Recorded so the next
  editor of that file finds the reason.*

## User operation scenarios

1. **Emergency-access auto-promotion (E1).** The promotion and its
   `EMERGENCY_ACCESS_ACTIVATE` row commit together — including on the `revoked`
   and `no_escrow` exits, which today commit `ACTIVATED` unaudited, and the row's
   `outcome` says which happened. Before this change the same request also left
   `app.bypass_purpose` forged on its transaction.
2. **Owner's early approval (E2).** The CAS and its audit row now commit together;
   the grantee lookup and the email stay outside that transaction.
3. **Sign-in with a cold session-timeout cache.** Only on a cache miss — the state
   after every deploy. Before C3 this path nests `withBypassRls`; after C3 an
   unflattened version throws and blocks sign-in entirely.
4. **Team deletion.** Refs are collected before the cascade, now on the ambient
   transaction rather than a re-opened one.
5. **A future contributor emits audit from inside a transaction.** C2 refuses it
   with a dedicated dead-letter reason, which the forwarder now carries. The fix is
   `logAuditInTx` if the record must be atomic, or moving the work out of the ALS
   scope if it need not be — **not** merely moving it past the transaction, which
   does not clear the store (I2.8).
6. **A future contributor opens a context inside another.** C3 throws at runtime.
   No CI gate catches it first — that is SC1.

## Carried-Forward Plan Findings

Round 3 findings that only building the implementation can settle. Phase 2 Step
2-1 reads this section; each carries an Anti-Deferral entry per the mandatory
format. Carrying forward is not a fifth disposition — these are findings routed to
Phase 2 with a cost, not findings resolved.

- **CF1 — `src/app/api/emergency-access/[id]/approve/route.test.ts` breaks in five
  ways under C0/E2** (`P12`): a bare `@/lib/tenant-context` factory missing
  `resolveUserTenantId`; the real `withTenantRls` running against a `@/lib/prisma`
  factory with no `$transaction`/`$executeRaw`; no `logAuditInTx` in the
  `@/lib/audit/audit` factory (which, unlike `logAuditAsync`, takes the request
  down rather than dead-lettering); an `importOriginal` repair breaking two
  `toHaveBeenCalledTimes(1)` assertions by adding a second `withBypassRls` call;
  and `transition`'s `db` changing to the transaction client. *Anti-Deferral:
  settled by building. Worst case — the implementer repairs it by stubbing
  `withTenantRls` as a passthrough, which makes the conversion unobservable in
  either direction; likelihood moderate, which is why the shape is named here.
  Cost of specifying further — the repair depends on the mock's final shape, which
  the implementation decides. **Obligation carried:** the repair must not stub an
  opener, and the file must assert `logAuditInTx` was called with the transaction
  and the resolved tenant.*
- **CF2 — the pre-declared test-edit list is a derivation, and revision 3's
  instance of it was wrong** (`P11`). `src/lib/tenant/tenant-management.test.ts`
  is **not** a member — nothing in its import graph reaches
  `src/lib/audit/audit.ts` — and at least two members are missing
  (`src/__tests__/api/mcp/authorize.test.ts`,
  `src/__tests__/api/extension/token-refresh-cnfJkt.test.ts`). The rule needs an
  intersection clause the plan omitted: *for every module C0/C1/C2 newly imports
  from, the test files whose factory mock of that module omits the new symbol
  **and in whose module graph the changed module is reachable***. *Anti-Deferral:
  run at implementation time, not specified here — a list restated across
  revisions is how CF2 got its wrong instance. **Worst case is the reason this is
  an obligation and not a note:** at the missed files the failure is silent —
  I2.4's load-time assertion is what converts it into a named import-time failure,
  so CF2 and I2.4 must land together. Known members to start from:
  `src/lib/audit/audit.test.ts` (spread `importOriginal` **and keep** the explicit
  `withBypassRls` override — a plain spread makes `withBypassRls` real against a
  prisma mock with no `$transaction`, inverting the file's assertions) and
  `src/__tests__/audit-outbox.test.ts` (add `prismaBase` to its `@/lib/prisma`
  mock).*
- **CF3 — C2's venue needs two mock additions and one criterion split** (`P17`).
  `src/__tests__/audit.mocked.test.ts` mocks `@/lib/audit/audit-outbox` without
  `enqueueAuditBulk`, so C2's batch cells cannot be asserted there; and the
  `logAuditInTx` regression cell names a durable row, which that venue has no
  database for — its routing half belongs there and its durability half beside
  C1's `txid` criterion. *Anti-Deferral: settled by building. Worst case — the
  batch cell is quietly dropped or the durability cell weakened to "was called";
  cost of specifying further — the split depends on the final assertion shapes.*
- **CF4 — C0's fixtures do not exist** (`P19`, `P20`).
  `centralize-state-transitions.integration.test.ts`'s `seedGrant` has no
  `revokedAt` option and always inserts the escrow; `fetchGrant` selects no
  `activated_at`; and I0.6's fault injection needs a spy that **delegates to the
  real `enqueueAuditInTx` by default** (a file-hoisted bare `vi.mock` would poison
  T17 and the file's atomic-audit rollback case). *Anti-Deferral: settled by
  building. Worst case — the deny cell is implemented with a blanket mock and two
  sibling criteria silently stop measuring; likelihood moderate, which is why the
  mechanism is named. Cost of specifying further — the seeder extensions are
  mechanical and the implementation will surface their exact shape.*
- **CF5 — T17's poll becomes a masking device after C0** (`P-Q11`). It polls
  `audit_outbox` breaking on `>= 1`, then asserts `=== 1`; after C0 the row commits
  with the promotion, so a second row arriving later is never observed in the test
  whose point is "exactly one". The fix is structural — read once after
  `Promise.all` resolves — not the comment rewrite the plan previously called for.
  *Anti-Deferral: settled by building. Worst case — the comment is rewritten and
  the poll left, leaving a vacuous "exactly one"; cost — none, this is a
  three-line change whose only risk is being mistaken for editorial.*

## Implementation Checklist

Authored in Phase 2 Step 2-1 from its own impact analysis. Phase 3 reads this as
the list of files that must appear in the diff. Separate artifact from
`## Carried-Forward Plan Findings` above.

### Carried-forward disposition (provenance checked)

Every `CF*` entry's underlying finding ID (`P1`–`P20`, `Q*`, `S*`, `F*`) was
confirmed present in `audit-emit-tx-fold-review.md`. CF1, CF3, CF4, CF5 are fixed
in this phase. **CF2 is fixed by running, not by listing** — see below.

### Member sets, re-derived at Step 2-1 (all reproduce)

| Set | Command | Result |
|---|---|---|
| C0 emitters | `grep -rn 'AUDIT_ACTION\.EMERGENCY_ACCESS_ACTIVATE' src --include='*.ts' \| grep -vE '\.test\.\|__tests__'` | 4 lines = 2 emitters + 2 registrations |
| C1 openers | `grep -rnE 'prisma(Base)?\.\$transaction' src/lib/audit/` | 2, both `audit-outbox.ts` |
| C1 callers | the `enqueueAudit\|enqueueAuditBulk` grep | 4 lines, `audit.ts` only + 1 docblock mention |
| C2 functions | the emit-export grep | 3 |

### Production files to modify

- `src/lib/emergency-access/vault-auto-promote.ts` — C0/E1: widen the pre-CAS select with `ownerId`; emit via `logAuditInTx` immediately after `transition()` returns `{ok:true}`, carrying `metadata.outcome`; resolve the grantee's tenant with `tx.user.findUnique(...).tenantId` (I0.5).
- `src/app/api/emergency-access/[id]/vault/route.ts` — C0/E1: pass the transaction and the resolved tenant into `autoPromoteIfElapsed`.
- `src/app/api/emergency-access/[id]/approve/route.ts` — C0/E2: open `withUserTenantRls` into `resolveUserTenantId` + `withTenantRls(prisma, tenantId, tx => …)`; the callback holds **only** `transition()` and `logAuditInTx` (I0.7); the grantee lookup and `sendEmail` stay after it returns.
- `scripts/checks/check-critical-audit-atomic.mjs` — C0: add the action.
- `src/lib/audit/audit-outbox.ts` — C1: `prisma.$transaction` → `prismaBase.$transaction` at both openers. Nothing else.
- `src/lib/audit/audit.ts` — C2: module-load assertion (I2.4); refusal after the synchronous prefix in `logAuditAsync` **and** `logAuditBulkAsync` (I2.2); dedicated reason constant (I2.3).
- `infra/fluent-bit/fluent-bit.conf` + `docs/operations/alerts.md` — C2/I2.5: carve the new reason out of the `audit-dead-letter` exclusion and correct the "two remaining reasons" enumeration.
- `src/lib/tenant-rls.ts` — C3: four-way guard, message rewording keeping the `INVALID_RLS_NESTING:` prefix, comment corrected (I3.2), `assertOpenableTenantContext` docblock corrected (I1.3).
- `src/app/api/teams/[teamId]/route.ts` — C3/N1: drop the inner opener, rewrite three `tx.*` to `prisma.*`.
- `src/lib/auth/session/auth-adapter.ts` — C3/N2: hoist `resolveEffectiveSessionTimeouts` above the opener.
- `scripts/checks/check-rls-read-context.mjs` — C1: add the module to `SEARCH_DIRS`; correct the `health.ts`-is-the-only-one header comment.
- `scripts/pre-pr.sh` — C0: `run_step "Static: emergency-activate-atomic"`, in the grep idiom of the existing `Static: no-deprecated-logAudit` step, asserting the file exists before grepping.

### Test files to modify (R19 — all trees enumerated)

Pre-declared, each with the break it takes:

- `src/__tests__/audit-outbox.test.ts` — C1: add `prismaBase` to the `@/lib/prisma` mock.
- `src/lib/audit/audit.test.ts` — C2: spread `importOriginal()` over `@/lib/tenant-rls` **and keep** the explicit `withBypassRls` override (a plain spread makes the opener real against a prisma mock with no `$transaction`).
- `src/app/api/emergency-access/[id]/vault/route.test.ts` — C0: `logAuditInTx` in the audit factory; `user` + `$queryRaw` on the prisma mock; assert the call carries the transaction and the resolved tenant.
- `src/app/api/emergency-access/[id]/approve/route.test.ts` — C0/E2, five breaks (CF1): `resolveUserTenantId` in the tenant-context factory as a `vi.fn` (**not** an `importOriginal` spread, which adds a second `withBypassRls` call and breaks two `toHaveBeenCalledTimes(1)` assertions); `$transaction`/`$executeRaw` on the prisma mock whose `tx` is the same spy object; `logAuditInTx` in the audit factory; `transition`'s `db` is now the transaction client. **The repair must not stub an opener.**
- `scripts/__tests__/check-critical-audit-atomic.test.mjs` — C0: extend `ALL`, update the banner string. Edit the list first; the gate's count is already derived from `CRITICAL_ACTIONS.size`.
- `src/__tests__/audit.mocked.test.ts` — C2/CF3: add `enqueueAuditBulk` to the audit-outbox factory; new routing cells across all three emit functions.
- `src/lib/tenant-rls.test.ts` — C3: two new denials, two same-kind sequential allow cells, sibling-concurrency cell, two ordering cases in the newly-covered combination.
- `src/__tests__/db-integration/centralize-state-transitions.integration.test.ts` — C0/CF4/CF5: extend `seedGrant` with `revokedAt` and a nullable escrow; extend `fetchGrant` with `activated_at`; the I0.6 fault injection uses a spy **delegating to the real `enqueueAuditInTx`** with `mockRejectedValueOnce` (a file-hoisted bare `vi.mock` would poison T17 and the atomic-audit rollback case); replace T17's `>= 1` poll with a single read after `Promise.all`.

**New integration tests:** C1's two `txid`/GUC cells; C0's E2 atomicity cell; C3's
cold-cache sign-in cell and the team-delete flatten cell.

### CF2 — derived by running, not by listing

The bare-`@/lib/tenant-rls`-factory set is **27 files**; those that also do not
mock `@/lib/audit/audit` are **15**. Which of those actually load the real
`audit.ts` is what decides membership, and I2.4's module-load assertion is the
instrument: after C2 lands, every member fails **at import, by name**. So the
procedure is: land C2 with I2.4, run `npx vitest run`, and repair exactly the
files that fail — with the `importOriginal`-plus-override shape, never a bare
`getTenantRlsContext` stub. Revision 3's static list was wrong in both directions
(it named `tenant-management.test.ts`, which is not a member, and missed at least
two that are); reproducing that list here would repeat the error. The 15
candidates are the expected superset, not the answer.
