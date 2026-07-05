# Plan: fix Serializable-isolation drop under RLS bypass (TOCTOU); harden callback form; clear WARNs

> **Primary theme: fix a confirmed pre-existing TOCTOU race in per-user "count-then-create"
> limit enforcement — across 4 sites (member-set derived from code, R42), not 1.**
>
> The seed instance: `auth-adapter.ts:275` wraps `prisma.$transaction(fn, { isolationLevel:
> "Serializable" })` inside `withBypassRls`. The Proxy folds nested `prisma.$transaction(fn,
> opts)` → `fn(activeTx)`, **silently dropping `opts`** — the inner tx runs at **read
> committed** (probe: `nested-under-bypass isolation: read committed`), so the intended
> Serializable TOCTOU guard on `maxConcurrentSessions` is NOT applied.
>
> **R42 member-set (derived from the PRIMITIVE "findMany(active) → evict oldest → create"
> under RLS, NOT from the `isolationLevel` symptom-grep):** 4 sites share this exact race:
> 1. `auth-adapter.ts:275` — session limit (`maxConcurrentSessions`) — the seed
> 2. `extension/bridge-code/route.ts:271` — `BRIDGE_CODE_MAX_ACTIVE`
> 3. `auth/tokens/extension-token.ts:219` — `EXTENSION_TOKEN_MAX_ACTIVE`
> 4. `auth/tokens/mobile-token.ts:145` — mobile token cap
> (`resource-quotas.ts` is a *documented* pre-1.0 soft-cap — explicitly out of scope.)
>
> **Fix (matches the codebase's OWN established idiom — 7 existing precedents):** NOT
> Serializable (which needs 40001-retry the codebase lacks → would turn a silent over-count
> into a login 500). Instead prepend `SELECT pg_advisory_xact_lock(hashtext(${userId}::text))`
> as the first statement in each count-then-create transaction — retry-free, blocks-then-
> proceeds, no 40001. Precedent: `attachments/route.ts:273`, `vault/rotate-key/route.ts:180`,
> `access-requests/[id]/approve/route.ts:142`, etc. — the exact per-user-serialize pattern.
>
> Secondary: harden the 41 `with(Bypass|Tenant)Rls` callbacks to the guard-prescribed
> `(tx) => tx.x` form (removes the ALS/Proxy fragility). Tertiary (done): 2 non-fatal WARNs.

## Project context

- **Type**: web app (Next.js) + CLI. This change touches **production RLS-adjacent code**
  (25 files calling `withBypassRls` / `withTenantRls`) plus two non-fatal CI-WARN fixes
  (already committed on this branch).
- **Test infrastructure**: unit + integration (real Postgres) + E2E + CI. `check-bypass-rls.mjs`
  is a CI guard enforcing the callback form; `npx eslint .` flags unused `tx`.
- **Verification environment constraints**: the real-DB behavior (does `tx.x` == `prisma.x`
  under bypass?) requires a running Postgres. Available locally (`docker compose`, dev DB).
  Empirically verified: inside `withBypassRls`, `prisma.x` and `tx.x` return identical
  cross-tenant results TODAY (the Proxy routes `prisma` to the bypassed tx via ALS). So this
  is a **robustness/convention fix, not a live bug fix**.

## Objective

Resolve the standing tension between two rules that both operate on
`with(Bypass|Tenant)Rls(prisma, (tx) => ...)` callbacks:

- **`check-bypass-rls.mjs`** (CI guard, currently PASSES): forbids the tx-less `() =>` form
  and mandates `(tx) => tx.x.method(...)`. Rationale (verbatim from the guard): *"The
  bare-prisma form works only via the Prisma proxy's AsyncLocalStorage injection; it
  brittle-fails in tests that inject a raw PrismaClient or use a DI wrapper."*
- **`eslint no-unused-vars`** (currently 41 non-fatal WARNs): flags the `(tx)` param as
  unused when the body uses `prisma` (or the ambient Proxy) instead of `tx`.

Bring the 41 flagged callbacks into the guard's prescribed form (`tx` actually used), which
satisfies BOTH rules AND removes the Proxy/ALS dependency (the exact fragility the guard
exists to prevent). Where the tx-form is genuinely not threadable, decide and document the
correct disposition (not a blanket suppression).

**This was originally mis-scoped as "cosmetic lint cleanup" and once wrongly "fixed" by
removing `tx` (→ `() =>`), which the guard immediately rejected. That revealed the guard's
intent: the tx-form is the prescribed robust form. The correct fix is `prisma.x → tx.x` in
the body, not param removal.**

Secondary (already done, kept on this branch as the "ついで" part): eliminate the two
non-fatal pre-pr WARNs — `security-doc-exists` (`## Overview` heading added to
`audit-anchor-verification.md`) and the CLI `--tag-secret` stderr leak (silence stderr by
default in `audit-verify.test.ts`).

## The 41 sites, classified (member-set derived from `npx eslint . | grep "'tx' is defined but never used"`)

| Bucket | Count | Shape | Disposition |
|--------|-------|-------|-------------|
| **B_RAW_SQL** | 9 | `(tx) => prisma.$queryRaw/$executeRaw(...)` | `prisma.$` → `tx.$` (mechanical, safe) |
| **C_HELPER_DB** | 4 | `(tx) => helper({ db: prisma, ... })` | `db: prisma` → `db: tx` (helper already takes a client param) |
| **A_NESTED_TX** | 13 | `(tx) => prisma.$transaction(async (tx) => { ...tx.x... })` | outer `tx` unused; inner `tx` used. See design C-A below |
| **F_DELEGATE** | 15 | `(tx) => helperThatUsesAmbientPrisma(...)` / `(tx) => scimResponse([...])` / `(tx) => fn(tenantId)` | tx not threadable without changing helper signatures. See design C-F below |

Exact site → bucket map is in `docs/archive/review/bypass-rls-tx-callback-form-sites.md`
(generated; the Implementation Checklist references it).

## Contracts

### C-L1 — fix the count-then-create TOCTOU via advisory lock (PRIMARY, 4 sites)

- **Root cause**: 4 per-user cap enforcers run `findMany(active) → evict oldest → create`
  inside an RLS transaction at **read committed**. Two concurrent calls both observe
  `active.length < max`, both evict the same oldest set, both insert → the cap is exceeded.
  The session site *tried* to prevent this with a nested Serializable `$transaction`, but the
  Proxy drops the isolationLevel (proven). The other 3 never even tried.
- **Fix (uniform, per the codebase's own advisory-lock idiom)**: prepend, as the FIRST
  statement inside each count-then-create transaction:
  `await tx.$executeRaw\`SELECT pg_advisory_xact_lock(hashtext(${userId}::text))\``.
  This serializes all concurrent count-then-create ops for the same `userId` — the loser
  BLOCKS until the winner commits, then sees the updated count (retry-free, no 40001, no
  login-500). The advisory lock is transaction-scoped (auto-released on commit/rollback).
  Precedents (verified): `attachments/route.ts:273`, `vault/rotate-key/route.ts:180`,
  `access-requests/[id]/approve/route.ts:142`, `service-accounts/[id]/tokens/route.ts:141`,
  `webauthn/credentials/[id]/prf/route.ts:124`.
- **Sites & keys** (member-set = 5, re-derived from the primitive; R42 round-2 caught the 5th):
  | Site | key | tx wrapper | note |
  |------|-----|-----------|------|
  | `auth-adapter.ts:275` | `session.userId` | `withBypassRls` | remove dead inner Serializable `$transaction`, run on outer `tx` |
  | `extension/bridge-code/route.ts:271` | `userId` | `withBypassRls` | lock as first stmt |
  | `auth/tokens/extension-token.ts:219` | `userId` | `withUserTenantRls` → inner `$transaction` | lock as first stmt |
  | `auth/tokens/mobile-token.ts:145` | `userId` | `withBypassRls` | lock as first stmt |
  | `sends/file/route.ts:159-217` | `session.user.id` | **currently 3 SEPARATE `withUserTenantRls` calls** | **byte-quota TOCTOU**: `aggregate(_sum sendSizeBytes)` → check `> SEND_MAX_ACTIVE_TOTAL_BYTES` → `create`, split across calls. Fix needs UNIFYING count+create into ONE `withUserTenantRls(userId, async (tx) => { lock; re-aggregate; if over → throw; create })` — keep the expensive encryption OUTSIDE the locked section (encrypt first, then lock+re-check+create) so the advisory lock is held only across the count+insert, not the crypto |
- **NO Serializable, NO `withBypassRls` signature change.** (S1: Serializable without retry
  → login 500; the codebase has no 40001-retry infra. Advisory lock is the retry-free idiom.)
- **Invariant** I-CL1-1 (behavioral, real-DB, mutation-killing): for EACH of the 4 sites, two
  truly-concurrent issue calls (two distinct pooled clients) at the cap boundary result in the
  active count **never exceeding max** (the loser blocks, then evicts-and-creates against the
  post-winner state). Test must be shown to go RED when the advisory lock line is removed.
- **Invariant** I-CL1-2 (no availability regression): neither concurrent call throws `40001`
  / `P2034` (advisory lock blocks, does not abort). Distinguishes advisory-lock from a naive
  Serializable fix.
- **Testability (T1 fix)**: the session path is bound to the singleton `prisma` inside
  `createCustomAdapter`, so it cannot be raced with two injected clients directly. Extract the
  count-then-create body of EACH site into a helper taking an explicit client
  (e.g. `enforceSessionLimit(client, ...)`), then race via the existing
  `raceTwoClients(clientA, clientB, ...)` harness (`db-integration/helpers.ts:297`) with two
  `createPrismaForRole("app")` clients. If extraction is too invasive for a site, test the
  primitive: two clients each run the site's exact CAS body by hand under the advisory lock.
- **Test location (T4 fix)**: `src/__tests__/db-integration/count-then-create-toctou.integration.test.ts`,
  one `describe` per site, `const SKIP = !process.env.DATABASE_URL; it.skipIf(SKIP)(...)`,
  seed at-cap, race ≥50 iterations (per the T6/statistical-loop precedent).
- **Forbidden pattern**: `findMany\([\s\S]*?(revokedAt|usedAt|expires)[\s\S]*?\}\)` followed by
  `.create(` inside a `with(Bypass|Tenant)Rls`/`$transaction` WITHOUT a preceding
  `pg_advisory_xact_lock` — per-site grep pinned in the checklist.
- **Acceptance**: all 4 sites carry the advisory lock; I-CL1-1 RED-without-lock verified;
  I-CL1-2 green (no 40001); `check-bypass-rls: OK`; `resource-quotas.ts` explicitly noted as
  out-of-scope documented soft-cap (SC2).

### C-B — B_RAW_SQL: `prisma.$queryRaw*` / `prisma.$executeRaw*` → `tx.$…`

- **Signature**: no signature change; per-callsite body edit.
- **Invariant** I-CB-1 (app-enforced): after edit, each of the 9 callbacks references `tx`
  (satisfies eslint) and uses no `prisma.` inside the callback body (satisfies check-bypass-rls's
  intent). `tx.$queryRawUnsafe` / `tx.$executeRaw` are valid on `Prisma.TransactionClient`.
- **Invariant** I-CB-2 (verified against real DB): `tx.$queryRaw(...)` returns identical rows
  to the pre-edit `prisma.$queryRaw(...)` under the same bypass — because `tx` IS the bypassed
  transaction (empirically confirmed).
- **Forbidden pattern**: `withBypassRls\([\s\S]*?async \(tx\) =>\s*prisma\.\$` in the 9 files — reason: must use `tx.$`.
- **Acceptance**: `check-bypass-rls: OK`, these 9 no longer in eslint tx-unused set, suite green.

### C-C — C_HELPER_DB: `db: prisma` → `db: tx`

- **Signature**: no change — the helpers (`transition({db})`) already accept a client via `db`.
- **Invariant** I-CC-1: the helper's `db` param type accepts `Prisma.TransactionClient`
  (verify: `transition`'s signature). If it only accepts `PrismaClient`, widen to `TxOrPrisma`
  (the existing union in `prisma.ts`) — do NOT narrow behavior.
- **Consumer-flow walkthrough**: `transition({ db, where, to, actor })` (emergency-access
  decline/request/reject, access-requests deny) reads `db` and runs a compare-and-swap update.
  Passing `tx` makes the CAS run on the bypassed tx (same result today; robust tomorrow).
- **Acceptance**: same as C-B for the 4 files; plus `transition`/state-helper unit tests green.

### C-A — A_NESTED_TX: outer callback wraps `prisma.$transaction`

- **Problem**: `withBypassRls(prisma, async (tx) => prisma.$transaction(async (tx) => {...}))`.
  The outer `tx` is unused; the inner `prisma.$transaction` folds into the outer bypassed tx via
  the Proxy (returns `arg(activeTx)`), so the inner `tx` IS the bypassed tx and is used.
- **Design decision** (to be finalized in review): the inner `prisma.$transaction` is
  **redundant** — `withBypassRls` already opened a transaction. Two candidate fixes:
  - (A1) **Remove the redundant inner `$transaction` wrapper**, use the outer `tx` directly:
    `withBypassRls(prisma, async (tx) => { ...tx.x... })`. Cleanest; outer tx now used.
  - (A2) If the inner `$transaction` passes an **isolationLevel** (e.g. `auth-adapter.ts:275/279`
    "Serializable prevents TOCTOU"), removing it may drop the isolation level. **BUT** — LATENT
    CONCERN L1: the Proxy's `$transaction` fold (`arg(active)`) **silently ignores
    isolationLevel** already today, so the Serializable guarantee may not currently hold. This
    must be investigated per-site; do NOT blindly remove a `$transaction` that carries an
    isolationLevel without confirming the isolation is (or is not) actually applied.
- **Invariant** I-CA-1: after the fix, the outer `tx` is used (eslint clean) and the callback
  contains no `prisma.` reference. Behavior (rows written/read, transaction atomicity)
  unchanged — verified by the affected route's integration/unit tests.
- **Forbidden pattern**: none blanket (per-site); the Implementation Checklist pins each.
- **Acceptance**: per-site integration test green; `check-bypass-rls: OK`; isolationLevel
  concern (L1) resolved with an explicit note per nested site.

### C-F — F_DELEGATE: callback delegates to a helper using ambient `prisma`

- **Problem**: `(tx) => fetchScimGroup(...)` / `(tx) => autoPromoteIfElapsed({...})` /
  `(tx) => fn(tenantId)` / `(tx) => scimResponse([...static...])`. The callback never touches a
  DB client directly; the work happens in a helper that reads the ambient Proxy `prisma`, or
  there is no DB access at all (static SCIM discovery responses).
- **This is the design-heavy bucket.** `tx` cannot be threaded without changing every helper's
  signature to accept a client (`fetchScimGroup(tenantId, id, baseUrl, tx?)` etc.), which
  cascades. Candidate dispositions (decide per sub-group in review):
  - (F1) **Static-response SCIM sites** (`ResourceTypes`, `Schemas`, `ServiceProviderConfig`)
    perform NO DB access inside the callback. The `withTenantRls` wrapper is arguably
    unnecessary here (nothing tenant-scoped is read). Candidate: verify no DB access, and if so,
    the correct fix may be to drop the pointless `withTenantRls` wrapper entirely (removing the
    callback and its `tx`). MUST confirm the helper truly does no DB I/O.
  - (F2) **Helper-delegating sites** (`fetchScimGroup`, `resolveUserId`, `autoPromoteIfElapsed`,
    `findOrCreateSsoTenant`, `withUserTenantRls`'s `fn(tenantId)`): thread a client param through
    the helper so the callback becomes `(tx) => helper(..., tx)`. Scope the cascade — some
    helpers are called from many places. If the cascade is large, this sub-group is a candidate
    for a **scope-out (SC1)** to a dedicated follow-up, with the tension documented.
  - (F3) `withUserTenantRls`/`withTeamTenantRls` (`tenant-context.ts:54,73`): the callback is
    `(tx) => fn(tenantId)` where `fn` is a caller-supplied `(tenantId) => Promise<T>` that does
    NOT take a client. `tx` is structurally unthreadable here without changing the public
    `withUserTenantRls` contract. Candidate: this is the definition-layer; a narrowly-scoped
    `eslint-disable-next-line` WITH a written justification citing the ALS-Proxy contract may be
    the honest disposition IF F2 threading is out of scope — but per `feedback_no_suppress_warnings`,
    prefer a real fix; decide in review.
- **Acceptance**: every F-site either (a) uses `tx`, (b) drops an unnecessary wrapper, or
  (c) is explicitly scope-outed (SC1) with a TODO + rationale. NO silent `_tx` rename.

### C-WARN — the two non-fatal WARN fixes (already committed: 77051e6f)

- **Invariant**: `security-doc-exists` and CLI `--tag-secret` WARNs = 0 in pre-pr output.
  Already verified. Kept on this branch as secondary scope.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C-L1 | **PRIMARY**: advisory-lock TOCTOU fix across 4 count-then-create sites | pending |
| C-B | B_RAW_SQL: 9 × `prisma.$` → `tx.$` | pending |
| C-C | C_HELPER_DB: 4 × `db: prisma` → `db: tx` (`db` already `TxOrPrisma`) | pending |
| C-A | A_NESTED_TX: 13 × use outer tx / drop redundant nested-$transaction | pending |
| C-F | F_DELEGATE: 15 × thread-tx (F2, cascade ≤2 callers) / drop static wrapper (F1) / SC1 (F3 only) | pending |
| C-WARN | 2 non-fatal WARN fixes | locked (committed) |

**Contracts are `pending` — Round-1 review reshaped C-L1 (Serializable → advisory lock, 1→4
sites). A Round-2 plan review must confirm the advisory-lock design and the per-site coverage
matrix (T5) before implementation.**

## Site → bucket map (inlines the referenced sites.md; F1 fix)

- **B_RAW_SQL (9)**: audit-chain-verify:143,162,185,208,236; audit-outbox-metrics:66;
  audit-outbox-purge-failed:82; webauthn-authorize:175; directory-sync/engine:183
- **C_HELPER_DB (4)**: emergency-access decline:43, request:52, reject:45; access-requests/deny:73
- **A_NESTED_TX (13)**: passkey reauth/verify:72; passkey/verify:120; emergency-access/[id]/accept:70;
  emergency-access/accept:73; mcp/register:140; scim/Users:133; user/mcp-tokens:88;
  account-lockout:190 (**keep `SET LOCAL lock_timeout` + `FOR UPDATE`** — F7); auth-adapter:275
  (**C-L1 site**); directory-sync/engine:412; oauth-server:168,780; vault-reset:53
- **F_DELEGATE (15)**: emergency-access/[id]/vault:54; Groups/[id]:33,55,117; ResourceTypes:14;
  Schemas:14; ServiceProviderConfig:14 (**F1: static — drop wrapper**); Users/[id]:38,68,138,191;
  auth-adapter:158 (**hybrid A_NESTED+F2**: drop inner $transaction AND thread tx into
  `findOrCreateSsoTenant(pendingClaim, tx)` — 2 callers); tenant-context:23 (F2), 54, 73
  (**F3: `fn(tenantId)` public contract — genuinely unthreadable; honest disposition TBD**)

## Per-site test coverage matrix (T5 fix — honest verification status)

| Cluster | Has test exercising the callback? | Disposition |
|---------|-----------------------------------|-------------|
| tenant-context, oauth-server, vault-reset (via centralize), account-lockout (via tenant-policy) | YES (~4 files) | suite green IS meaningful |
| audit-chain-verify (5 sites), SCIM (11 sites), emergency-access routes, webauthn-authorize, passkey verify, directory-sync engine, mcp/register, user/mcp-tokens | **NO route test drives the callback** | protection is compile-time + `check-bypass-rls` guard ONLY. Add a smoke test for the two largest clusters (audit-chain-verify ×5, SCIM ×11); state the rest as guard-verified-only, not test-verified |
| The 4 C-L1 sites | new I-CL1 integration test (this PR) | behaviorally verified |

## Testing strategy

- **Real-DB parity** (already run once, re-run after edits): the probe seeding 2 tenants and
  comparing `prisma.x` vs `tx.x` count under bypass. Extend to cover a representative site from
  each bucket.
- **Per-site regression**: run the integration/unit tests for each touched route/module.
- **Guard + lint**: `node scripts/checks/check-bypass-rls.mjs` (OK) AND
  `npx eslint . | grep -c "'tx' is defined but never used"` (target: 0, minus any explicitly
  scope-outed F3 sites which must then carry a justified disable + TODO).
- **Full gates**: `npx vitest run` (11,984 tests baseline), `npx next build`, `scripts/pre-pr.sh`.

## Considerations & constraints

### Scope contract
- **SC1** — F3 sites `tenant-context.ts:54,73` (`withTenantRls(prisma, tenantId, (tx) => fn(tenantId))`,
  where `fn` is a caller-supplied `(tenantId) => Promise<T>` taking no client) are **genuinely
  unthreadable** without changing the public `withUserTenantRls`/`withTeamTenantRls` contract.
  Disposition (decide in Round 2): either (a) change the internal callback so `fn` still runs
  inside the tenant tx via ambient Proxy but the wrapper doesn't declare an unused `tx` param
  (the guard requires `(tx)`, so this needs care), or (b) a single narrowly-scoped
  `eslint-disable-next-line` WITH written justification citing the ALS/Proxy contract + a
  `TODO(bypass-rls-tx)`. Prefer (a). NOTE: F2 cascade is NOT large — measured ≤2 callers per
  helper (`fetchScimGroup` 1, `resolveUserId` 4-all-in-one-file, `autoPromoteIfElapsed` 1,
  `findOrCreateSsoTenant` 2), so F2 threading is IN scope; only F3 is deferred here.
- **SC2** — `resource-quotas.ts` count-then-check-then-insert is a **documented pre-1.0
  soft-cap** (its header explicitly accepts overshoot; hard-cap deferred). It is NOT one of the
  4 C-L1 sites and is explicitly out of scope — not a silent exclusion.

### Known risks / latent concerns
- **Advisory-lock ordering / deadlock**: the lock key is `hashtext(userId)` — same key space as
  the 7 existing precedents. Verify no code path takes the lock in a different order or holds
  another advisory lock on the same key within an outer tx (would deadlock). `vault/rotate-key`
  already documents this coordination — confirm the 4 new sites don't nest under it.
- **Behavior-preservation is the bar** for the callback-form buckets (B/C/A/F): every edit must
  be a no-op on observable behavior. C-L1 is the ONE intentional behavior change (closes the
  race) — its tests prove the new behavior.
- **No `_tx` suppression** anywhere (`feedback_no_suppress_warnings`); F3's disable (if chosen)
  is the single documented exception, not a rename.

### Out of scope
- Changing the `check-bypass-rls.mjs` guard, the Proxy, or `withBypassRls`/`withTenantRls`
  signatures. (C-C needs NO signature change — `transition`/`bulkTransition` `db` params are
  already typed `TxOrPrisma`; F4 confirmed.)
- `resource-quotas.ts` soft-cap (SC2). The 2 WARN fixes are done; not re-litigated.
