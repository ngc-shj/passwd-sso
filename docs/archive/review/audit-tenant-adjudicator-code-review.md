# Code Review: audit-tenant-adjudicator

Date: 2026-09-08
Review round: 1
Branch: `fix/audit-tenant-adjudicator`

## Process note

This branch was implemented **inline**, without Phase 1 or Phase 2. There is no
plan file and no deviation log, and no Phase 2 self-R-check was run — so Round 1
was a full Recurring Issue Check, not incremental verification on a baseline.
That absence is the first finding in its own right: the branch's central claim
(*"close the rest of the stale-tenant class"*, commit `2c57f2e6e`) was never
derived, and Round 1 falsified it.

## Changes from Previous Round

Initial review.

## The derivation that decided the round

All three experts fired R42/R3/R17/R49 independently, and each produced a
different count (+5 / ≥13 / 3-of-27). None of those is the member set; they are
three partial greps. The orchestrator ran an AST pass over the defining
primitive — **a `user.findUnique|findFirst` selecting a tenant identity, classified
by the RLS opener it is lexically inside** — across all of `src/`:

| Enclosing context | Sites | Disposition |
|---|---|---|
| `withUserTenantRls` | 13 | **Safe.** `users_tenant_isolation` is `bypass_rls='on' OR tenant_id = app.tenant_id`, so a tenant-scoped read can only return the context's own tenant. RLS enforces the agreement. |
| `withVaultTenantRls` (`tenantId ? withTenantRls : withUserTenantRls`) | 2 | **Safe**, and reported as `(none)` by the pass — the opener is behind a local `const`, which name-matching cannot see. Recorded because the CI guard must resolve bindings scope-aware, not by spelling. |
| the adjudicator itself | 1 | n/a |
| `withBypassRls` / unwrapped | **12** | **Members.** Unconstrained: the stale copy comes back verbatim. |

28 total. The branch closed 4 (which no longer appear as raw reads). **12 remain.**

| # | Site | What the stale value decides |
|---|---|---|
| 1 | `src/app/api/mcp/authorize/consent/route.ts:169` | authz predicate, passkey policy, **the tenant persisted onto the authorization code and thence the access/refresh tokens**, DCR claim + per-tenant cap, 4 audit rows |
| 2 | `src/auth.ts:651` | SSO-tenant sign-in rejection + the audit row's tenant |
| 3 | `src/auth.ts:814` | passkey enforcement state |
| 4 | `src/app/api/auth/passkey/verify/route.ts:101` | SSO-tenant restriction + `Session.tenantId` |
| 5 | `src/app/api/auth/passkey/options/email/route.ts:102` | SSO-tenant gate |
| 6 | `src/lib/auth/session/auth-adapter.ts:102` | `Session.tenantId`, `Account.tenantId`, concurrent-session cap |
| 7 | `src/lib/auth/session/session-timeout.ts:73` | idle + absolute session timeouts |
| 8 | `src/lib/auth/policy/lockout-admin-notify.ts:38` | which tenant's admins are alerted |
| 9 | `src/lib/notification.ts:63` | `Notification.tenantId` |
| 10 | `src/app/api/user/passkey-status/route.ts:35` | passkey enforcement state |
| 11 | `src/app/api/tenant/policy/route.ts:88` | which tenant's policy is displayed |
| 12 | `src/app/[locale]/mcp/authorize/page.tsx:65` | authz comparison |

## Findings

### F1 / S1 / T1 — Critical — the class is not closed (three-way convergence)

Reported independently by all three experts; severity floored to Critical by
perspective convergence. The evidence is the table above. Security escalated its
instance (`escalate: true`) on the ground that an OAuth access/refresh token is
minted bound to a tenant the actor holds no active membership in, reachable by
the branch's own stated production scenario.

**Resolved for member 1** (see Resolution Status). Members 2-12 open — see the
Anti-Deferral entry.

### S1 — Critical — MCP consent left on the stale column while its own pre-filter was moved off it

`/api/mcp/authorize` (GET) only `NextResponse.redirect`s to the consent page;
the POST requires only a session, an `Origin` header and
`requireRecentCurrentAuthMethod`, so skipping the redirect is a normal client
action. Migrating the GET alone created an R48 pair **inside one flow**.

**Resolved.**

### F2 / S4 — Major — a divergence this branch introduced

Before the branch, `recordFailure` and `notifyAdminsOfLockout` both read
`User.tenantId` — consistently wrong, but consistent. Fixing only the caller
split them: the audit row to the membership tenant, the security alert carrying
the locked-out user's email address to a different tenant's OWNER/ADMINs.

**Resolved.** `tenantId` is now a required parameter of `LockoutNotifyParams`,
so the callee has no second adjudicator to fall back to; the type error at every
call site is the mechanism.

### F3 — Major (R29) — the helper's docstring gave a false reason

> *"the sentinel tenant is memberless by invariant, so sentinel actors resolve no membership and reach it by design"*

Both halves false under execution. Sentinel actors (`…000`, `…001`) have **no
`users` row** — queried live, 0 rows — so the helper returns `null` and they
reach `SYSTEM_TENANT_ID` through `resolveTenantId`'s own coalesce, not through
the fallback. And `users_not_system_tenant CHECK (tenant_id <> '…0002')` forbids
the stated mechanism outright.

The conclusion ("the fallback is load-bearing") is true for a *different* case —
a user whose memberships are all deactivated. A false reason under a true
conclusion is live because it licenses the next edit.

**Resolved.** This is the same failure mode PR `#820`'s own body named:
*claims about behaviour held up under measurement; claims about mechanism were
repeatedly false.* It recurred in the very next commit.

### T3 — Minor — a cell asserted half of what its comment claimed

`account-lockout.test.ts`'s adjudicator cell said the resolved id picks the
thresholds tenant **and** the audit row's tenant, and asserted only the first.

**Resolved**, and the first attempt at the fix was itself wrong: it asserted
`logAuditInTx` was *not* called at zero attempts. `VAULT_UNLOCK_FAILED` is
emitted on every failure, so the assertion failed — corrected to assert every
emit's tenant instead, which is the stronger claim.

### F4 / S6 — Minor / Major — the `createdAt asc` tie-break

`orderBy: { createdAt: "asc" }, take: 1` has no secondary key, and `createdAt`
is not a total order (Postgres fixes `CURRENT_TIMESTAMP` per transaction, so two
memberships written in one transaction tie). The three adjudicators disagree on
multi-membership: this one picks the oldest, `resolveUserTenantIdFromClient`
throws, `getTenantMembership` is `findFirst` with no `orderBy` at all.

