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
| 2 | `src/auth.ts` — the `signIn` callback's SSO-tenant check | SSO-tenant sign-in rejection + the audit row's tenant |
| 3 | `src/auth.ts` — the session callback's passkey-enforcement read | passkey enforcement state |
| 4 | `src/app/api/auth/passkey/verify/route.ts:101` | SSO-tenant restriction + `Session.tenantId` |
| 5 | `src/app/api/auth/passkey/options/email/route.ts:102` | SSO-tenant gate |
| 6 | `src/lib/auth/session/auth-adapter.ts:102` | `Session.tenantId`, `Account.tenantId`, concurrent-session cap |
| 7 | `src/lib/auth/session/session-timeout.ts:73` | idle + absolute session timeouts |
| 8 | `src/lib/auth/policy/lockout-admin-notify.ts:38` | which tenant's admins are alerted |
| 9 | `src/lib/notification.ts:63` | `Notification.tenantId` |
| 10 | `src/app/api/user/passkey-status/route.ts:35` | passkey enforcement state |
| 11 | `src/app/api/tenant/policy/route.ts:88` | which tenant's policy is displayed |
| 12 | `src/app/[locale]/mcp/authorize/page.tsx` — the client-tenant comparison | authz comparison |

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
user may have left — and that the two reactivation arms of `src/lib/directory-sync/engine.ts` could reactivate
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

- `[Adjacent] Major` (Functionality) — `src/app/[locale]/mcp/authorize/page.tsx` (the
  client-tenant comparison) used the stale column as an authorization comparison. Routed to Security;
  became member 12.
- `[Adjacent] Major` (Testing) — the three unfixed members it found are
  correctness/tenancy defects, not test defects. Routed to Functionality/Security.

## Quality Warnings

None. Every finding cited a file:line the orchestrator re-opened, and the three
expert counts were superseded by the AST derivation rather than adopted.

