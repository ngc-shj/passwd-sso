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