Security argued the *direction* is wrong — oldest is structurally the tenant the
user may have left — and that `directory-sync/engine.ts:458,504` can reactivate
an old membership without the cross-tenant guard `scim/v2/Users` applies.
Functionality could not ground a reachable second active membership and filed it
as a question.

**Open.** Grouped with the class decision: the tie-break only matters once
multi-membership is reachable, and the honest resolution is a partial unique
index making all three adjudicators agree by construction — a schema decision,
not a helper decision.

### F5 — Minor — no remediation path for rows already misfiled

The fix stops new misfiling and leaves existing rows where they are, including
the emergency-access escrow release that motivated the work. **Open** —
re-filing interacts with the audit hash chain (`audit.ts` already records a
`__system__`/chain-verify false-TAMPER interaction), so it is not free.

### T2 — Minor — the new export has no cell in its own module's test file

`src/lib/tenant-context.test.ts` has a `describe` block for the strict sibling
and none for `resolveOwningTenantIdFromClient`; its query shape is pinned by a
single exact-object assertion in `audit.test.ts`. **Open.**

### T4 — Minor — 151 partial `@/lib/tenant-context` mock factories omit the new export

Verified **latent, not live**: the testing expert isolated the 59 files that mock
the module without `importOriginal` and use the real audit module, ran them (773
tests, no `not a function`), and confirmed `resolveTenantId`'s UUID branch is
never reached there today. **Open.**

## Adjacent Findings

- `[Adjacent] Major` (Functionality) — `src/app/[locale]/mcp/authorize/page.tsx:64-70`
  uses the stale column as an authorization comparison. Routed to Security;
  became member 12.
- `[Adjacent] Major` (Testing) — the three unfixed members it found are
  correctness/tenancy defects, not test defects. Routed to Functionality/Security.

## Quality Warnings

None. Every finding cited a file:line the orchestrator re-opened, and the three
expert counts were superseded by the AST derivation rather than adopted.

The one seed finding pair was disposed of by the Testing expert as **Rejected ×2**,
both with reproducing evidence:
- the `take: 1`/`orderBy` shape *is* pinned (`audit.test.ts:542-551` asserts the
  select object literally) — the seed's "no test would catch it" does not reproduce;
- the EA-vault route contains no `user.findUnique` at all (`grep -n findUnique`
  returns only `emergencyAccessGrant.findUnique`), so the seed's premise is false.

## Recurring Issue Check

### Functionality expert
R1 pass · R2 n/a · **R3 F1** · **R4 F2** · R5 pass · R6 n/a · R7 n/a · R8 n/a ·
R9 pass · R10 pass · R11 n/a · R12 n/a · R13 pass · R14 n/a · R15 n/a · R16 n/a ·
**R17 F1** · R18 n/a · R19 pass · R20 pass · R21 pass · **R22 F1** · R23 n/a ·
R24 n/a · R25 pass · R26 n/a · R27 n/a · R28 n/a · **R29 F3** · R30 n/a ·
R31 pass · R32 n/a · R33 n/a · **R34 F1/F2** · R35 pass · R36 pass · R37 n/a ·
R38 pass · R39 n/a · R40 pass · R41 pass · **R42 F1** · R43 pass · R44 n/a ·
R45 n/a · R46 n/a · R47 pass · **R48 F2** · **R49 F1** · R50 partial→F1 ·
R51 pass · **R52 →F1** · R53 n/a · R54 pass · R55 pass · R56 n/a · **R57 F4**

### Security expert
R1 clean · R2 clean · **R3 fires** · **R4 fires (S4)** · R5 clean · R6 n/a ·
R7 n/a · R8 n/a · R9 clean · R10 clean · R11 n/a · R12 n/a · R13 clean ·
R14 clean · R15 n/a · R16 n/a · **R17 fires** · R18 n/a · R19 adjacent ·
R20 clean · R21 n/a · R22 clean · R23 n/a · R24 n/a · **R25 fires (S5)** ·
R26 n/a · R27 n/a · R28 n/a · R29 clean · R30 n/a · R31 n/a · R32 n/a ·
R33 n/a · **R34 fires** · R35 adjacent · R36 clean · R37 clean · R38 clean ·
R39 n/a · R40 clean · R41 n/a · **R42 fires — Critical** · **R43 fires** ·
R44 n/a · R45 n/a · R46 n/a · R47 clean · **R48 fires — Critical** ·
**R49 fires** · R50 clean (but silent on unenumerated members) · R51 clean ·
**R52 fires (S1)** · R53 n/a · R54 clean · R55 clean · R56 n/a · **R57 fires (S6)** ·
RS1 n/a · RS2 n/a · RS3 clean · RS4 clean · RS5 n/a · RS6 n/a

### Testing expert
**R3 T1** · R4-R16 n/a · **R17 T1** · R18 n/a · R19 checked, latent→T4 ·
R20-R28 n/a · R29 applied · R30-R41 n/a · **R42 T1** · R43-R48 n/a · **R49 T1** ·
R50 checked · R51-R57 n/a · RT1 clean · RT2 clean · **RT6 T2** ·
RT3 clean · RT4 n/a · RT5 clean · **RT7 clean for the cells, fires for the absent guard → T1** ·
RT8 n/a · RT9 clean (no twin drift) · **RT10 partial → T3** · RT11 clean

RT11 was verified rather than assumed: `TenantMember.user` is `onDelete: Cascade`
(`schema.prisma:641`), so a re-pointed membership cannot block the user delete in
either order, and both new cells clean up on the failure path.

## Environment Verification Report

N/A — no `Verification environment constraints` were declared in Phase 1, because
there was no Phase 1. The one standing repo constraint (VC2: integration tests
cannot share a database with the compose workers) was observed: workers stopped
before each integration run and restarted after.

## Resolution Status

### S1 [Critical] MCP consent bound the token and the passkey gate to the stale column
- Action: `consent/route.ts:167` resolves through `resolveOwningTenantIdFromClient`.
  The comment states why this handler — not the GET — is the boundary.
- New cell: `consent/route.test.ts` — "binds the token and the passkey gate to
  the active membership". Asserts `derivePasskeyState` **and**
  `createAuthorizationCode` both receive the membership tenant, with a positive
  `status === 302` first so a handler that 403'd cannot pass by not reaching them.
- Red-proved against `main` in an isolated worktree.

### F2/S4 [Major] the lockout divergence this branch created
- Action: `tenantId` added to `LockoutNotifyParams` as **required**;
  `lockout-admin-notify.ts` no longer selects or reads `tenantId`;
  `account-lockout.ts:366` threads its own `resolvedTenantId` and is guarded on
  the same `if (resolvedTenantId)` boundary the audit emits use.