The one seed finding pair was disposed of by the Testing expert as **Rejected ×2**,
both with reproducing evidence:
- the `take: 1`/`orderBy` shape *is* pinned (the "resolves tenantId from user when only userId is
  provided" cell in `src/lib/audit/audit.test.ts` asserts the select object literally) — the seed's "no test would catch it" does not reproduce;
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
- Action: `src/app/api/mcp/authorize/consent/route.ts` resolves through `resolveOwningTenantIdFromClient`.
  The comment states why this handler — not the GET — is the boundary.
- New cell: `consent/route.test.ts` — "binds the token and the passkey gate to
  the active membership". Asserts `derivePasskeyState` **and**
  `createAuthorizationCode` both receive the membership tenant, with a positive
  `status === 302` first so a handler that 403'd cannot pass by not reaching them.
- Red-proved against `main` in an isolated worktree.

### F2/S4 [Major] the lockout divergence this branch created
- Action: `tenantId` added to `LockoutNotifyParams` as **required**;
  `lockout-admin-notify.ts` no longer selects or reads `tenantId`;
  `recordFailure` in `src/lib/auth/policy/account-lockout.ts` threads its own `resolvedTenantId` and is guarded on
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
blind shapes was already in the tree (the SCIM Users list's `tenantMember.findMany` with `include: { user }` in
`src/app/api/scim/v2/Users/route.ts`).

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

##### Resolution — team password creators and updaters

- Action: `listTeamPasswords` and `getTeamPassword` no longer include `createdBy` or
  `updatedBy`; they return the two ids, and the list and detail routes hydrate them
  after `withTeamTenantRls` closes, in the same response shape (creator with image,
  updater without).
- Red proof: re-adding both relations to the service's includes failed the two new
  route cells; swapping the bypass purpose failed the same two.

##### Resolution — SCIM Groups

- Action: the three member reads — the list's batch query, the create response's
  `loadGroupMembers`, and `loadGroupMembers` in scim-group-service behind GET, PUT
  and PATCH — now require an active membership in the authenticated tenant,
  written as a relation filter. This is the remedy decided for this member rather
  than hydration: a team guest from another primary tenant is not this IdP's user,
  and hydrating would hand their email to it. The filter is evaluated through the
  users relation itself, so a row whose user RLS hides is excluded before anything
  reads its email; the dereference that failed the whole group cannot be reached.
- What it still depends on: an active member here whose owning column is stale is
  excluded too, silently, until the column is realigned. Closing the producers of
  that state is U2.
- Red proof: removing the predicate from the service failed the service cell and
  the `[id]` GET cell; removing it from the route's two queries failed the list and
  create cells.

##### Resolution — SCIM users

- Action: `fetchScimUser` is split. `loadScimUserSnapshot` reads the membership
  half in the tenant context, with no user relation; `toScimUserResource` joins
  identity through `fetchUserDisplayMap` after the context closes, and GET, PUT and
  PATCH build their resource there. `replaceScimUser` and `patchScimUser` return
  the snapshot. DELETE reads the email it records through `fetchUserContact` after
  the context, and `deactivateScimUser` no longer selects the user.
- The list is the exception. Its meaning is a filter through the users relation —
  `userName` is the email, and a user without one is not listed — so hydrating
  afterwards would change `totalResults` and paging. It reads under a bypass
  (`CROSS_TENANT_LOOKUP`) instead, every condition ANDed under the token's tenant so
  no filter can widen it, and the route's allowlist entry now names `tenantMember`
  and `scimExternalMapping` beside `user`, with that reason.
- Two PUT cells had passed because the old code answered an empty resource read with
  `scimResponse(null)` and a 200: they mocked no third read. They mock it now, and a
  snapshot missing after a successful write is a 404.
- Red proof, two worktree copies: dropping the tenant pin from the list, re-adding
  the relation to the snapshot read and dropping DELETE's contact read failed the
  four cells written for them; re-adding the relation to the deactivate read and
  swapping the bypass purpose failed the deactivate cell, the DELETE cell and the
  two purpose cells.

##### Found while resolving — directory sync cannot reach its cross-tenant arms

Measured on the real database (app role, tenant A context) for a user owned by
tenant B with an active membership there:

- the create path's prefetch, `tx.user.findMany` by email, returns `[]`;
- the `tx.user.create` that follows fails with P2002 on `users_email_key`;
- the name sync, `tx.user.update` on that user, fails with P2025.

Each throws inside the apply transaction, so the run rolls back and reports ERROR.
The round-3 refusal arms for exactly this user — create the membership deactivated,
count and audit the refusal — were reachable only in unit cells whose mocked
`tx.user.findMany` returned a row the database never would. The load phase fails
before either, dereferencing `member.user.name`.

#### U2 — the producers that activate a membership without moving the column

- Action, part 1 — one mechanism. The realignment and its two-tenant record move
  out of `src/auth.ts` into `src/lib/tenant/tenant-realignment.ts`:
  `realignToMembershipInTx` for a caller already inside a bypass, and
  `realignAfterActivation` for a producer that activated inside a TENANT context,
  which cannot write a users row filed under another tenant. The second opens its
  own bypass after that context commits — so the move is not atomic with the
  activation, which is accepted — and follows the membership only while it is
  still active in the tenant named, so a deactivation landing in between is not
  undone.
- Action, part 2 — sign-in row 5. "Already a member of the claimed tenant" is
  answered from the active membership, so a user reactivated by SCIM or directory
  sync while their column named another tenant reached that arm with the divergence
  row 4 repairs, and nothing moved it. Row 5 now realigns after its upsert; when the
  column already agrees it is one read and no write.
- Red proof: dropping the row 5 call, the active-only predicate and the releasing
  tenant's row failed the row 5 cell, the module's two cells, and the two auth
  cells that assert both rows (row 4 and the end-to-end sign-in).
- Still open at this point: SCIM provisioning and reactivation, and directory sync —
  each needs its producer-side fix before it can call `realignAfterActivation`.

##### Resolution — directory sync (its S2 member, its U2 producer, and the finding above)

- Action: the load phase reads members without the user relation and, in the same
  context, reads only the users that context can see. The diff and the name sync
  consider a name only for those, so a member filed under another tenant keeps the
  name that tenant holds and still has their status applied. The create path
  resolves existing users by email before the context opens
  (`existingUserIdsByEmail`, a bypass read in tenant-context.ts, whose allowlist
  entry now names `user`), so an existing user is given a membership rather than a
  duplicate `user.create`. After the commit, every member the run activated whose
  users row already existed goes through `realignAfterActivation`; a failure there
  is logged and does not turn a committed run into an ERROR.
- Integration cells (real database, app role): a user active in another tenant gets
  a deactivated membership and one refusal, and no second users row; a user active
  nowhere is activated, their column moves to the syncing tenant, and
  `USER_TENANT_REALIGNED` is enqueued for both tenants; a mapped member filed under
  another tenant is synced without their name being touched. Run against the
  previous commit — the engine without this fix — all three fail, each on a run
  that reported `success: false`.
- Unit red proof, two worktree copies: restoring the relation in the load phase,
  dropping the visibility conjunct from the diff, emptying the email lookup and
  removing the catch around the realignment failed nine cells; renaming
  unconditionally and dropping the reactivation's realignment failed three.
- Found while writing those cells: `deleteTestData` did not remove
  `scim_external_mappings`, whose tenant FK is RESTRICT, so any integration test
  that lets directory sync or a SCIM route write a mapping leaked its tenant. Two
  runs leaked four tenants onto the shared dev database; they were swept through
  `trackTenant` and `cleanup`, and `deleteTestData` now removes the mappings.

##### Resolution — SCIM provisioning and reactivation

- Action: SCIM POST gives the membership to the user its guard already resolved
  under a bypass, instead of repeating the lookup inside the tenant context. That
  lookup could not see a user filed under another tenant, so the create collided on
  the global email index and the route answered 409 "A user with this email already
  exists" for a user active nowhere, whom the guard above it had just cleared. POST
  realigns an existing user it provisioned ACTIVE, and PUT and PATCH realign on
  `SCIM_USER_REACTIVATE`, each after the tenant context commits; a failure is
  logged, not answered as a failed request whose membership already committed. The
  created resource is read back through `toScimUserResource`. With the in-context
  `user.findUnique` gone, the route no longer reads a user's tenant identity at all,
  so its `check-owning-tenant-adjudicator` manifest entry was removed — the gate's
  staleness check, run in pre-pr, is what reported it.
- Red proof, two worktree copies: dropping the three realignment calls failed the
  two POST cells, the PUT and PATCH reactivation cells, and the failure-logging
  cell; always creating the user and realigning on every transition failed the six
  existing-user POST cells and the two cells asserting no realignment on a
  deactivation or a name-only PATCH.
- U2 is closed with this: every producer that activates a membership — sign-in rows
  4 and 5, SCIM POST/PUT/PATCH, directory sync — now moves the owning column.

#### The CI guard for S2's class — `check-required-user-relation`

- What it enforces: a Prisma call whose projection (`select` / `include`, followed
  through nested relations) or whose `where` (through `AND`/`OR`/`NOT` and
  `is`/`some`/`every`/`none`) reaches a REQUIRED to-one `User` relation, and that is
  not enclosed — in its own file, directly or through a local wrapper — by
  `withBypassRls`. Row-returning writes, counts and bulk writes are covered with
  reads. Anything else fails closed, because a service function has no opener of
  its own and runs in whatever context its caller opened; the class had members in
  three services.
- Exceptions are per file with a disposition, a reason and the NUMBER of calls they
  cover, so a call added to a listed file fails instead of being excused by an entry
  written for another — the per-file hole `check-bypass-rls` names in its own header.
  Today: ten calls restricted to ACTIVE memberships (which the realignment keeps
  aligned), the service-account create returning its own creator, and
  `vault-auto-promote`, whose only caller opens the bypass. A stale entry fails.
- Stated limits, in the header: `where` spreads are not followed (a projection
  spread fails closed), computed keys are skipped, raw SQL and clients obtained from
  calls are not seen, and context is decided per file.
- Red proof: on the real tree, restoring `createdBy` to the operator-token list and
  withdrawing the SCIM group service's entry failed the gate naming both; in the
  self-test, counting optional relations, never trusting a bypass and dropping the
  count check failed the five cells written for them. Wired into `pre-pr.sh` beside
  `check-owning-tenant-adjudicator`.

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

## Round 5

Date: 2026-09-13
Review round: 5 (incremental, over the round-4 resolution commits `a557a6415..75c4acea5`)

### Changes from Previous Round

Round 4's findings were resolved in ten commits: the S2 class hydrated, restricted or
read under a pinned bypass; U2 closed across every membership-activating producer; the
directory-sync engine made able to reach users filed under another tenant; and a CI guard
for the class. The three experts verified those resolutions and raised five Major and
eight Minor findings, one of them (S1) a boundary widening this round's own fixes created.

### Converged across experts (severity floored by convergence)

- **S3 / T2 — Major — `check-required-user-relation` resolves wrapper names file-wide.**
  Security red-proved sibling-scope shadowing (`const run` in two functions); Testing
  red-proved a shadowing parameter and a wrapper that opens a bypass for another read and
  then runs `fn` outside it. The name-based resolver is copied from
  `check-owning-tenant-adjudicator`, which shares the defect.

### Security findings

- **S1 — Major (R43) — SCIM POST and directory sync can attach an active membership to,
  and realign, an existing user filed under another tenant.** At `a557a6415` the in-context
  lookup could not see such a user, so SCIM answered 409 and directory sync rolled back; no
  non-sign-in producer could attach a foreign user. This round's fixes removed that accident
  without adding the authority it stood in for: the only predicate left is
  `wouldCreateSecondActiveMembership`, which enforces uniqueness, not authority. Option 3 in
  the design note covers a user signing in through a new tenant's IdP — the user's own act —
  and not provisioning. Attack: a tenant A SCIM token (or an A admin controlling its
  directory's email attribute) names a user B released; the user resolves to A, their column
  moves, B's IdP cannot reclaim them, their sign-in through B is refused, and A's policies and
  admins act on them. Directory sync's refusal arm also let A plant a dormant membership on a
  user still active in B and capture them when B suspends them.
- **S2 — Minor — `USER_TENANT_REALIGNED` names the moved user as actor when SCIM or directory
  sync caused the move**, so the releasing tenant cannot tell a sign-in elsewhere from another
  tenant's provisioning.

### Functionality findings

- **F1 — Minor (R48) — directory sync's email lookup matches case-insensitively across every
  tenant and keeps an arbitrary row among case variants**, while SCIM POST decides the same
  question with an exact lookup.
- **F2 — Minor — post-commit identity reads can fail the response to a committed SCIM write;**
  DELETE's contact read throwing skips `SCIM_USER_DELETE`'s audit.
- **F3 — Minor — the engine's name-sync visibility is read in the load context and used in the
  apply transaction;** a user moved out in between makes `user.update` throw P2025 and roll
  the run back.
- **F4 — Minor — the SCIM POST guard refuses an `active: false` provision** for a user active
  elsewhere, unlike PUT and directory sync.
- **F5 — Minor, [Adjacent] (R43) — the bypass allowlist entry for tenant-context.ts gained
  `user` at per-file granularity.**

### Testing findings

- **T1 — Major, [Adjacent] (R43) — the SCIM list's externalId mapping `findMany`, now under a
  bypass, has no cell pinning its tenant;** removing `tenantId` from it stayed green.
- **T3 — Major (R49) — the gate does not follow an identifier or shorthand `where`, nor a
  `where` nested in an `include`/`select` relation or `_count`,** although its header and this
  document claim counts are covered. On `a557a6415` the S2 member
  `tenantMember.count({ where: prismaWhere })` was not reported. Six such calls exist today, all
  filtering on scalar or foreign-key columns.
- **T4 — Major (RT1) — three SCIM claims rest on mocked database behaviour:** the Groups
  relation filter (`tenantMemberships.some`) excluding a hidden guest, the list under a bypass
  including a departed member while excluding another tenant's, and the POST path for a user
  filed elsewhere.
- **T5 — Minor — the POST realign-failure cell does not assert the log.**
- **T6 — Minor — the reset-vault history hydration has no bypass-purpose cell.**

### Adjacent Findings

F5 (Functionality → Security) and T1 (Testing → Security): routed to the S1/T1 fixes below.

### Recurring Issue Check

Each expert's full check is preserved in the round's working files; the findings above are the
rows each marked as found: Functionality R5 (F3), R18 (F5), R34 (F4), R43 (F5), R48 (F1, F4),
R51 (F3); Security R43 (S1), R46/R47/R49 (S3); Testing R1/R46/RT10 (T2), R43 (T1), R49 (T3),
RT1 (T4). All other rows checked with no issue or not applicable.

### Resolution Status — round 5

#### S1 Major — a producer that does not authenticate the user attaches an existing user only if this tenant owns them (with F1, F4, F5 and T4)

- Action: `resolveExistingUsersForTenant` (tenant-context.ts) classifies each email
  that names an existing user as `owned` — the owning tenant, by the same
  `owningTenantOf` rule `resolveOwningTenantIdFromClient` now calls, is this tenant —
  `foreign` (with whether a membership row already exists here) or `ambiguous`
  (more than one case variant). SCIM POST refuses a foreign user before any tenant
  write: "User is managed by another organization", or the existing-member 409 when
  a membership row is already here, which the IdP's GET/PATCH fallback handles.
  Directory sync declines a foreign user with no membership here and an ambiguous
  match: it writes no membership and no mapping, counts a refusal, and audits it
  against the sync config with a `reason`; the dry-run preview declines the same
  users. A foreign user who already holds a membership row here is reactivated as
  before, which is also PUT's and PATCH's existing behaviour. Joining a new tenant
  stays the user's own act, through that tenant's IdP (sign-in row 4). The round-3
  refusal arm that created a DEACTIVATED membership — the plant Security described —
  is gone with it.
- What it rules out, stated as the cost: SCIM and directory sync can no longer
  provision a user another tenant released until that user signs in through this
  tenant's IdP.
- F1: every case variant counts, and more than one is refused rather than guessed.
- F4: SCIM POST's second-active-membership guard now applies only to an active
  provision, as PUT's does.
- F5: no narrowing. `tenant-context.ts` keeps `user` because the ownership read lives
  beside the owning-tenant rule it applies; the entry's comment names the function
  and why it must see other tenants' users — to refuse them. The SCIM Users route's
  `user` permission was stale after the move and was removed (the gate's
  over-breadth check reported it).
- Directory sync's refusal audit display strings (en/ja) now name both reasons.
- Unit red proof, worktree copy: SCIM POST treating a foreign user as owned failed
  its three refusal cells; the engine never declining failed the four decline cells
  (dry run and audit included); the ownership rule ignoring active memberships failed
  four ownership cells.
- T4 — `scim-cross-tenant-users.integration.test.ts` (real database, app role; only
  token validation mocked): a SCIM group excludes a team guest filed under another
  tenant and reports its own member; the list shows this tenant's departed member in
  `Resources` and `totalResults` and no other tenant's member; POST refuses a user
  another tenant released, attaches a user this tenant owns, and creates a new one.
  The directory-sync integration cells were inverted to the same rule, with an
  attach-own cell added.
- Integration red proof: all ten cells green; against the previous commit the two
  directory-sync decline cells and the POST refusal failed; with the Groups predicate
  removed and the list back in the tenant context, the group cell and the
  departed-member list cell failed.

#### S3 / T2 Major — both tenant gates resolve context by scope, not by spelling

- Action: the scope-aware name resolution `check-bypass-rls` had already earned
  (`scopeOf`, `bindingIndex`, innermost visible binding) moved unchanged into
  `scripts/checks/lib/scope-bindings.mjs`; that gate imports it, and its 101
  self-test cells and real-tree run are unchanged. A new
  `scripts/checks/lib/rls-context.mjs` answers, for both tenant gates, which RLS
  context encloses a call: the NEAREST enclosing call that opens one around the
  argument the call is in. A local name resolves to its innermost visible
  declaration; only when none is visible does an import answer, by its original
  name. A local wrapper opens a context only if it passes that argument's parameter
  into an opener; a parameter, a `let`, or a wrapper that also runs the callback
  outside its opener is UNKNOWN, which neither gate reads as the context it needs.
  `check-required-user-relation` exempts only BYPASS; `check-owning-tenant-adjudicator`
  accepts only TENANT.
- Red proof: the new self-test cells — sibling-scope same-named wrappers, a
  shadowing parameter, a callback run outside the opener, an aliased import in
  both directions — all fail against the previous commit's gates. Corrected in
  round 6 (T5): the measured figure is 17 failed of 72 across the two files, not
  sixteen, and not every failure is a deny cell. Two allow cells fail against the
  old gates because those gates over-blocked: "trusts the bypass opener imported
  under another name" and "accepts a dynamic-where exception whose count matches".
  A third cell, "scans both branches of a conditional where, and passes when both
  filter on scalars", checks both a deny and an allow.

#### T3 Major — the required-User gate reads a `where` given by name, by conditional, and nested

- Action: a `where` given as a name or shorthand is followed to the `const` object
  literal bound at the call, provided nothing in the file assigns into, deletes
  from, or `Object.assign`s onto it; both branches of a conditional are scanned;
  the `where` of a nested relation inside a projection and inside `_count.select`
  is scanned. What it still cannot read is reported as `<unreadable-where>` when
  the model declares a required User relation. Paths now name the `where`
  (`TenantMember.where.user<filter>`). The header's coverage and limits were
  rewritten to match, and the round-4 statement above that "counts … are covered
  with reads" is corrected by this entry: before it, a count's `where` was covered
  only when written inline.
- Measured on the real tree: the widened gate reported seven calls. Conditional
  branches resolved four (team-password favorites ×2, WebAuthn options, blob
  cleanup) with no exception. Three `where`s are assembled at run time and received
  a new, explicitly weaker disposition, `dynamic-where`, whose reason names every
  key the builder can set: `share-links/mine` and `share-links` GET (scalar columns
  and a non-User relation), and the WebAuthn verifier, whose `buildWhere` return
  type admits only scalar columns.

#### S2 Minor — a realignment names who caused it, and which producer

- Action: `realignToMembershipInTx` and `realignAfterActivation` take a required
  `RealignmentCause` — `source` (`sign_in` / `scim` / `directory_sync`), the acting
  user id and actor type — and both `USER_TENANT_REALIGNED` rows record that actor
  and `source`. The joined tenant's row also carries `movedUserId`; the releasing
  tenant's row already targets the user id and still names no tenant. Sign-in passes
  `realignmentBySignIn(userId)`, which records exactly what was recorded before.
  SCIM POST, PUT and PATCH pass the token's audit user and actor type; directory
  sync passes the run's actor, or the system actor for a scheduled run.
- Red proof, worktree copy: the emitter recording the moved user as actor failed two
  realignment cells; the engine's actor ternary collapsed to HUMAN failed the
  scheduled-run cell; PUT/PATCH passing the moved user as actor failed both
  reactivation cells.
- Found while fixing: the three producers' test mocks replaced the realignment
  module with only `realignAfterActivation`, so the new `REALIGNMENT_SOURCE`
  constant was undefined, building the cause threw, and the producers'
  realign-failure `catch` logged it — the cells failed only as "called 0 times".
  The mocks now spread the real module.

#### F2 Minor — a committed SCIM DELETE is always audited

- Action: DELETE's post-commit email read is caught and logged
  (`scim.delete-contact-read-failed`); the audit records `email: null` and the
  response stays 204.
- PUT/PATCH: no change, by decision. Their audit row is written before the resource
  read, so a failing read costs only the response. A 500 there is answered by the
  IdP retrying an idempotent PUT/PATCH, which converges on the same state; a null
  resource means the user row is gone, and 404 is the truthful answer for it.
- Red proof: the read left unguarded failed the new cell.

#### F3 Minor — the name sync cannot abort a run

- Action: the engine renames through `tx.user.updateMany`. A user moved out of the
  tenant between the load and the apply is a row RLS hides; `update` threw P2025
  and rolled back the run, `updateMany` renames nobody and the member's status
  still applies. The two hidden-member cells now assert on `updateMany`, which the
  rename actually calls — asserting on `update` could no longer fail.
- Red proof: `update` restored failed the new moved-out cell and the OWNER rename cell.

#### T1 Major — the SCIM list's mapping read is pinned to the token's tenant

- Action: a cell asserts the whole `scimExternalMapping.findMany` argument,
  `tenantId` included.
- Red proof: `tenantId` removed from the read failed it.

#### T6 Minor — the reset-vault history hydration's bypass purpose has a cell

- Action: the test's `withBypassRls` mock is hoisted, and a cell asserts the
  initiator hydration reads the initiator id under `CROSS_TENANT_LOOKUP`.
- Red proof: the purpose changed to `AUDIT_WRITE` failed it.

#### Round 5 verification

- Unit: 1033 files / 15610 tests pass; `next build` passes; `scripts/pre-pr.sh`
  passes on the committed tree.
- Integration (real database, app role, both compose workers stopped for the run):
  113 files / 682 tests pass.
- Citation gate over this document: the round-1 inventory rows and four later
  citations named lines that this branch's edits moved; they now name their
  subject (function, cell or call) instead of a line.

## Round 6

Reviewed range: `75c4acea5..ccf0cbbc9` (the round-5 fix commits). The three experts'
raw outputs, including their full Recurring Issue Checks, are kept in the round's
working files.

### Changes from Previous Round

Round 5's fixes were verified as correct for what they claimed: the ownership rule
for attachment, scope-aware context resolution, the realignment cause, the SCIM
DELETE audit, and the name sync. Every red proof in the round-5 entries reproduced
except the S3/T2 count (T5). Round 6 found one widening that a round-5 fix
introduced (R6-S1), and a producer path that round 5's rule left open (R6-S2).

### Converged across experts (severity floored by convergence)

- **R6-S3 / F1 — Major, convergent: security+functionality (R49/R47).**
  `rls-context.mjs` returns an imported opener's context whatever argument the
  node is in. A read in `withTenantRls`'s tenant argument, or in `withBypassRls`'s
  client or purpose argument, runs before the context opens but is classified as
  inside it. Both tenant gates therefore fail open for that shape. The defect
  predates round 5, and no call site in `src` has this shape today.
- **R6-S4 / F4 — Major (floored from Minor), convergent: security+functionality.**
  SCIM POST's refusals give separate 409 details for "another tenant owns this
  user" and "case-variant duplicate", which makes an email-existence oracle across
  tenants. Directory sync's declined-attachment rows record the internal id of a
  user this tenant has no relation to.

### Security findings

- **R6-S1 — Major (R43, introduced by round-5 S2).** The releasing tenant's
  `USER_TENANT_REALIGNED` row now carries the joining tenant's SCIM-token creator
  or sync admin as the actor. The tenant audit log, its download and the tenant
  webhooks all hydrate or deliver that id, so tenant B sees tenant A's admin's name
  and email. The comment's claim that the cause "names no tenant" is false.
- **R6-S2 — Major (continuing round-5 S1).** A foreign user who still holds a
  deactivated membership row here is reactivated, and then realigned, by SCIM
  PUT/PATCH and by both of directory sync's reactivation arms. The only check on
  that path is a uniqueness predicate, not ownership. Scenario: a user moves from
  A to B by signing in; B suspends them; A's sync or a PATCH with `active:true`
  takes them back to A.

### Functionality findings

- **F2 — Minor (R46, introduced by round-5 T3).** `filterLiterals` resolves the
  identifiers nested inside a followed `const where` at the call site, not where
  they are written. A same-named local at the call site therefore hides the real
  filter, and the gate misses it.
- **F3 — Minor (R12).** The `USER_TENANT_REALIGNED` label reads "on sign-in"
  (en and ja), although the row now records `scim` or `directory_sync` as its
  source, and no reader displays that source.

### Testing findings

- **T1 — Major (R16/RT1).** CI's integration job connects the application
  singleton as the `postgres` superuser. RLS is therefore off in CI for the cells
  that claim "the app role, RLS in force"; locally `.env` names `passwd_app`.
- **T2 — Major (RT7/RT10).** Each of the following fail-open mutations survives
  the gates' self-tests:
  - the `rls-context` UNKNOWN branches: destructured or rest parameter, the
    recursion guard, an unresolvable local binding;
  - `filterLiterals` ignoring a `delete` or an `Object.assign`, or dropping a
    conditional's unreadable branch;
  - `<unreadable-where>` inside a logical operator, a relation filter, or a nested
    relation.
- **T3 — Major (RT7).** Directory sync's ambiguous-email decline (apply-phase
  reason, no attach, dry run) has no engine cell.
- **T4 — Minor.** The SCIM integration refusal cell cannot tell an ownership
  refusal apart from a `users_email_key` P2002, which also returns 409.
- **T5 — Minor (R29).** The S3/T2 red-proof figure is wrong. Against the previous
  gates, 17 cells fail, and two of them are allow cells.
- **T6 — Minor.** A required-User manifest disposition is not tied to the kind of
  hit it excuses: a `dynamic-where` entry also excuses a projection hit.

### Resolution Status — round 6

#### R6-S2 Major — reactivation needs ownership too (with R6-S4 / F4, T3, T4)

- Action: `usersOwnedByAnotherTenant(tenantId, userIds)` in
  `src/lib/tenant-context.ts` applies the same `owningTenantOf` rule, keyed by user
  id, under a cross-tenant bypass.
  - SCIM PUT and PATCH ask it in `reactivationRefusal`, after the existing
    second-active-membership check and before any tenant write.
  - Directory sync asks it for the mapped members the IdP would reactivate. For
    the create arm, `existingUsers` classifying the user as `foreign` is already
    that answer.
  - Both arms refuse with reason `owned_by_another_tenant`, stamp the sync time,
    and do not realign. The dry run counts the same refusals.
  - Deactivation is never asked: it cannot take a user from anyone.
- The way back, stated as the cost: a member who left for another tenant returns
  by signing in through this tenant's IdP (sign-in row 4 moves the column here).
  After that this tenant owns them and SCIM or sync can reactivate them.
  Alternatives considered: trusting a membership row older than the other
  tenant's is the same uniqueness-for-authority substitution S1 named; and a
  deactivated row carries no evidence of who is entitled to the user.
- R6-S4 / F4: every existing user SCIM POST may not attach gets one 409 detail,
  `SCIM_USER_NOT_PROVISIONABLE_DETAIL` — another tenant's user, a departed member
  another tenant owns, or case-variant duplicates. The detail the PUT/PATCH
  refusal returns is the same constant. Directory sync's declined-attachment rows
  record `userId: null`. A refusal on a membership row here keeps the ids, which
  are this tenant's own data. Whether an email exists at all (201 against 409)
  remains S4's open question.
- T3: engine cells for the ambiguous decline, live and dry run. T4: the SCIM
  integration refusal cell also asserts the detail, so a `users_email_key` 409
  cannot pass it.
- Unit red proof, in a worktree copy. Each mutation failed exactly its own cells:

  | Mutation | Cells that failed |
  |---|---|
  | SCIM ownership check removed | the PUT and PATCH refusal cells |
  | refusal applied to deactivation too | both deactivation cells |
  | engine create-arm ownership refusal removed | its refusal cell |
  | engine `toUpdate` ownership refusal removed | its refusal cell |
  | either dry-run clause removed | its preview cell |
  | POST distinct details restored | the three POST refusal cells |
  | the declined row keeping the foreign id | the declined-attachment audit cell |
  | ownership decided by the column alone | the active-membership cell |
  | an ambiguous resolution attached | the T3 cell |
  | the ambiguous reason collapsed | the T3 cell |

- Integration (real database, app role): new cells for PATCH refusing a departed
  member another tenant owns, PATCH reactivating one this tenant owns, and
  directory sync not reactivating a mapped departed member. With both ownership
  checks removed, the two refusal cells failed and the other 11 passed.

#### R6-S1 Major — the releasing tenant's row no longer names another tenant's people (with F3)

- Action: `emitRealignment` records the system actor on the releasing tenant's
  row unless the cause is a sign-in. It keeps `source` there. The joining tenant's
  row keeps the producer's actor and `movedUserId`. The false "names no tenant"
  claim was replaced by the reason: every reader of the releasing log hydrates an
  actor id into name and email.
- Red proof: restoring the producer's actor on the releasing row failed its cell.
  The sign-in cell (the user on both rows) passes on both.
- F3: the label no longer says "on sign-in" (en: "Member's owning organization
  realigned (data left in the previous one)"; ja: "所属組織を再設定
  (データは旧組織に残存)").
- The class, derived over all 257 audit emit call sites (AST, tests excluded): a
  row filed under tenant X whose actor can have no relation to X.
  - The realignment's releasing row, fixed above. It was the only member whose
    actor reaches a screen or download as a name and email.
  - `AUTH_LOGIN_FAILURE` rows that sign-in files under a claim's owning tenant.
    These are PERSONAL scope, so no tenant view, download or webhook shows them,
    but a tenant's audit delivery target receives the raw user id. NOT changed.
    - Anti-Deferral check: the row's `userId` is what the user's own personal log
      reads, so replacing it would remove the failure from that log.
    - Worst case: another tenant's SIEM learns an internal user id for a person
      whose email its own IdP just authenticated.
    - Likelihood: needs a revoked or colliding claim.
    - Cost to fix: a delivery-time actor redaction for PERSONAL rows, a change to
      the delivery pipeline outside this branch's subject.
  - Team guests' actions in TEAM rows are an intended relation
    (`team-guest-cross-tenant-admin-plan`).
  - Actor ids left behind by a membership deleted later are historical record,
    not disclosure.

#### T1 Major — CI's integration job runs the application as `passwd_app`

- Action: the "Run integration tests" step sets `DATABASE_URL` to `passwd_app`,
  and `MIGRATION_DATABASE_URL` stays the superuser for the harness. This is the
  role every local run has used through `.env`. Both RLS-dependent integration
  files call a new `assertRlsApplies(prisma)` in `beforeAll`, which fails when the
  singleton's role is a superuser or has BYPASSRLS, and fails too when the probe
  itself fails.
- Red proof: with `DATABASE_URL` pointed at the migration superuser, both files
  failed in `beforeAll` naming `passwd_user`, and all 13 cells were skipped.

#### R6-S3 / F1 Major (convergent) — an opener opens its context only around its callback

- Action (`scripts/checks/lib/rls-context.mjs`): each opener is recorded with the
  context it opens and its callback's argument position, `OPENERS`, taken from the
  signatures in `src/lib/tenant-rls.ts` and `src/lib/tenant-context.ts`. Any other
  argument — the client, the tenant id, the purpose — answers null, and the walk
  continues outward to the context that argument really runs in.
- Three instances of the same defect, found while fixing it, were closed with it:
  - The callback argument's own expression runs before the context opens. Only a
    node inside a function written within that argument runs later, so
    `withBypassRls(prisma, pick(await read), P)` is no longer a bypass.
  - A spread at or before the callback position hides which argument lands there,
    and is UNKNOWN. A spread at a local wrapper's call site asks every parameter it
    could reach.
  - A rest parameter collecting the argument is UNKNOWN. It used to answer null,
    which let an outer opener answer for a callback the wrapper runs.
- Stated limit, now in the module header: a function handed to a helper inside
  the callback argument (`withBypassRls(prisma, pick(async (tx) => …), P)`) is
  still read as running inside the bypass. Whether `pick` calls it before the
  bypass opens is not something one file can show.
- Red proof: every new cell fails against the gates as of 5b55f3129, or under a
  mutation of its own branch. I re-ran this independently in a worktree copy:
  letting an imported opener answer for every argument failed exactly the two
  function-in-non-callback-argument cells, one per gate.
- **Note from round 7:** after round 7's timing rule, those two cells no longer
  depend on the position table — a function nested inside a non-callback argument
  is UNKNOWN in its own right. The position is now pinned by a function passed as
  the non-callback argument itself (`withBypassRls`'s purpose position and
  `withTenantRls`'s tenantId position).

#### F2 Minor — nested filter names resolve where they are written

- Action: `filterLiterals` resolves each identifier at its own node, not at the
  Prisma call, the way `scope-bindings.mjs` already follows aliases. `ctx.at` had
  no other use and was removed. `assignedInto` already resolved per node.
- Red proof: a module-level `const where = { OR: [userFilter] }` with a
  same-named `userFilter` declared inside the calling function was passed by the
  old gate and is flagged now. Resolving at the call site again fails that cell.

#### T2 Major — each fail-open branch of the tenant gates has a deny cell

- Action: deny cells for:
  - a destructured and a rest callback parameter (both gates);
  - mutually recursive wrappers, which also checks that the gate terminates;
  - a callee bound to a parameter, under an outer opener (both gates);
  - `delete` and `Object.assign` onto a followed `where`;
  - a conditional with one unreadable branch;
  - an unreadable filter inside `OR`, inside a relation filter's `is`, and as a
    nested relation's value.
- One allow cell pins `refersHere`'s scope check: a same-named, sibling-scope
  binding that is `delete`d does not make an untouched `const` unreadable.
- Red proof: each mutation named in the finding now fails its own cell and no
  other, except the rest-parameter mutation, which also fails the rest-past-index
  cell because both go through the same branch.
- **Corrected in round 7 (R7-T1):** that claim does not hold for four of the
  branches. The destructured-parameter, rest-parameter, recursion-guard and
  wrapper-spread cells had no outer opener, and without one a wrong null and a
  correct UNKNOWN both end in "reported". Re-measured by Testing, the destructured,
  recursion-guard and wrapper-spread mutations failed none of the self-tests. The
  rest-parameter mutation failed only the rest-past-index cell, not the cell
  written for its branch. Round 7 adds a variant of each cell inside an outer
  opener.

#### T6 Minor — a manifest disposition excuses only its own kind of hit

- Action: a `dynamic-where` entry excuses only paths through `<unreadable-where>`,
  and no other disposition excuses such a path. A mismatch is reported with the
  file, line, disposition and path. The shipped manifest passes unchanged: no
  entry mixed hit kinds.
- Red proof: I re-ran this independently. Letting every disposition excuse every
  path failed exactly the two new cells, one for each direction.

#### Round 6 verification

- Gate slice: the three self-test files pass (198). All three gates exit 0 on
  the real tree, each run unpiped.
- Code slice: the unit suite passes (1033 files / 15622 tests), and `next build`
  passes. Integration passes with the application client connected as
  `passwd_app` and both workers stopped (113 files / 685 tests). `scripts/pre-pr.sh`
  passes on the committed code slice.

## Round 7

Reviewed range: `5b55f3129..30fc857f7`, the round-6 fix commits. The experts' raw
outputs, including their full Recurring Issue Checks, are kept in the round's
working files.

### Changes from Previous Round

Round 6's fixes were verified in their main claims:
- ownership is now required before any reactivation, and dry run matches apply;
- the releasing tenant's row carries the system actor;
- CI runs integration as the application role, and the guard added for that has
  no fail-open;
- the gates' callback-position and disposition binding are correct.

Round 7 found three problems:
- two escapes in the same gate helper that round 6 wrote;
- four round-6 gate cells that cannot fail for the reason they claim, so part of
  round 6's red-proof record does not reproduce;
- a recovery path round 6 promised that does not exist for tenants without a
  tenant claim.

### Converged across experts (severity floored by convergence)

- **R7-S1 / F-R7-1 — Major, convergent: security+functionality (R49/R47).**
  `runsLater` in `scripts/checks/lib/rls-context.mjs` treats a read as running
  inside the opener's context in two shapes where it does not:
  - The read IS the argument, and the enclosing function is an arrow. The walk
    never meets the argument, climbs out, and stops at the arrow.
  - A function is nested inside the callback argument without being that
    argument: an IIFE, which runs before the opener, or `pick(async …)`.
  Both tenant gates pass such a read. No call site in `src` has either shape.
- **R7-S3 / F-R7-4 / R7-A1 — Major (floored from Minor), convergent:
  security+functionality+testing.** SCIM PUT/PATCH still answer two 409 details:
  one for a user active in another tenant, one for a user owned but suspended
  there. That tells a token holder which state another tenant holds the user in.
  The uniqueness check is subsumed by the ownership check, and POST's uniqueness
  branch can no longer be reached. The round-6 record said PUT/PATCH return "the
  same constant".

### Security findings

- **R7-S2 — Major (R3, R6-S4 not propagated).** Directory sync's declined
  attachment still records `ambiguous_email` or `owned_by_another_tenant` in a
  row the tenant can read, for an email the tenant has no membership for. The
  tenant's admin controls the directory's email attribute, so they can still ask
  exactly the question round 6 stopped SCIM POST from answering.

### Functionality findings

- **F-R7-2 — Major (R41/R49).** Round 6 gave "sign in through this tenant's IdP"
  as the way back for a departed member, but sign-in row 4 runs only for a
  tenant-claim sign-in. A tenant without a claim — magic link or passkey members,
  with SCIM or sync configured — can never take such a member back. The user
  chose an audited operator command as the remedy.
- **F-R7-3 — Minor (R4).** A SCIM PUT/PATCH reactivation refusal writes no audit
  row, while directory sync records the same decision.
- **F-R7-5 — Minor (R29).** Comments still describe SCIM/sync realignment as a
  steady-state column move. After round 6 it only fires in a race.

### Testing findings

- **R7-T1 — Major (RT7/R29).** Four round-6 cells have no outer opener, so a
  wrong null and a correct UNKNOWN both end in "reported", and the cells cannot
  fail for their own branch. The four branches are the destructured parameter,
  the rest parameter, the recursion guard, and the wrapper spread. The round-6 T2
  and R6-S3 red-proof lines claim otherwise.
- **R7-T2 — Major (RT1/RT10).** The fixtures build "active in another tenant"
  without also making the user "owned by another tenant", a combination
  production cannot produce. Swapping either the engine's refusal precedence or
  the order of `reactivationRefusal` leaves every suite green, and the audit
  reason and 409 detail are not asserted.
- **R7-T3 — Minor.** `assertRlsApplies` has no cell. Its `rolbypassrls` arm and
  its empty-result arm have never run.
- **R7-T4 — Minor.** Three things have no cell: `withTeamTenantRls`'s callback
  position, and both allow sides of the spread handling (a spread after the
  callback, and a wrapper spread that reaches no opener).
- **R7-T5 — Minor.** `usersOwnedByAnotherTenant`'s "no users row, so absent"
  contract has no direct cell.
- **R7-T6 — Minor (R29).** `src/__tests__/db-integration/setup.ts` says the
  superuser must be the default `DATABASE_URL`, which is false after the CI
  change.

### Resolution Status — round 7

#### R7-S3 / F-R7-4 / R7-A1 Major (convergent) — one question and one 409 detail for SCIM, with a record (and F-R7-3)

- **Action:** SCIM PUT/PATCH `reactivationRefusal` asks one question: does
  another tenant own the user?
  - The second-active-membership check is gone. An active membership in another
    tenant already makes that tenant the owner, so the check refused nobody the
    ownership question lets through, and it cost a second bypass transaction.
  - Every one-active-membership race handler answers
    `SCIM_USER_NOT_PROVISIONABLE_DETAIL`. That covers POST, PUT, PATCH and DELETE.
  - POST's uniqueness guard for an owned user could no longer be reached and was
    removed.
  - `wouldCreateSecondActiveMembership` had no caller left and was removed with
    its tests.
- **F-R7-3:** the refusal is audited as `SCIM_USER_REACTIVATION_REFUSED`.
  - It is a new `AuditAction` value (migration
    `20260913120000_scim_user_reactivation_refused`), in the tenant SCIM group and
    therefore webhook-subscribable, with en/ja labels.
  - Metadata is `{ reason: "owned_by_another_tenant" }`; nothing of the other
    tenant is recorded.
  - The race handlers are not audited: they answer an interleaving, not a decision.
- **Red proof** (worktree copy):
  - Removing the audit failed the four PUT/PATCH refusal cells.
  - Putting POST's uniqueness read back failed the cell that pins its absence.

#### R7-S2 Major — directory sync's decline no longer names the case-variant question for another tenant's user

- **Action:** `resolveExistingUsersForTenant` now reports `ambiguous` with
  `ownedHere`, which is true only when every match is this tenant's.
  - Directory sync records `ambiguous_email` only in that case. For every other
    no-membership decline it records `owned_by_another_tenant`. The dry run
    records no reason; it counts the decline the same way (corrected in round 8,
    F-R8-4 / T8-5).
  - The declined row still carries no user id.
- **Red proof:**
  - The engine ignoring `ownedHere` failed the new cell, on its live assertion.
  - The classifier always reporting `ownedHere: true` failed its new cell.

#### R7-T2 Major — fixtures now build the state production has

- **Action:** every engine cell that seeds a user as active in another tenant
  (five mapped cells and the unmapped refusal cell) also seeds that tenant as the
  owner. The SCIM PUT/PATCH cells do the same through `ownership.active`.
  - The reasons are asserted: `active_in_another_tenant` on both engine arms,
    and on SCIM the one detail plus the audit row.
- **Red proof:**
  - Swapping the engine's `toUpdate` precedence failed "emits an audit event
    naming the membership it declined".
  - Swapping the create-arm precedence failed "counts the refusal on an unmapped
    user who holds a deactivated membership here".
  - With a single SCIM question there is no order left to swap.

#### R7-T3, R7-T5, R7-T6 Minor, and F-R7-5 Minor

- **R7-T3:** `assertRlsApplies` has cells for a superuser, BYPASSRLS, an empty
  probe, a failing probe, and a plain role (allow). Removing each operand of its
  condition failed exactly its own cell.
- **R7-T5:** `usersOwnedByAnotherTenant` has a cell for a missing users row.
  Reporting such a row as foreign failed it.
- **R7-T6:** `setup.ts` now says its `DATABASE_URL` assignment is only a
  fallback, and that the harness's superuser comes from `MIGRATION_DATABASE_URL`.
- **F-R7-5:** the SCIM `realignReactivatedMember` doc, the engine's `activated`
  comment and the realignment emitter doc now describe the SCIM and sync
  realignment as a race backstop.

#### Verification — SCIM and sync slice

- Unit: 1033 files / 15652 tests pass. `next build` passes, and eslint passes on
  every changed file.
- Integration, with the new migration applied to the dev database by
  `prisma migrate deploy` and both workers stopped: 113 files / 685 tests pass.

#### R7-S1 / F-R7-1 Major (convergent) — a read runs in an opener's context only inside the function that IS the callback

- **Action:** `runsLater` is replaced by `timingIn` in
  `scripts/checks/lib/rls-context.mjs`, which reports one of three timings:
  - **NOW:** the node is the argument itself, or no function lies between them.
  - **LATER:** the node is inside the function that IS the argument, after
    unwrapping parentheses and type assertions.
  - **NESTED:** the node is inside some other function written within the
    argument, such as an IIFE or `pick(fn)`.
- `rlsContextOf` now resolves the callee before it asks about timing. A call that
  opens nothing around the argument is stepped over whatever functions it holds.
  For a call that does open a context:
  - LATER returns that context;
  - NESTED returns UNKNOWN;
  - NOW continues outward.
- Round 6 documented a fail-open limit for `pick(async …)`. That limit is now
  fail-closed.
- New cells in both gates:
  - **Deny:** a read that is the argument (directly, and through a local
    wrapper), arrow, function-expression and awaited IIFEs, a function handed to
    a helper inside the callback, and a function passed as a non-callback
    argument. The last pins the position table, which round 6's cells stopped
    pinning once the timing rule changed.
  - **Allow:** an `as`-asserted callback, a function-expression callback, a
    nested `.map(async …)`, and a non-opener helper's function inside the
    callback.

#### R7-T1 Major — the four fail-closed branches are pinned where a wrong null would pass

- **Action:** the destructured-parameter, recursion-guard, rest-parameter and
  wrapper-spread shapes each have a variant inside an OUTER opener, in both
  gates. There, a wrong null would walk on to the outer context and read as
  exempt. The round-6 cells are kept, and still pin the refusal without an outer
  opener.

#### R7-T4 Minor — the unpinned positions and spread allow sides have cells

- **Action:** a read inside `withTeamTenantRls`'s callback passes, and a read in
  a function inside its `teamId` argument is refused. Two spread allow cells are
  added:
  - a spread into a wrapper that reaches no opener;
  - a spread after the opener's callback position.

#### Red proof — gate slice

Run in a worktree copy, over both self-test files (123 cells at baseline). Each
mutation failed exactly the cells listed.

| Mutation | Cells that failed |
|---|---|
| A node that is the argument runs LATER | the three node-is-argument cells (both gates) |
| A nested function counts as the callback | the three IIFE cells and the `pick` cell, plus the owning gate's IIFE cell |
| NESTED refused even for a non-opener | the non-opener-helper allow cell |
| The callback not unwrapped | the `as`-asserted allow cell |
| An opener answers for every argument | the two non-callback-position cells |
| Destructured check removed | the two outer-opener destructured cells |
| Rest check removed | the two outer-opener rest cells, and round 6's rest-past-index cell |
| Recursion guard answers null | the two outer-opener recursion cells |
| Wrapper-spread loop fails open | the two outer-opener wrapper-spread cells |
| Wrapper spread always UNKNOWN | its allow cell |
| Any spread is UNKNOWN | the spread-after-callback allow cell |
| `withTeamTenantRls` position 1 → 0 | its allow cell |

#### Verification — gate slice

- The three self-test files pass (224).
- All three gates exit 0 on the real tree, each run unpiped.
- eslint passes.

#### F-R7-2 Major — an audited operator command for the member no producer may take back

- **Decision:** the user chose an operator command. They chose it over documenting
  the limit, and over restoring reactivation by membership row, which would
  re-open R6-S2.
- **Implementation choice:** `@/lib/prisma` builds its pool at import and throws
  without `DATABASE_URL`, while offline CLIs run on `MIGRATION_DATABASE_URL`
  alone. The user chose to extract the in-transaction code into modules that
  never import the singleton. A lazy singleton was rejected: it changes a pinned
  fail-fast, and nothing else validates `DATABASE_URL` at boot.
- **Action, extraction (no runtime behaviour change in the application):**
  - `audit-payload.ts`: the payload builder and metadata bounding, re-exported by
    `audit.ts`.
  - `audit-outbox-in-tx.ts`: the in-transaction enqueue. `audit-outbox.ts` keeps
    `enqueueAuditInTx` as its own function, because a test spies on that export.
  - `stranded-rows.ts` and `owning-column.ts`: re-exported by `tenant-context.ts`.
    `owning-column.ts` gains a `column-intended` manifest entry, because the raw
    column read moved with it.
  - `tenant-realignment-core.ts`: the move and its record, with the audit writer
    and column helpers passed in. `tenant-realignment.ts` passes the application's
    functions at each call, so the 16 test files that mock `@/lib/audit/audit` and
    `tenant-realignment.test.ts`'s `@/lib/tenant-context` mock still reach this
    path.
- **Action, the command:** `tenant-domain realign --user <uuid|email> --tenant
  <ref> --by <label> [--yes]`.
  - It reuses the CLI's `--by` validation, tenant resolution, confirmation seam
    and migration client.
  - It refuses:
    - a user with an active membership anywhere;
    - a target where the user holds no membership row;
    - an email matching more than one user;
    - the sentinel tenant.
  - It moves only the column. The membership stays deactivated for the tenant to
    reactivate, now that it owns the user.
  - Both tenants get `USER_TENANT_REALIGNED` with the system actor, source
    `operator` (new), and `by` set to the label.
  - It is not atomic against an activation elsewhere between the check and the
    write; that is stated in its doc.
  - The README recovery section and the CLAUDE.md admin line document it.
- **Guard:** `scripts/__tests__/tenant-domain-import-graph.test.ts` walks the CLI's
  runtime import graph and fails on any path to `src/lib/prisma.ts`. A control
  cell proves the walker does see the singleton through a module that imports it.
- **Red proof** (worktree copy):
  - A runtime import of the singleton added to the core failed the guard.
  - Not recording the label failed the unit operator cell.
  - At integration level (real database, app role), with the realign cells green
    at baseline, each mutation failed exactly its own cell:
    - active-membership refusal removed;
    - membership-row refusal removed;
    - `--by` validation skipped;
    - confirmation assumed;
    - email matched case-sensitively.

#### Verification — operator command slice

- Unit: 1034 files / 15683 tests pass. `next build` passes. eslint reports no
  warning on any changed file. The three tenant gates exit 0 on the real tree.
- Integration, with both workers stopped: 113 files / 692 tests pass, including
  the seven `realign` cells and the missing-URL cell, which now covers `realign`.
- `scripts/pre-pr.sh` on the committed round-7 fixes first failed one check,
  `raw-sql-usage`. The extraction moved `enqueueAuditInTx`'s raw SQL into
  `src/lib/audit/audit-outbox-in-tx.ts`, and the allowlist names files. With that
  file listed (commit `1aa0e566d`), every pre-PR check passes.

## Round 8

Reviewed range: `30fc857f7..0f1fedaf0`, the round-7 fix commits. The experts'
raw outputs and full Recurring Issue Checks are kept in the round's working files.

### Changes from Previous Round

Round 7's main claims were verified. The following hold with no regression and no
boundary widening:
- the extraction: the audit composition, the enqueue guard and metadata bounding
  are unchanged, and no cycle appears;
- the single SCIM question and detail;
- the refusal audit;
- `ownedHere`;
- `realign`'s refusals.

Testing re-ran eleven recorded red proofs, and all reproduce. Round 8 found:
- `realign`'s email lookup is an unescaped pattern match;
- its confirmation prompt, and `add`'s and `remove`'s, cannot survive Prisma's
  default 5 s transaction timeout;
- the gate still trusts a closure that escapes the opener;
- round 7's own NESTED cells repeat the R7-T1 blind spot;
- the import-graph guard neither proves recursion nor sees every import spelling.

### Converged across experts (severity floored by convergence)

- **R8-S1 / F-R8-1 — Major, convergent security+functionality (R47/R48).**
  `realign --user <email>` uses `equals` with `mode: "insensitive"`, which Prisma
  compiles to `ILIKE $1` with the value unescaped. `_` and `%` are wildcards, so a
  typo can select, and realign, a different user. The application answers the
  same question with `LOWER(email) IN (LOWER($1))`.
- **R8-S4 — Major (floored), convergent security+functionality.** The same
  insensitive-`equals` shape lists another user's pending emergency-access grants
  under a bypass: `src/app/api/emergency-access/route.ts`, grant list. It also
  gives a false duplicate refusal and a wrong locale lookup on create, and
  `userName` filters in `src/lib/scim/filter-parser.ts` treat the value as a
  wildcard pattern. These predate this branch.
- **F-R8-2 / R8-S5 — Major, convergent functionality+security.** `add`,
  `remove` and `realign` await the operator's confirmation inside
  `withBypassRls` without options. Prisma's default interactive-transaction
  timeout (5 s) rolls the transaction back and raises a raw error for anyone who
  reads the preview, which pushes operators to `--yes`. D-14's recorded cost names
  only `idle_in_transaction_session_timeout`.
- **R8-S2 / F-R8-5 — Major, convergent security+functionality (R47/R49).**
  `timingIn` answers LATER for any function inside the callback. That includes a
  returned or stored closure, an object method, a nested function declaration and
  a `setTimeout` callback, all of which run after the context has closed. Both
  gates pass them, and the module header claims otherwise.
- **T8-1 / R8-S3 — Major, convergent testing+security (RT7/R47).** The
  import-graph guard's control cell is one hop, so a walker that never recurses
  passes it. A single-quoted specifier, a `.js` specifier and a template-literal
  `import()` all escape the regexes; the CLI crashes on boot while the guard stays
  green. Unresolved specifiers are skipped silently.
- **F-R8-4 / T8-5 — Major (floored from Minor), convergent
  functionality+testing (R29).** The round-7 record says sync records the
  ownership reason "live and in the dry run", but the dry run only counts. The
  dry-run half of that cell cannot fail for `ownedHere`.

### Testing findings

- **T8-2 — Major (RT7, the R7-T1 class in round 7's new cells).** No NESTED deny
  cell sits inside an outer opener that would exempt the read. A wrong NOW for a
  helper-deferred function therefore passes every self-test.
- **T8-3 — Minor.** The POST "no uniqueness read" cell pins one mock method; a
  `count`-based read passes it.
- **T8-4 — Minor (RT10/RT8).** Several of `realign`'s refusals and targets have no
  integration cell: ambiguous email, sentinel target, not-found, a claim or
  external-id target. Nor are `leftBehind` and the rows' `targetId` asserted.

### Functionality findings

- **F-R8-3 — Minor (R12/R29).** `SCIM_USER_REACTIVATION_REFUSED` is in the tenant
  SCIM group but not the team one, and a test comment still says both sides hold
  the same 8 actions. `docs/operations/audit-log-reference.md` lists none of the
  branch's three new actions.
- **F-R8-6 — Minor (R29).** The README and the usage text omit `realign`'s
  sentinel-tenant refusal.

### Resolution Status — round 8

#### R8-S1 / F-R8-1 Major (convergent) — email matching is exact and case-insensitive, never a pattern (with R8-S4)

- **Action, `realign`:** `tenant-domain realign --user <email>` now resolves with
  `{ in: [email], mode: "insensitive" }`. Prisma compiles that to
  `LOWER(email) IN (LOWER($1))`, the application's comparison. `_`, `%` and `\` in
  the typed address match themselves only. More than one match can now only mean
  case variants of one address, which the refusal already names.
- **R8-S4, emergency-access:** all three lookups use the same form:
  - the duplicate-grant check;
  - the grantee locale lookup;
  - the pending-grant list served under a bypass.
- **R8-S4, SCIM filter:** `userName eq` matches exactly. `co` and `sw` escape the
  pattern characters through `escapeLikePattern` in
  `src/lib/prisma/prisma-filters.ts`.
- **Shared helper:** the team members search, which carried the same escape
  inline, now uses `escapeLikePattern` too. Its doc records which form to use for
  which question.
- **Cross-cutting check:** no insensitive `equals` remains in `src`.

#### F-R8-2 / R8-S5 Major (convergent) — a confirmation can take as long as a human needs

- **Action:** `add`, `remove` and `realign` pass an explicit transaction budget
  from `confirmationTransaction` in `scripts/tenant-domain.ts`, which allows
  10 minutes with a 10 s `maxWait`.
  - It is a seam, like `migrationClientFactory`.
  - A confirmation that outlives the budget returns a named `CmdResult` rather
    than a raw Prisma error. The result is recognised by `P2028` or the
    expired-transaction message, and nothing is written.
  - The prompt stays inside the transaction, so D-14's TOCTOU argument stands.
    D-14 has an addendum recording the limit it missed.
  - The README and the usage text state the budget.

#### R8-S2 / F-R8-5 Major (convergent) and T8-2 Major — only functions that run while the callback runs inherit its context

- **Action:** `timingIn` returns LATER only when every function between the read
  and the callback runs while the callback runs:
  - an IIFE; or
  - a function handed straight to a call that is not a scheduler (`setTimeout`,
    `setInterval`, `setImmediate`, `queueMicrotask`, `nextTick`).
- A closure returned or stored out of the callback, an object method, a nested
  declaration, or a scheduled callback is NESTED, and so UNKNOWN.
- Methods, function declarations, accessors and constructors now count as
  function-like.
- The module header states the rule.
- **Cells:** deny cells for each shape in both gates, and an IIFE-inside-callback
  allow cell.
- **T8-2:** a helper-deferred read now sits inside an OUTER opener that would
  exempt it, in both gates. A wrong NOW there reads as exempt instead of refused.
- **Real tree:** all three gates still pass, with no new manifest entry.

#### T8-1 / R8-S3 Major (convergent) — the import guard asks the compiler

- **Action:** `tenant-domain-import-graph.test.ts` now:
  - reads specifiers from TypeScript's AST (imports that are not type-only,
    re-exports, import-equals, `require`, dynamic `import()`);
  - resolves them with `ts.resolveModuleName` under the repo tsconfig;
  - reports every local specifier that does not resolve, and every `import()` of
    a non-literal.
- **Walker cells:** its own fixture project covers:
  - a three-hop chain;
  - a single-quoted specifier, a `.js` specifier, `export *`, import-equals,
    `require`, a template-literal `import()`, two statements on one line, and a
    multi-line import with an inline type;
  - a type-only import (not counted);
  - an unresolved specifier and an opaque dynamic import (both reported).
- **Real CLI:** the cell for the actual CLI asserts both no chain and nothing
  unresolved.

#### F-R8-4 / T8-5 Major (floored) — the record says what the dry run does

- **Action:** the R7-S2 entry now says that the dry run records no reason and only
  counts the decline, and its red-proof line names the live assertion.
- **Cell name:** the engine cell's name now claims only the dry-run count.

#### F-R8-3, F-R8-6, T8-3, T8-4 Minor

- **F-R8-3:** the SCIM-group test comment no longer claims both sides hold the same
  eight actions. `SCIM_USER_REACTIVATION_REFUSED` stays tenant-only, because it is
  a tenant refusal. `docs/operations/audit-log-reference.md` now lists all three
  of the branch's new actions in their groups.
- **F-R8-6:** the README and the usage text name the sentinel-tenant refusal.
- **T8-3:** the POST "no uniqueness read" cell pins both tenant-member methods the
  bypass client offers, and the number of bypasses per provision.
- **T8-4:** new `realign` integration cells:
  - `_` and `%` in `--user` match nobody;
  - an address naming two case variants is refused, and neither user moves;
  - the sentinel tenant is refused as a target;
  - a target given by its claim is realigned, with `leftBehind` (a seeded
    stranded tag) and both rows' `targetId` asserted;
  - a confirmation past a shortened budget is named, and nothing is written.
- **F-R8-2 cells:** `realign`, `add --from` and `remove` each commit after a
  six-second confirmation.

#### Red proof — round 8

Run in a worktree copy. Each mutation was applied on its own, and the table lists
every cell that failed under it.

| Mutation | Cells that failed |
|---|---|
| SCIM `eq` back to insensitive `equals` | the exact-match cell |
| SCIM `co` not escaped | the escape cell |
| emergency-access duplicate check back to `equals` | the POST exact-address cell |
| emergency-access pending list back to `equals` | the GET exact-address cell |
| `escapeLikePattern` drops `\\` | its metacharacter cell |
| every nested function treated as inline (the round-7 rule) | the nine new deny cells across both gates |
| IIFE form dropped | the two IIFE allow cells |
| call-argument form dropped | the `.map`, non-opener-helper and wrapper-spread allow cells, which all hand a function straight to a call |
| no schedulers | the two scheduler cells |
| NESTED becomes NOW | the two outer-opener helper-deferred cells (T8-2) |
| methods and declarations not function-like | the four method/declaration cells |
| walker does not recurse | the three-hop control |
| type-only imports counted | the type-only cell and the real-CLI cell |
| unresolved specifiers skipped | the unresolved cell |
| opaque dynamic imports ignored | the opaque-import cell |
| `require` not seen | the `require` cell |
| POST uniqueness read restored as a `count` | the absence cell |

Integration (real database, app role, workers stopped):

| Mutation | Cells that failed |
|---|---|
| `realign` email back to ILIKE | the `_`/`%` cell |
| confirmation budget not passed | the named-timeout cell, and the three six-second cells for `realign`, `add` and `remove` |
| expired confirmation not caught | the named-timeout cell |
| sentinel refusal removed | the sentinel cell |
| SCIM `eq` back to ILIKE | the SCIM literal-filter cell |
| SCIM `co`/`sw` not escaped | the SCIM literal-filter cell |

#### Found while red-proving — the integration cleanup did not delete tags

- The new claim-target cell passed its assertions but failed in cleanup, at
  baseline and under every mutation.
  - It seeds a tag under `owning`, and `realign` then moves the user to `former`.
  - `deleteTestData(owning)` deletes users by tenant, and that no longer covers
    the moved user. It never deleted `tags`, which reference `tenants` with
    `RESTRICT`, so the tenant delete failed with `23503`.
- This is the stranded-row state `realign` exists to report, so the helper now
  deletes `tags` by tenant after the personal password entries.
- The cell passes with the fix.
- The failing runs left eight test tenants on the dev database, each holding only
  one `audit_outbox` row. They are identified and have not been removed.

#### Also in a file this round touched — the SSO deviation log's citations

- `docs/archive/review/sso-tenant-domain-alias-deviation.md` received the D-14
  addendum above.
- The citation gate run over it reported five partial-path citations that were
  already MISSING at `1aa0e566d`.
- Each now gives the full path and names its subject (a function or a test case).
  The two that point at deleted test cases say they were deleted, so the historical
  record keeps its meaning.
- The gate passes over both documents.

#### Round 8 verification

- **Unit:** 1034 files / 15712 tests pass, and `next build` passes. eslint reports
  nothing on any changed file. The three tenant gates exit 0 on the real tree.
- **Integration:** 113 files / 701 tests pass, with both workers stopped.
- **Citation gate:** passes over this document and the SSO deviation log.

## Round 9

Reviewed range: `1aa0e566d..2df065f5c`, the round-8 fix commit. The experts' raw
outputs and full Recurring Issue Checks are kept in the round's working files.

### Changes from Previous Round

Round 8's claims were verified:
- no insensitive `equals` and no unescaped pattern match on user input remains in
  `src` or `scripts`;
- security probed Prisma 7's generated SQL: `in` + insensitive compiles to
  `LOWER(email) IN (LOWER($1))`, and `escapeLikePattern`'s output reaches `ILIKE`
  as a bind parameter under the default backslash escape;
- no commit can be reported as "nothing was written": Prisma serialises commit and
  timeout on one transaction queue;
- no row or advisory lock is held across the prompt;
- testing re-ran six recorded red proofs, and all reproduce.

Round 9 found that the gate's round-8 rule was still an enumeration of deferral
spellings, and that the timeout mapping caught more than a timeout.

### Converged across experts (severity floored by convergence)

- **F-R9-2 / S-R9-1 — Major, convergent functionality+security (R42/R47/R49).**
  `runsInline` trusted every function handed to a call that was not one of five
  scheduler names. `after(fn)`, `emitter.on(…, fn)`, `list.push(fn)`,
  `map.set(k, fn)`, `setTimeout.call(null, fn)`, `globalThis["setTimeout"](fn)`,
  a local `register(fn)`, an un-awaited async `map` and `void p.then(fn)` all read
  as scoped. A stored function called later runs under its caller's context. The
  module header claimed stored functions were refused.
- **F-R9-1 / S-R9-3 / T-R9-2 — Major, convergent functionality+security+testing.**
  `confirmationTimeoutResult` matched any P2028, which is Prisma's whole
  transaction-error family. A transaction that never started (`maxWait`, an
  unreachable database) was reported as a slow confirmation, on every re-run. Only
  `realign`'s timeout arm had a cell, no cell showed a non-timeout error still
  propagating, and Prisma's expiry error matched both recognition arms.
- **S-R9-4 / F-R9-3 — Minor, convergent.** A `new Promise` executor and a local
  helper called on the spot were refused although they run inline.

### Security findings

- **S-R9-2 — Minor (R29).** The preview's reads hold `AccessShareLock` for the
  whole budget, now 10 minutes. A migration's `ALTER TABLE` waits for it, and
  sign-in queries queue behind that migration. The D-14 addendum called the
  trade-off unchanged.

### Testing findings

- **T-R9-1 — Major (RT7/R42).** Only one member of each round-8 set was pinned:
  four of five scheduler names, the property-access name branch, and the accessor
  and constructor kinds could each be dropped with every cell green.
- **T-R9-3 — Minor (RT7).** Removing the team members search's `escapeLikePattern`
  call left its route test green.
- **T-R9-4 — Minor (RT7).** The real-CLI import-graph cell's target path was proven
  by no cell; a wrong or moved path would leave it green with no chain to find.

### Functionality findings

- **F-R9-4 — Minor (R27).** The usage text wrote the budget as a literal
  "10 minutes" while the timeout message derived "600 s" from the constant.

### Resolution Status — round 9

#### F-R9-2 / S-R9-1 Major (convergent) and T-R9-1 Major — a function runs inline only in a closed list of shapes

- **Action:** `runsInline` in `scripts/checks/lib/rls-context.mjs` no longer
  enumerates deferral. It trusts only:
  - an IIFE, or a `new Promise(…)` executor: sync, or its promise settled;
  - an `ARRAY_ITERATORS` callback: sync, or — for `map`/`flatMap` only — async
    with the array handed to a settled `Promise.all`/`allSettled`;
  - a `PROMISE_CHAIN` (`then`/`catch`/`finally`) or `TRANSACTION_RUNNERS`
    (`$transaction`) callback whose call is settled.
- **Settled** (`isSettled`): awaited, returned (a `return` or an arrow's
  expression body), handed to a settled combinator directly or as an array
  element, or continued by a settled promise chain.
- Everything else is NESTED, so UNKNOWN: element-access callees, `.call`,
  imported or local helpers, listeners, `after`, `race`/`any`. The module header
  and `runsInline`'s doc state the rule and the shapes refused although they run
  inline (a local helper calling its parameter, a named function passed by
  reference, `.call`).
- **Cells (both gates):** one allow cell per member of each exported set, from a
  member list written out in the test, and a cell asserting each list equals its
  set. The first version generated the cells from the imported set; the red proof
  showed dropping a member then drops its cell too, so no cell went red. A
  Promise-executor, an array-element IIFE and a
  settled-chain allow cell; deny cells for `after`, a listener, `push`,
  `setTimeout.call`, an element-access scheduler, `process.nextTick`,
  `queueMicrotask`, an un-awaited async `map`, `Promise.race`, an awaited async
  `forEach`, `void then`, a floating async IIFE, `void $transaction`, a
  non-first executor argument, a getter, a setter, a class constructor and a
  local helper that keeps its argument.
- **Round-7 cells changed by design:** the "non-opener helper wraps it" allow cell
  is now a deny cell. The R7-T4 spread cell passes the read as a value argument, so
  it still decides only whether the spread reads as opening something.
- **Real tree:** both gates still pass (29 and 12 files) with no manifest entry.

#### F-R9-1 / S-R9-3 / T-R9-2 Major (convergent) — only an expired confirmation is named, and the command returns

- **Action:** `confirmationTimeoutResult` matches Prisma's expiry message
  ("cannot be executed on an expired transaction") and nothing else; every other
  error, P2028 included, propagates.
- **Found while red-proving the maxWait path:** against a server that accepts the
  connection and never answers, `maxWait` failed the command at ~0.4 s, and then
  `$disconnect()` in the command's `finally` waited on that connection with no
  limit, so the CLI hung. `migrationClientFactory` now passes
  `connectionTimeoutMillis`, the application pool's default of 5 s.
- **Cells (integration file):** `add --from` and `remove` each name a confirmation
  past a shortened budget and write nothing; `add`, `remove` and `realign` each
  rethrow a confirmation error that is not an expiry; a DB-less cell drives
  `remove` at a silent server and asserts the raw "Unable to start a transaction"
  error, with the command returning.

#### S-R9-2 Minor — the lock cost is recorded

- **Action:** a second D-14 addendum records the `AccessShareLock` held for the
  budget, the migration it blocks, and the queue behind it. The usage text and the
  README tell operators not to leave a prompt open while migrations deploy.

#### T-R9-3, T-R9-4, F-R9-4, S-R9-4 / F-R9-3 Minor

- **T-R9-3:** the members search route test pins `a_b%\` reaching both
  `contains` clauses escaped.
- **T-R9-4:** a control cell asserts the singleton path exists and that
  `src/lib/tenant-context.ts` does reach it through the same walker and target.
- **F-R9-4:** the usage text and the timeout message both take the budget from
  `confirmationBudgetText()`, in one unit. The README cites the constant.
- **S-R9-4 / F-R9-3:** the Promise executor is on the allowlist. A local helper
  called on the spot and a named function passed by reference stay refused, stated
  in the header; no real-tree site uses either.

#### Red proof — round 9, unit and gate

Run in a worktree copy. Each mutation was applied on its own; at baseline every
cell passes. Each gate row counts the cells across both gates.

| Mutation | Cells that failed |
|---|---|
| `ARRAY_ITERATORS` without `sort` | the `sort` allow cells and the membership cells (4) |
| `PROMISE_COMBINATORS` without `allSettled` | the `allSettled` allow cells and the membership cells (4) |
| `PROMISE_CHAIN` without `finally` | the `finally` allow cells and the membership cells (4) |
| `TRANSACTION_RUNNERS` emptied | the `$transaction` allow cells and the membership cells (4) |
| any property-access callee runs inline (the round-8 default) | listener, `push`, `setTimeout.call`, `process.nextTick` (8) |
| any other callee runs inline | `setTimeout`, `after`, element-access scheduler, `queueMicrotask`, local helper that keeps its argument, the round-7 non-opener helper cell (11) |
| everything counts as settled | `void then`, floating async IIFE, `void $transaction` (6) |
| an awaited async `forEach` counts as settled | the awaited async `forEach` cells (2) |
| any `Promise.*` combinator settles | the `Promise.race` cells (2) |
| a Promise executor at any argument position | the non-first-executor cells (2) |
| no Promise-executor form | the executor allow cells (2) |
| array elements not followed to a combinator | the array-element IIFE allow cells (2) |
| a settled chain does not settle its receiver | the awaited-chain allow cells (2) |
| getter / setter / constructor not function-like (three mutations) | that kind's cells (2 each) |
| an arrow's expression body is not settled | every returned-form allow cell, including round 8's IIFE and round 7's `Promise.all(map)` cells (14) |
| an unsettled async IIFE runs inline | the floating async IIFE cells (2) |
| members search not escaped | the escape cell |
| import-graph target path wrong | the target control cell |

#### Red proof — round 9, integration

Run in a worktree copy against the real database, workers stopped. Each mutation
was applied on its own; at baseline the seven filtered cells pass.

| Mutation | Cells that failed |
|---|---|
| classifier also matches P2028 | the silent-server `maxWait` cell |
| no pool connection timeout | the silent-server `maxWait` cell (the command never returns) |
| `add`'s expired confirmation not named | the `add --from` named-timeout cell |
| `remove`'s expired confirmation not named | the `remove` named-timeout cell |
| `realign`'s expired confirmation not named | the `realign` named-timeout cell |
| every error treated as an expired confirmation | the three rethrow cells and the silent-server cell |

#### Round 9 verification

- **Unit:** 1034 files / 15798 tests pass; `next build` and `tsc --noEmit` pass.
  eslint reports nothing on any changed file. Both RLS-context gates exit 0 on the
  real tree.
- **Integration:** 113 files / 707 tests pass, with both workers stopped.
- **Citation gate:** passes over this document and the SSO deviation log.