- Boundary: with no resolvable tenant there is no admin set, so the alert is
  skipped rather than sent somewhere — matching the audit rows two blocks above.
- New cell: "looks the admins up in the CALLER's tenant, not the user's column",
  with `expect(mockSendEmail).toHaveBeenCalledTimes(1)` as the allow half so a
  fix that merely stopped notifying would not pass.
- The obsolete "does nothing when user has no tenantId" cell was replaced by
  "does nothing when the user row is absent" — the tenant can no longer be
  missing, and `{ tenantId: null }` was never a state the FK permitted.
- Red-proved against `main`.

### F3 [Major] false rationale in the helper docstring
- Action: `tenant-context.ts` — the fallback's reason restated as the
  all-deactivated user, with the sentinel path described where it actually runs
  and the reason the correction is recorded rather than silently swapped.

### T3 [Minor] the cell asserted half its stated contract
- Action: the adjudicator cell now asserts every `logAuditInTx` call's tenant,
  and a second cell at threshold−1 covers the lockout row.

### Anti-Deferral — members 2-12 of the class, and the CI guard

- **What is deferred:** eleven of the twelve derived members, and the
  mutation-verified CI guard that Step 3-8 makes the termination artifact for a
  class whose member set expanded ≥2× (1 → 2 → 4 → 16).
- **Worst case:** for members 2-7 the stale id selects an authentication or
  session control — the SSO-tenant sign-in restriction, passkey enforcement,
  session idle/absolute timeouts, the concurrent-session cap — so a user in the
  divergent state is governed by a tenant they hold no active membership in. For
  8-12 it misfiles rows or displays another tenant's policy.
- **Likelihood:** the divergent state requires a user deactivated in tenant A and
  then SCIM-provisioned into B. Reachable by design of `scim/v2/Users`, not by an
  attacker acting alone — it needs a SCIM token holder or tenant admin in B.
- **Cost to fix:** members 8-12 are the same substitution already applied (low).
  Members 2-7 are not: five of them traverse `user.tenant.*` as a relation rather
  than reading `tenantId`, so the fix restructures the query, and three sit on
  auth gates where changing which tenant's `isBootstrap` governs a sign-in is a
  behaviour change requiring its own test matrix.
- **Why not now:** deferred to a user scope decision, not skipped. Presented with
  the derivation above rather than as a count.

---

# Round 2

Date: 2026-09-08

## Changes from Previous Round

Round 1's twelve-member derivation was closed (commit `8c96f8434`) behind
`check-owning-tenant-adjudicator.mjs`. Round 2 reviewed that closure — and
converged on the convergence artifact itself.

## The shape of this round

Round 1's findings were about the code. Round 2's are about **the gate and the
tests written to prove the code**, plus one about the premise the whole branch
was justified by. That is the same failure mode PR `#820` named and round 1
repeated: claims about behaviour held; claims about mechanism did not.

## Findings

### F8 / F1 / Q4 — Major, three-way convergence — the gate was blind to four read shapes

All three experts red-proved it independently on synthetic roots. A Prisma read
with **no `select`** returns every scalar, `tenantId` included, and
`selectsTenantIdentity` answered `false` for it — so the completeness half, the
half the header credits with stopping the class growing silently, never fired.
`include:`, `findMany` and the `*OrThrow` variants were the same. One of the
blind shapes was already in the tree (`api/scim/v2/Users/route.ts:133`).

**Resolved.** The predicate now fails CLOSED: an absent or non-inline projection
is the BROADEST shape, not an exempt one. `usesHelper` requires a call rather
than any identifier — an unused import satisfied the `adjudicator` disposition
while a raw read sat beside it. Cost of the widening: one manifest entry.
Nine new self-test cells, one per shape rather than one loop, so a single
spelling cannot regress behind another.

### Q5 — Major — the local-wrapper resolver was fail-open at depth two

A wrapper delegating to another wrapper that opens a bypass resolved SAFE: its
own text named a tenant opener and never named `withBypassRls`. The unused `seen`
parameter was the tell — the cycle guard existed before the recursion did.

**Resolved.** Reachability is transitive, and bypass-reachability is checked
BEFORE tenant-reachability, which is the ordering the first attempt got wrong
(it returned SAFE from the tenant-opener branch before the bypass was seen).

### F7 — Major (R29) — the producer cited throughout the branch is unreachable

The SCIM create path cannot produce the divergence: its cross-tenant arm sits
below a lookup inside `withTenantRls`, so a user belonging to another tenant is
invisible and control reaches `user.create`, which dies on `User.email @unique`.
`directory-sync/engine.ts` has the same shape. The one writer that moves the
column moves the membership with it. Divergent population on the dev database: 0.

**Resolved as a correction, not as a fix**: every site now states what was
measured and says plainly that this is prophylaxis. The value of one adjudicator
is that writer and reader cannot disagree *however* a divergence arises; it does
not rest on a producer. A second copy of the sentinel claim round 1 had already
corrected once was found still standing in the integration test, and corrected.

### F2 / S6 — Major — reactivation creates a second active membership, with no guard

`api/scim/v2/Users` guards CREATE against a cross-tenant active membership. The
REACTIVATION arms did not: `scim-user-service`'s PUT and PATCH, and
`directory-sync/engine.ts`'s two arms. The principal is a holder of *this*
tenant's SCIM token or directory-sync config — no authority in the tenant the
user belongs to. Two active memberships makes `resolveUserTenantIdFromClient`
throw, and the proxy auth gate calls it on every request, so the effect is that
one tenant can invalidate every session of another tenant's user.

**Resolved.** `wouldCreateSecondActiveMembership` (single) and
`usersActiveInAnotherTenant` (batch, for the sync) guard all four arms. Both must
run OUTSIDE a tenant context — the foreign row is what RLS hides inside one, and
opening a bypass inside one is refused by the nesting guard — so the SCIM routes
resolve the user id in one context, guard, then mutate in a second. Sequential
contexts are permitted; nested are not.

Two design notes worth keeping:
- The predicate is one `findMany` over the ACTIVE set, not the `findUnique` +
  `findFirst` pair it reads like. The callers sequence their own
  `tenantMember.findUnique` mocks, and an extra call shifted every one of them —
  a query shape chosen so the guard cannot perturb the thing it guards.
- The guard is on the TRANSITION. A deactivating request is never refused: it
  cannot add an active membership, and it is the operation that repairs the state.

### F10 — Major — `tenant/policy` GET re-resolved a tenant it was already holding

`requireTenantPermission`'s return value was discarded and the tenant resolved a
second time, through an adjudicator with different rules (`getTenantMembership`
is `findFirst` with no `orderBy` and no fallback). PUT already wrote to
`membership.tenantId`. **Resolved** — GET now reads the tenant the request was
admitted to. The gate's reverse-direction check then fired correctly: the file no
longer resolves a user's tenant at all, so its manifest entry was removed.

### F9 — Major — the two passkey routes disagreed on an arm this change made live

Splitting the relation traversal into two reads made `tenant === null` reachable.
`passkey/verify` rejects it; `passkey/options/email` **allowed** it — returning
the credential list and PRF salts pre-auth on a state sign-in refuses — while its
own comment asserted the two agree. **Resolved**: options/email rejects, matching
its sibling.

The cell that existed for that arm could not see the change: the route has TWO
`webAuthnCredential.findMany` sites behind one mock (the real list and the dummy
list), so `toHaveBeenCalled()` passed on either path. Rewritten to assert the
argument, with an allow half.

### Q2 — Critical — an authorization decision with no test at all

`app/[locale]/mcp/authorize/page.tsx`'s tenant-mismatch check had zero coverage;
the only test in that directory covers the client component. **Resolved** — four
cells, including the one that discriminates (client tenant = the STALE column's
must be refused). Red-proved against `main`.

### Q3 / T2 — Major — the helper had no cell in its own test file

Thirteen call sites depended on `resolveOwningTenantIdFromClient` and its arms
were pinned nowhere; its query shape was asserted only from a caller's test.
**Resolved** — eight cells beside its strict sibling, covering precedence, the
fallback's actual population, the null arm, the not-throwing property that is its
whole reason to exist beside `resolveUserTenantIdFromClient`, and the query shape.

### Q7 / Q8 — Minor — two defects in round 1's own test fixes

Q7: the lockout-audit cell loops over every `logAuditInTx` call, so it stays green
if the row it is named for stops being emitted. Q8: the two new lockout cells
resolve a tenant whose thresholds are never invalidated between cells.

### Q1 — Critical — STILL OPEN at the time of writing

Measured by mutation: reverting the resolver body leaves 15402 of 15415 tests
green. 28 of 33 reshaped fixtures use the SAME id for the column and the
membership, so they cannot tell the two sources apart. Being addressed.

### F6 — Critical, conditional — "tenant-scoped = safe" covers misfiling, not denial

The 13 constrained sites are safe against *misfiling* because RLS returns
nothing — which for a divergent user means their own row is invisible to their
own request, and each route takes its not-found arm. Inherited, not introduced,
and live only if the divergence is producible — which F7 measured it is not.
Recorded rather than fixed, with that dependency stated.

### F3 / F5 — Major/Minor — forward-only, no backfill

Rows already stamped with a stale tenant are not repaired. Divergent population
on the dev database is 0, so there is nothing to repair there; the check must run
where it matters. Open.

### F11, F12, F4, Q6, Q9, Q10 — Minor

Allowlist accounting drift; two hot paths reading the same row twice; a stale
premise in a fail-closed comment; twin drift in two test pairs; the helper's
select asserted from a caller's test (closed by Q3); a fail-closed stance
inconsistency between the two `src/auth.ts` blocks. See round 3 below.

## Round 3

Recorded here rather than only in commit messages: a commit message is not the
artifact a later round reads.

### S5 — Major — the gate was narrower than the class its header describes

`check-owning-tenant-adjudicator` required the read to be issued on
`prisma.user`, so `tenantMember.findFirst({ select: { user: { select: {
tenantId: true } } } })` — the same stale copy through a relation — was invisible
to it. The third time a gate here has been narrower than its own declaration.
**Resolved**: projection keys resolve against `prisma/schema.prisma` with the
receiver's model in hand, by declared TYPE (16 field names in this schema are
`User`, and `createdBy` is one of them on some models and a `String` on another).
Measured on landing — the same 16 files as the pass it replaced, manifest
untouched, no relation-reached read in the tree today. Seven mutations.

### F15 — Major — a refusal reported as a successful sync

A refused reactivation still stamps `lastScimSyncedAt`, so it landed in
`usersUpdated` and the run closed SUCCESS with no audit event: the IdP admin saw
a working sync and only the user noticed. **Resolved**: `usersRefused` counted
apart from the writes that happened, carried on the sync log row and on the
result, plus `DIRECTORY_SYNC_ACTIVATION_REFUSED` per declined membership —
carrying no identifier of the other tenant, which this tenant's admins must not
learn from their own audit trail.

### F17 — Minor — the preview predicted a run that would not happen

The dry run resolved no cross-tenant guard, so it promised reactivations the real
run would refuse. **Resolved**: same guard (a read; the preview still writes
nothing), same refusal count. The one case it cannot see is a toCreate user
already ACTIVE here as well as elsewhere — a second active membership
`tenant_members_one_active_per_user` now forbids.

### F11 / Q6 — Minor — the finding was half wrong, and the other half was a class

F11 said `notification.ts` still permitted a `user` read it had moved into the
adjudicator. FALSE as stated: it hands `tx` to that adjudicator, so the model IS
reached under its bypass and the entry is accurate — the gate simply cannot see
across the module boundary. **Resolved** as a class instead: `check-bypass-rls`
now fails an entry permitting a model nothing reaches, exempting files whose
analysis was defeated. Six genuinely stale allowances removed. Q6's "38 call
sites today" measured 24; the count is printed per run rather than frozen in
prose.

### F4 / Q10 / the `src/auth.ts` stance inconsistency — Minor

**Resolved together**, all three being one shape: the undecidable tenant read as
a verdict. The magic-link gate ADMITTED a sign-in when the tenant row was absent
(`existingUser?.tenant && !isBootstrap` is false either way) while
`createSession` calls the identical state corruption and throws; the MCP consent
page resolved nothing on the DCR arm and rendered a consent the authoritative
POST then 403s; and auth-adapter's fail-closed comment still justified itself by
`User.tenantId`'s FK, which stopped being where the id comes from.

### F12 — Minor — NOT fixed, deliberately

`src/auth.ts` and `session-timeout.ts` each read the same `users` row twice: once
inside the adjudicator, once for their own extra fields (`fetchFavicons`,
`teamMemberships`). The obvious remedy — a `select` parameter on the shared
adjudicator — trades a single-purpose helper for one whose projection every
caller can widen, which is the shape this whole branch exists to undo. In
`auth.ts` the two reads are inside one `Promise.all`, so the cost is a query and
not a round trip; in `session-timeout.ts` it is one extra round trip on a cached
path. Left as is, recorded rather than silently dropped.

## Environment Verification Report

N/A — no Phase 1. VC2 (integration tests cannot share a database with the compose
workers) observed on every integration run.

## Round 4

Date: 2026-09-12. Subject: `0f1d75ae9..HEAD` (6 commits) composed with rounds 2-3.

PROCESS DEVIATION, stated rather than hidden: the local LLM was unavailable (HTTP
400, then a 10-minute timeout on seed generation), so all three experts ran
full-diff review with no seed, and `merge-findings` could not run — the merge below
is manual, from the three experts' JSON finding indexes joined on file + line ±5 and
root cause. No raw per-expert files were kept: they exist to feed `merge-findings`,
and with it down this section is the artifact.

Every Major below was independently re-verified by the orchestrator before being
recorded — by opening the cited path or running the cited mutation — because a
sub-agent's count and a sub-agent's rationale are both retrofittable (R29). Two
sub-agent sub-claims did NOT survive that check and are corrected in place.

### Converged across experts (severity floored by convergence)

**C1 — Major — the realignment's only record is best-effort, under a rationale that
is false for this call shape.** (Security + Functionality, independently.)
`src/auth.ts`'s `SignInTenantResult.realigned` docblock says the fact is carried out
of the transaction because emitting inside would nest `logAuditAsync` →
`resolveTenantId` → `withBypassRls`. Verified false: `resolveTenantId` returns on its
first line when `params.tenantId` is set, and the emit sets it. The real constraint is
`refuseIfInsideRlsContext`, whose own docstring names `logAuditInTx` as the in-context
path. Conclusion right, reason wrong — and the wrong reason closed off the option that
would make the record atomic with the tenancy move it reports. The design decision
stakes option 3 entirely on that record existing.

**C2 — Major — `USER_TENANT_REALIGNED` files a User id under `targetType: TenantMember`.**
(Security Minor + Functionality Major; convergence floors it at Major.) Every other
emitter uses the membership row id, including this same diff's directory-sync refusal
(`targetId: r.memberId`). An operator joining `audit_logs.target_id` to
`tenant_members.id` resolves nothing, for the one event the design note makes their
only handle on the stranded data.

**C3 — Minor (R29) — three numbers for one quantity.** The gate header says 17
`User`-typed field names; measured with the gate's own parser it is **16** (42
declarations). The self-test comment says 15, describing a fixture that declares 3.
The 17 came from a session measurement whose regex matched `model` on the
`model User {` line through a newline-spanning `\s`, and was then written into the
gate header, a commit message, and this document. The `createdBy` half of the sentence
(User on seven models, String on `TenantClaim`) does hold.

### Security findings

**S1 — Major — the realignment makes a cross-tenant destructive path reachable, and
falsifies the recoverability the decision rests on.** `vault-reset.ts`'s
`executeVaultReset` deletes `passwordEntry` / `tag` / `folder` / `vaultKey` /
`attachment` / `passwordShare` by `userId` / `createdById` under `withBypassRls` with
**no tenant predicate**. Before the realign, `reset-vault/route.ts` could not resolve
the target (its `include: { user: … }` runs under `withTenantRls(actor)` and the users
row was invisible), so the admin-reset chain could not start in the joining tenant.
After it, it can — and it destroys the rows this branch just counted in the releasing
tenant. `…-design.md`'s "intact … reversible at any later date" and
`tenant-context.ts`'s docstring hold only until an ordinary authorized operation runs.
ORCHESTRATOR NOTE on the proposed remedy: scoping `executeVaultReset` by tenant is NOT
obviously right — it would null the key material on the users row while leaving the
ciphertext in the other tenant, which is unrecoverable AND undetectable. The expert's
own alternative (refuse the *initiate* when rows are stranded, surfacing the counts the
new event already computes) preserves both properties.

**S2 — Major — the RLS blindness moves to the releasing tenant, which is told nothing.**
`api/tenant/members/route.ts` selects `user` as a required to-one under
`withTenantRls(actor.tenantId)` with **no `deactivatedAt` filter**, then dereferences
`m.user.name`. After the realign the releasing tenant keeps a deactivated membership
whose users row now lives elsewhere, so that tenant's entire member list fails — not
just that row. The only event emitted is filed under the JOINING tenant. "F6 is closed
by this" was derived over one reader (the user's own requests); the class has a second,
the former tenant's admin surface. The tree already owns the remedy for the read half:
`team-member-display.ts`'s `buildTeamMemberDisplayItems` exists for exactly this shape
and this route does not use it.

**S3 — Minor — `previousTenantId` reaches the joining tenant's admins under a reason
that does not hold.** The event is in `AUDIT_ACTION_GROUPS_TENANT` and
`tenant/audit-logs` returns `metadata` verbatim. "The only one that can act" is false:
that tenant can read nothing filed under the other, and the design note itself records
that no tooling to move a user between tenants exists. Question that closes it: is a
tenant UUID non-sensitive across tenants in this threat model?

**S4 — Minor — the dry run is a non-mutating cross-tenant membership oracle.**
Pre-existing rather than new: `scim/v2/Users` already returns 409 "User already belongs
to another organization" without mutating. Both sites are the member set if it is closed.

### Functionality findings

**U1 — Major — the new over-breadth check skips its widest member, under a false
reason, and three stale entries are live today.** `check-bypass-rls.mjs`'s
`if (!reached) continue; // no bypass call at all: Check 1's business` — Check 1 fires
only in the forward direction (a file calling the helper with no entry). An entry whose
file calls `withBypassRls` **zero** times is checked by nothing. Verified live:
`api/mcp/token/route.ts`, `workers/audit-anchor-publisher.ts`,
`api/maintenance/dcr-cleanup/route.ts` — all three contain zero occurrences of the
helper, and the gate prints OK. The sibling adjudicator gate implements this direction
correctly. Same defect class the check was written to close, in the check itself.

**U2 — Major — the realignment fires on one branch only, and a second producer is
uncovered.** `realignOwningTenantColumn` is called only under `existingTenantId === null`.
A divergent user's NEXT sign-in reaches row 5 (already a member of the claimed tenant),
which upserts and returns with no column read — the sign-in best placed to repair the
state passes through it. Separately, `scim-user-service.ts`'s `replaceScimUser` clears
`deactivatedAt` writing only `tenantMember` and the mapping, never the users row; both
new guards filter `deactivatedAt: null` and therefore clear a user with no active
membership anywhere. CORRECTION to the expert's sub-claim: the realign does NOT leave a
deactivated membership in the joining tenant — it creates an ACTIVE one. The producer is
reachable without the realign; it is a pre-existing member of the class this branch
enumerated, not one this commit creates.

**U3 — Major — `leftBehind` counts three of the user-owned tenant-scoped tables, so a
zero triple reads as "nothing stranded".** Models carrying both `userId` and `tenantId`
number 21; besides the three counted the realign strands `Account`, `Session`,
`ExtensionToken`, `VaultKey`, `Notification`, `ApiKey`, `WebAuthnCredential`, the three
MCP token models, `DelegationSession`, `TeamMemberKey`, `TeamPasswordFavorite`. One has
a verified user-visible consequence the "empty vault" framing does not cover:
`api/webauthn/credentials/route.ts` lists passkeys under `withUserTenantRls` (the NEW
tenant) while `passkey-enforcement.ts` counts them under a bypass by `userId` alone — so
a realigned user is told they have a passkey, sees none, and cannot manage them. Two
readers of one fact disagree, the defect this same diff cites as its reason for changing
the consent page.

### Testing findings

**T1 — Major — the third refusal producer has no cell.** Three sites increment
`usersRefused`; the `toCreate` loop's `else if (existing.deactivatedAt && pu.active)`
arm is untested — deleting its two lines leaves `engine.test.ts` at 25 passed. That arm
is the literal one F15's own narrative describes.

**T2 — Major — the preview's `toCreate` refusal clause is untested.** Replacing the whole
`toCreate.filter(…).length +` term with `0 +` leaves the suite green: every dry-run
fixture seeds a SCIM mapping, so all users land in `toUpdate`. With T1, the refusal for
an unmapped-but-existing deactivated member is unmeasured in both the preview and the run.

**T3 — Major — the reporting chain F15 exists for can be severed at the route and nothing
reds.** Orchestrator-verified by mutation: deleting `usersRefused: true` from
`api/directory-sync/[id]/logs/route.ts`'s select leaves the route test and the card test at
15 passed / 0 failed. The route's `makeLogs()` fixture never carried the field, and the
card renders on `log.usersRefused > 0` — `undefined > 0` is false, so the counter vanishes
from the operator's screen silently. `next build` cannot catch it: the fixture is a local
untyped helper and the response is untyped JSON.

**T4 — Major — the privacy assertion is vacuous and its positive half unpinned.**
`expect(JSON.stringify(emitted)).not.toContain("tenant-other")` — that literal appears
exactly once in the file, on that line, and `usersActiveInAnotherTenant` selects only
`{ userId, user: { email } }`, so no foreign tenant id can enter the engine. The assertion
is satisfied by the absence of a value the fixture never had. The other half is unmeasured
too: `metadata: {}` leaves the suite green.

**T5 — Minor — the name-keyed rationale in the self-test is false under a true conclusion.**
Mutating `type === "User"` to `key === "user"` leaves the self-test at 39 passed — the
`owner` fixture is still caught by the generic non-User relation descent. The cell only
reds under a name-keying that ALSO misclassifies the User-typed field as a scalar.

**T6/T7/T8 — Minor** — `actorType` ternary untested (collapsing it leaves 25 passed); the
card's conditional render untested (flipping the predicate leaves 5 passed); the new
`DIRECTORY_SYNC_RUN` metadata field untested (deleting it leaves 13 passed).

### Adjacent findings

- [Security → Functionality] the dry-run refusal count re-derives the apply-phase
  predicate in a second place. The expert's attached claim that
  `tenant_members_one_active_per_user` "does not exist yet" is WRONG — migration
  `20260909120000` on this branch creates it. Corrected here.
- [Testing → Security] the refusal metadata carries the member's email into
  `audit_logs.metadata`, a tenant-readable sink. The comment block reasons about
  withholding the other tenant's identity and says nothing about this.

### Recurring Issue Check

#### Functionality expert
R1 checked · R2 n/a · **R3 → U2** · R4 checked · R5 checked · R6 n/a · R7 n/a · R8 checked · **R9 → C1** · R10 n/a · R11 checked · R12 checked · R13 n/a · R14 n/a · R15 n/a · R16 n/a · R17 checked · **R18 → U1** · R19 checked · R20 checked · R21 n/a · R22 checked · R23 n/a · R24 checked · R25 n/a · R26 n/a · R27 n/a · R28 n/a · **R29 → C1, C3** · R30 n/a · R31 n/a · R32 n/a · R33 n/a · R34 checked · R35 n/a · R36 checked · R37 checked · R38 n/a · R39 n/a · R40 checked · R41 n/a · **R42 → U3, U1** · **R43 checked — no widening found** · R44 n/a · R45 checked · R46 checked · R47 checked · **R48 checked, but see U3** · **R49 → U1** · R50 checked · R51 n/a · R52 checked · R53 n/a · R54 checked · R55 n/a · R56 n/a · R57 checked

#### Security expert
R1 **fires (S2)** · R2 clean · R3 clean · **R4 fires (S2)** · R5 clean · R6 n/a · R7 n/a · R8 n/a · **R9 fires (C1)** · R10 n/a · R11 clean · R12 clean · R13 n/a · R14 n/a · R15 clean · R16 n/a · R17 clean · R18 checked clean · R19 clean · R20 clean · R21 n/a · R22 clean · R23 n/a · R24 clean · **R25 fires (S2)** · R26 n/a · R27 n/a · R28 n/a · **R29 fires (C1, S3)** · R30 n/a · **R31 fires (S1)** · R32 n/a · R33 n/a · R34 n/a · R35 n/a · R36 clean · R37 clean · R38 clean · R39 n/a · R40 clean · R41 clean · **R42 partial → S2** · **R43 fires (S1)** · R44 clean · R45 clean · R46 clean · R47 clean · **R48 fires (S3, adjacent)** · **R49 fires (S1)** · R50 clean · R51 clean · **R52 fires (S1)** · R53 n/a · R54 clean · R55 clean · R56 n/a · R57 clean · RS1 n/a · RS2 n/a · RS3 clean · RS4 clean · **RS5 fires — folded into S1/S2** · RS6 n/a

#### Testing expert
R1 not triggered · R2 not triggered · **R3 → T3, T8** · R4 not triggered · R5 not triggered · R6 n/a · R7 n/a · R8 not triggered · R9 not triggered · R10 n/a · R11 clean · R12 clean · R13 n/a · R14 n/a · R15 n/a · R16 clean · R17 n/a · R18 clean · **R19 → T3** · R20 n/a · R21 n/a · R22 n/a · R23 n/a · R24 n/a · R25 n/a · R26 n/a · R27 n/a · R28 n/a · **R29 → C3, T5** · R30 n/a · R31 n/a · R32 n/a · R33 n/a · R34 n/a · R35 n/a · R36 n/a · R37 n/a · R38 n/a · R39 n/a · **R40 adjacent to T3** · R41 n/a · **R42 → T1** · R43 not triggered · R44 clean · R45 n/a · R46 n/a · R47 n/a · R48 clean · R49 n/a · R50 clean · R51 n/a · R52 n/a · R53 n/a · R54 n/a · R55 n/a · R56 n/a · R57 n/a · **RT1 → T3** · RT2 n/a · RT3 n/a · RT4 n/a · RT5 clean · RT6 n/a · **RT7 partial → T1, T2, T7** · **RT8 → T4** · RT9 clean · RT10 clean · RT11 clean

Of the 22 mutation red-proof claims made in round 3's fixes, the Testing expert re-ran
every one; 21 reproduced exactly and one over-delivered (3 reds where 1 was claimed).
One claimed 34 measured 33 under a narrower mutation shape; all four target cells were
red either way.

### Resolution Status — round 4

Closed so far, by commit:

- **C1, C2, U3** — `review(4): make the realignment's record atomic, addressed, and complete`.
- **S2 (read half), T3** — `review(4): stop the realignment breaking the releasing tenant's member list`.
  The report half of S2 (a row for the releasing tenant) landed with C1.
- **S1** — `review(4): refuse an admin vault reset that would destroy rows outside its tenant`.
- **T1, T2, T4, T6, T7, T8, C3, T5** — `review(4): pin the refusal chain end to end, and correct the stale figures`.
- **U1** — `review(4): fail an allowlist entry whose file no longer bypasses at all`.

Open: U2 — now carrying the S2 class re-derived below (18 reachable sites) and its
CI guard — plus S3 and S4.

#### T1, T2, T4, T6, T7, T8 — the refusal chain, pinned end to end

- T1: the unmapped-user-with-a-deactivated-membership arm has a refusal cell and a
  paired allow cell (the guard clears it and it reactivates).
- T2: the preview's `toCreate` clause has a cell, and the `pu.active` conjunct a
  zero cell.
- T4: the reviewer's remedy — make the guard's mocked row carry a foreign tenant id
  so `not.toContain` can fail — is not implementable: `usersActiveInAnotherTenant`
  maps rows to `{ ids, emails }`, so a tenant id in the fixture never reaches the
  engine either. The vacuous assertion was replaced by EQUALITY on the emitted
  metadata, which fails on any added key, a foreign tenant id included.
- T6: the scheduled-run arm of the refusal emit's actor ternary has a cell.
- T7: the card's conditional render has a cell with one refused row and one clean
  row. The logs button is icon-only with no accessible name, so the cell finds it
  by its icon; that button's missing label is a pre-existing accessibility gap,
  not changed here.
- T8: the run route's audit fixture carries a non-zero `usersRefused`.
- Red proof, one mutation per clause, each asserted to have applied: the arm stops
  counting; the refused arm reactivates anyway; the preview's `toCreate` clause
  neutralised; the `pu.active` conjunct dropped; a foreign tenant id added to the
  metadata; the metadata emptied; the actor always HUMAN; the run route drops the
  field; the render predicate forced true, then false. Each reddened exactly the
  cell that names it. (A first run of five of these reported no red at all — the
  mutations had not applied. The rerun asserts an occurrence count before running.)

#### C3, T5 — figures and a rationale

The gate header now says 16 (42 declarations) and no longer freezes the read
count; the self-test comment names what the `owner` cell actually discriminates
(a pass that treats a User-typed field not spelled `user` as opaque) instead of a
name-keyed pass that its generic relation descent still defeats.

#### U1 Major — the over-breadth check skipped an entry whose file bypasses nothing

- Action: `check-bypass-rls` now fails an ALLOWED_USAGE entry whose file makes no
  `withBypassRls` call. Not judged, each stated in the gate: `["*"]` definitions;
  files this run could not parse; files absent from the scanned tree (the
  self-test's fixture trees), whose existence a real-repo self-test cell asserts
  instead; and files that set `app.bypass_rls` through raw SQL, a real bypass this
  gate cannot see and `check-raw-sql-usage` requires to be allowlisted with a
  purpose.
- CORRECTION to the finding's member set: of the three entries it named,
  `workers/audit-anchor-publisher.ts` is not stale — it bypasses three times through
  raw `set_config`. Measured over all 96 entries, five name a file with no
  `withBypassRls` call: the `["*"]` definition, two raw-SQL bypasses
  (`audit-outbox.ts`, `audit-anchor-publisher.ts`), and two genuinely dead entries
  (`api/mcp/token/route.ts`, `api/maintenance/dcr-cleanup/route.ts`), which are
  removed. The gate exited 1 naming exactly those two before they were.
- One pre-existing self-test cell changed verdict: a file whose call was removed
  while its entry remained was expected to pass. It parses, and it must still not
  be reported unparseable — that assertion stays — but it is a stale entry, and the
  cell now expects it reported as one.
- Red proof: stale entries never reported (two cells red); raw-SQL exemption
  removed (one); absent files judged (99 red — the skip is load-bearing on fixture
  trees); a bogus entry added (the existence cell red).

#### S2 re-derived — the class was 18, not 1

S2 was fixed at `api/tenant/members` without deriving its member set. Derived from
the schema — a read whose projection reaches a REQUIRED to-one `User` relation —
there are 33 such reads (a positive control found 2 of 2); counting writes that
return the relation (`update`, `create`) adds four more. Under
`users_tenant_isolation` a tenant context cannot see a user whose owning-tenant
column names another tenant.

What that does was MEASURED, not assumed — a throwaway integration test, app role,
tenant A context, a deactivated membership in A for a user owned by B:

- `include` of the required `user` relation, via `findMany` and via `findUnique`:
  the membership row comes back with `user: null`. Prisma does NOT throw.
- a relation filter (`where: { user: { is: { … } } }`): the row is silently
  excluded.
- the `users` row itself: `null`.

So the failure is never the query. It is the null a non-null type promised: a
server-side dereference that takes the whole response down (the member list, the
reset history, the revoke notification, the share-link page, SCIM Groups, the
directory-sync load phase); a null handed to the client (operator tokens, service
accounts, break-glass, team invitations and history); or a silent omission (the
SCIM user list's email filter). Earlier text in this document and in several code
comments said the relation "fails the query"; that mechanism was never observed and
is corrected here and in the comments.

- Safe: 9 under a bypass; 1 reading the caller's own row; 5 restricted to active
  memberships, which hold an aligned column once U2's producers are closed.
- Reachable: 18. Every one references a user the realignment has moved out of the
  tenant doing the reading — a departed member, creator, initiator or changer.
  - Tenant context (11): the SCIM user list, `fetchScimUser`,
    `deactivateScimUser`, the reset revoke notification, the directory-sync load
    phase, the reset history's initiator, operator tokens, service accounts (list
    and detail), and break-glass (list and logs).
  - Team context (7): SCIM Groups (route twice, service once), team password
    creators and updaters (twice), team password history, team invitations. These
    were reachable before this branch too, through team guests from another primary
    tenant — `buildTeamMemberDisplayItems` exists for exactly that and these reads
    do not use it.
- Correction to the round-3 statement that S2's class was introduced by the
  realignment: it was not. Before it, a divergent user (column B, active membership
  A) broke the same reads in tenant A; the realignment moves the breakage to the
  tenant the user left.
- Correction to the classification above: `share-links/mine` was counted as
  reading the caller's own row. In the team context it lists every member's shares,
  so it is a reachable team-context read like the others.

##### Resolution — the members a route owns

- Action: operator tokens, service accounts (list; detail GET and PUT), break-glass
  (list and logs), the reset history, the reset revoke notification, team
  invitations, team password history and `share-links/mine` no longer read the
  user relation inside the tenant or team context. They keep the foreign key and
  hydrate it after the context closes through `fetchUserDisplayMap`
  (`CROSS_TENANT_LOOKUP`). A row that does not come back yields
  `{ id, name: null, email: null }` (`displayUserOf` / `displayIdentityOf`), so each
  response keeps its shape instead of carrying a null its type rules out. The
  revoke notification reads the target's contact through `fetchUserContact`, and
  only when a membership row in this tenant exists.
- Constraint that shapes the rest: `withBypassRls` refuses to open inside an RLS
  context, so hydration can only run after the context closes. The members still
  open — the SCIM user and group reads, the directory-sync load phase, team
  password creators and updaters — run inside a context a service owns, so each
  needs its own restructuring and lands separately.
- Tests: a cell per route for an identity that does not come back and for the
  absence of the relation in the context-scoped query, in both test trees where a
  module has two. Several existing cells were vacuous: their fixtures omitted the
  foreign-key column, so hydration never ran and nothing checked the identity
  (team invitations, service accounts).
- Red proof, on worktree copies: removing the placeholder failed the ten id-only
  cells plus two existing cells whose fixture ids miss the lookup; re-adding the
  relation to each query and dropping the revoke membership gate failed exactly the
  twelve cells written for them; swapping the bypass purpose failed the eight
  purpose cells.

#### S1 Major — admin vault reset destroyed rows outside the authorizing tenant

- Action: an admin-authorized reset is refused while the target still owns
  personal vault rows under any tenant other than the one that authorized it.
  One predicate (`countVaultRowsOutsideTenant` in `vault-reset.ts`), asked in three
  positions: at initiate, before the rate limiters count the attempt (the target
  limiter allows one a day); at execute, before the one-shot token is spent; and
  authoritatively inside `executeVaultReset`'s deleting transaction, after the
  user row is locked, so a concurrent realignment is serialized against it.
  Refusal deletes nothing and returns `VAULT_RESET_DATA_OUTSIDE_TENANT` (409).
- The expert's remedy — scope the delete to the authorizing tenant — was not
  taken: it nulls the key material on the users row while leaving the ciphertext
  under the other tenant, which is unrecoverable and undetectable. That is worse
  than the defect.
- Team-side rows are outside the predicate (`teamMemberKey`, and attachments or
  shares on a team entry): a guest in another tenant's team holds those under
  that team's tenant by design, and counting them would refuse an ordinary reset.
  The docstring's claim that admin resets "may cross tenant boundaries within the
  same team" was stale — the only `adminVaultReset.create` writes `teamId: null`.
- The owner's own reset (`/api/vault/reset`) stays unscoped. Its authority is the
  owner's over their own rows, it was reachable for a divergent user before this
  branch (so not a widening), and refusing it would be a false deny on the
  last-resort recovery path with no operator tooling to lift it.
- Two regressions the fix introduced, recorded because the tests for the changed
  modules stayed green through both. The full suite caught each only through a
  gate self-test that runs against the real repo. (The S1 commit message says
  "every unit test stayed green" — that overstates it: it describes the targeted
  run, not the full suite.)
  1. Moving the destructive body into a non-exported helper behind a differently
     named wrapper declassified `/api/vault/admin-reset`:
     `check-permanent-delete-stepup` exited 1 (`STALE_EXEMPT`) and
     `check-destructive-wrapper-derivation` reported `executeVaultReset` stale.
     The body stays in `executeVaultReset`, under the name `deleteSignal` lists.
  2. Nesting the atomic-audit descriptor inside an options object made both
     `VAULT_RESET_EXECUTED` and `ADMIN_VAULT_RESET_EXECUTE` read as non-atomic:
     `check-critical-audit-atomic` exited 1. The descriptor stays a direct
     argument; only the scope and the test hook are options.
- Red proof, one mutation per clause, each run in a detached worktree: in-tx check
  removed; check always refuses; team-entry attachments counted; check asked
  before the row lock; execute pre-check removed; catch arm removed; catch maps
  every failure to 409; execute route stops passing the scope; owner's reset
  becomes scoped; initiate pre-check removed; initiate pre-check moved after the
  limiters; descriptor nested (audit gate exits 1); call renamed (step-up gate
  exits 1). Each reddened the cell or gate that names it.

### New findings raised while fixing S1

**N1 — Major (question) — a personal vault reset deletes attachments and shares on
TEAM entries.** `executeVaultReset` deletes `attachment` and `passwordShare` by
`createdById` with no `teamPasswordEntryId` predicate, and
`collectAttachmentRefsByCreator` selects `teamPasswordEntryId` and purges those
blobs too. A team member resetting their own vault therefore removes attachments
every other member of that team reads. Pre-existing, and not changed here because
it alters what a vault reset destroys. Question that closes it: are a member's
uploads to a team entry theirs to take with them, or the team's to keep?

**N2 — Major — `check-destructive-wrapper-derivation` drops a destructive
primitive whose enclosing function is not exported.** Its resolver walks from the
primitive to the source-file root looking for an exported function and returns
nothing when there is none, so `UNDECLARED_DESTRUCTIVE_WRAPPER` never fires.
Measured during the S1 fix: an exported `executeTenantScopedVaultReset` wrapping a
non-exported helper that held every `deleteMany` produced no UNDECLARED line; the
only report was STALE, and only because `executeVaultReset` was already a listed
name. A new wrapper over a private destructive helper would pass silently, and a
route calling it would escape step-up classification.

**N3 — Minor — `check-critical-audit-atomic` credits a descriptor without checking
where it goes.** Case (2) scans the object-literal arguments of every call for
`{ params: { action } }` and counts the action as atomic, with no check that the
callee enqueues it via `logAuditInTx`. Its comment says the helper does; the gate
does not verify that (R49). Question that closes it: should case (2) be limited to
a declared set of helpers known to enqueue in-transaction?
