# Coding Deviation Log: sso-tenant-domain-alias

Phase 2 implementation of `docs/archive/review/sso-tenant-domain-alias-plan.md`
(revision 5). Recorded directly rather than via the Ollama `generate-deviation-log`
helper: the plan is 1759 lines and the branch diff is large, and every entry below
is a decision the orchestrator made knowingly with the evidence in hand, so a
round-trip through a summariser would lose the *why* that makes the entry useful.

Entries are deviations, clarifications of things the plan deliberately left
unspecified, and empirical corrections where the plan's stated mechanism did not
match the running system.

---

## D-1 — The plan's CHECK-violation error shape is wrong for this repo's driver

**Plan (C1 acceptance criteria)**: a CHECK violation is asserted via
`$executeRawUnsafe` and `P2010` with `meta.code === "23514"`, "the shape
`audit-outbox-concurrent-delivery.integration.test.ts:36-49` already uses".

**Measured**: under this repo's `@prisma/adapter-pg` driver adapter, the SQLSTATE
is nested at `meta.driverAdapterError.cause.code`, not `meta.code`.

**Resolution**: `tenant-claim.integration.test.ts`'s `isCheckViolation` helper
accepts both shapes. Had the plan's form been used verbatim, the assertion would
either have failed outright or — worse — have passed vacuously by matching
`undefined !== "23514"` in a negated form.

This is exactly the class round 4 predicted would be settled by the toolchain
rather than by another review round.

## D-2 — `findOrCreateTenantForClaim(db)` has no default parameter

**Plan (C4)**: `db: TxOrPrisma = prisma`.

**Implemented**: `db: TxOrPrisma`, required.

**Why**: with the default, calling it on the global proxy outside a transaction
runs `advisoryXactLock`'s `pg_advisory_xact_lock` in autocommit mode, where the
lock releases at the end of the statement — a silently disarmed lock, and the
lock is C4's declared adjudication authority for I6. Round 4 raised this
("the `TxOrPrisma` default disarming the lock", N10/N4) and explicitly deferred
it to Phase 2. Both real call sites already pass a `tx`, so making the parameter
required costs nothing and converts a latent footgun into a compile error.

`resolveTenantByClaim` keeps its default — it only reads.

## D-3 — Resolution order: the `externalId` fallback runs BEFORE `storableClaimSchema`

**Plan**: de-specified. C3 says the resolver "returns `null` rather than throwing
when the claim fails `storableClaimSchema`"; D1 says it "falls back to
`Tenant.externalId` (exact match on the raw claim, today's semantics) when no
`tenant_claims` row matches". The two together do not fix an order.

**Implemented order**: claim row (incl. revoked) → `externalId` fallback →
`storableClaimSchema` → create.

**Why**: validating first would make SC9's ASCII narrowing bite in release 1. A
deployment whose tenant resolves today through a non-ASCII `external_id` would
stop resolving the moment this PR lands — the same lockout shape this PR exists
to fix, introduced by the fix. Running the fallback first keeps NF2 exactly true
for release 1 ("no behaviour change for deployments that never register a second
claim string"), which is the entire point of expand-and-contract. SC10 (release 2)
removes the fallback and the narrowing takes effect then, with C12's pre-flight
query having surfaced the affected rows in the meantime.

**Consequence, recorded because it invalidates a stated acceptance criterion**:
round-3 T25 asked that C4's `storableClaimSchema`-reject case keep "its two
existing no-write assertions (`findUnique` and `create` not called)". Under this
order both `tenantClaim.findUnique` and the fallback `tenant.findUnique` genuinely
run before validation, so only the `create` non-call is assertable. The test
asserts `tenant.create` was not called and documents why the `findUnique`
assertion was dropped. Asserting a non-call that the control flow makes false
would have been a test written to match a fiction.

## D-4 — A revoked claim row suppresses the fallback

**Plan**: D2 fixes revoked-claim semantics for `findOrCreateTenantForClaim` and
for the CLI's `add`, but does not say what the *resolver* does when a revoked row
exists and an `externalId` row also matches.

**Implemented**: a revoked row refuses with **no** fallback. (Round 4 changed
the SHAPE of that refusal from `null` to `{ kind: "revoked"; tenantId }` — see
D-36 — but not this decision: the fallback is still not consulted.)

**Why**: the backfill wrote a claim row for every `external_id`, so a revoked
claim will very often have a matching `externalId` row still present (release 1
does not stop writing that column). Falling back would resurrect exactly the claim
an operator just revoked — silently undoing an incident response.

## D-5 — Double-collision now throws instead of returning `null`

**Before**: `findOrCreateSsoTenant` caught a second `P2002` and returned `null`
("extremely unlikely double collision"), which the caller mapped to a deny.

**Implemented**: the slug-suffix retry's failure is not caught; it propagates,
the enclosing `withBypassRls` transaction rolls back, and `src/auth.ts`'s catch
maps it to `provider_error` with no write.

**Why**: round 3 (CR9) established that the old recovery arm could not run anyway
— the first `P2002` leaves the Prisma interactive transaction in `ERROR` and every
follow-up statement returns `25P02`, so the "return null" branch was unreachable
in the shape it was written. The plan already deletes the corresponding test
(`tenant-management.test.ts:111`) as an unreachable path. Propagating is the loud
outcome; swallowing it would re-create a silent deny with no diagnostic.

### D-5a — a second stale C4 acceptance criterion, same cause

Surfaced by the Step 2-5 testing self-check. C4's "Mocked" acceptance-criteria
list still names a case: *"creating a tenant for a claim already registered to
another tenant → `P2002` → re-resolves to that other tenant, and no second tenant
row is created."*

That path is unreachable under the implemented control flow, for the same reason
`:111` was deleted (D-5): the advisory lock plus the `findClaimRow` read **before**
the create mean an already-registered claim never reaches `tenant.create()` at all
— it returns at `tenant-management.ts:98-105`. The outcome the criterion cares
about (no second tenant row; the caller gets the owning tenant) *is* tested, by
the first unit case and by the `raceTwoClients` integration proof; only the plan's
stated *mechanism* (`P2002` → recover → re-resolve) is stale, and it is stale
because round-3 CR9 removed that mechanism deliberately.

## D-6 — `identifierHashScope` is `null`, not `"unkeyed"`, when there is no email

**Plan (C6)**: `identifierHashScope: "tenant" | "global" | "unkeyed"`, with
`"unkeyed"` defined as what C8 emits "when no key material exists". The
no-email-at-all case is not covered.

**Implemented**: no email → `identifierHash: null` **and**
`identifierHashScope: null`. `"unkeyed"` stays reserved for "email known, pepper
unavailable".

**Why**: conflating the two would make the field claim a binding for a hash that
was never computed, and `"unkeyed"` is the signal an operator uses to detect a
missing-pepper misconfiguration — a null-email denial must not raise that signal.

## D-7 — Prisma has no `@import`; the backfill is duplicated and drift-asserted

**Plan (C1)**: the backfill statement lives in
`scripts/lib/tenant-claim-backfill.sql` and is "`@import`ed by the migration".

**Reality**: Prisma migrations have no include/import mechanism (round-4 Critical
N16, already acknowledged in the plan's own revision-5 preamble).

**Implemented**: the statement is copied verbatim into the migration, and
`tenant-claim.integration.test.ts` both (a) **executes** the standalone file
against seeded rows and (b) asserts, whitespace-normalised, that the migration
still contains it. The duplication is deliberate and mechanically pinned.

## D-8 — `IOS_APP_BUNDLE_ID`'s default was wrong and is corrected

**Found during C9** (raised by the user): the pre-existing default
`com.passwd-sso` does not match the shipped bundle identifier. `ios/project.yml`
— the file xcodegen consumes — sets `bundleIdPrefix: jp.jpng.passwd-sso` and
`PRODUCT_BUNDLE_IDENTIFIER: jp.jpng.passwd-sso` on the `PasswdSSOApp` target,
with App Group `group.jp.jpng.passwd-sso.shared`.

**Impact**: the server published `appIDs: ["<TEAM>.com.passwd-sso"]`, which no
installed app owns, so Universal Links silently fail to associate unless the
operator sets `IOS_APP_BUNDLE_ID` explicitly.

**Scope taken**: the server-side AASA chain only, because the Zod `.default()`
and the route's `DEFAULT_BUNDLE_ID` must agree — that agreement *is* C9's
acceptance criterion. Corrected in `src/lib/env-schema.ts`, the route and its doc
comment, `scripts/env-descriptions.ts`, the regenerated `.env.example`, and both
test expectations.

Corroboration that `jp.jpng.passwd-sso` is right and only the default was stale:
the pre-existing test case "uses custom bundle ID from IOS_APP_BUNDLE_ID" already
used `jp.jpng.passwd-sso` as its override fixture.

**Flagged, deliberately NOT changed** (separate identifier namespaces, or records
that must not be rewritten; all pre-existing, none touched by this PR):
- `ios/project.yml:103` — BGTaskScheduler id `com.passwd-sso.cache-sync`. A
  BGTask identifier is a free-form string that must match the app's own
  registration call, not the bundle id; changing it is an iOS-side change with
  its own verification.
- `ios/README.md:174-178, 197, 258` — stale target/App-Group table.
- `docs/archive/review/ios-autofill-mvp-verification-status.md` — a record of an
  actually-observed run.

**Side-effect fixed in the same edit**: with the default changed, the "uses custom
bundle ID" test set the override to the same value as the default, so it could no
longer distinguish "the env var was honoured" from "the default was used". The
override fixture is now `jp.jpng.passwd-sso.enterprise`.

## D-9 — Two orchestrator-side corrections to sub-agent output

Recorded because both are process failures that would have surfaced as CI or
push-time reds:

1. **`check-test-hygiene.sh` gate (c) blind spot.** The C9 batch edited
   `src/app/api/mobile/.well-known/apple-app-site-association/route.test.ts`,
   which brought that file's **eight pre-existing** `process.env.X = …` lines into
   the gate's changed-file scope. The gate is invisible until a file changes, and
   the batch did not notice. Converted to `vi.stubEnv`; the manual save/restore
   block collapsed, since `src/__tests__/setup.ts` already wires
   `vi.unstubAllEnvs()` in `afterEach`. This is the same class the C6 batch handled
   for `tenant-claim.test.ts` (9 lines) and `audit-logger.test.ts` (1 line) — ten
   plus eight, eighteen pre-existing violations in total, all now cleared.
2. **Unrequested `export`.** The C11 batch exported `scanAppEnvReaders` from
   `scripts/check-env-docs.ts` to feed its own throwaway derivation script. No
   caller imports it; the plan's instruction is to *reuse* the scanner and add no
   new one. Reverted to module-private.

## D-12 — `src/auth.test.ts` now mocks `@/lib/tenant/tenant-management`

**Before**: `src/auth.test.ts` did **not** mock that module — a fact rounds 2 and 3
both leaned on (M14, M27: "it exercises the real `findOrCreateSsoTenant`"). The
plan's C5 delta therefore assumed the dispatch would be driven through
`mockPrisma.tenantClaim`.

**Implemented**: `vi.mock("@/lib/tenant/tenant-management", …)` with
`resolveTenantByClaim` / `findOrCreateTenantForClaim` mocked at the two-function
boundary; `mockSlugifyTenant` dropped (no longer reachable from `src/auth.ts`).

**Why it is acceptable, checked rather than assumed**: the risk of this change is
that the I7 deny-row assertions go vacuous. They do not. What C5 owns is the
*dispatch and the ordering*, and the assertions that prove it are all still real:

- `expect(mockFindOrCreateTenantForClaim).not.toHaveBeenCalled()` on rows 3, 7,
  9b and 10 — this is now the *load-bearing* no-write assertion, and it is
  strictly more direct than the plan's `tenant.create` version.
- `expect(mockPrisma.tenantMember.upsert).not.toHaveBeenCalled()` on every deny
  row — `src/auth.ts:215`'s upsert is the other reachable write and it is still a
  real `mockPrisma` call, so a reorder that denied *after* upserting membership
  would still be caught (round-1 F10 / round-4 T33).
- `expect(mockPrisma.$transaction).not.toHaveBeenCalled()` on the deny rows.

Note that "assert `tenant.create` was not called" is vacuous in this file
**regardless of mocking**: after C4, `src/auth.ts` contains no `tenant.create`
call at all — it moved into `tenant-management.ts`. The plan's criterion was
written against the pre-C4 shape.

**Coverage actually given up**: `auth.test.ts` no longer exercises the real
resolver through the seam. That is covered instead by
`src/lib/tenant/tenant-management.test.ts` and
`src/lib/tenant/resolve-tenant-by-claim.test.ts` (unit) plus
`src/__tests__/db-integration/tenant-claim.integration.test.ts` (real Postgres,
including the `raceTwoClients` advisory-lock proof). The old P2002-retry case at
`auth.test.ts:372-396` was dropped rather than retargeted, because its mechanics
are now entirely internal to `findOrCreateTenantForClaim`; its equivalent exists
in C4's own suite.

## D-13 — The CLI is a deliberate second reader of `tenant_claims`

**Plan (D2/C3)**: "a forbidden pattern against bare `tenantClaim.findUnique`
outside the resolver", and the Implementation Checklist's "one
`tenantClaim.findUnique` in the whole codebase".

**Implemented**: one call site in `src/` (the module-private `findClaimRow` in
`tenant-management.ts`, shared by `resolveTenantByClaim` and
`findOrCreateTenantForClaim`), and **three in `scripts/tenant-domain.ts`**.

**Why the exception is correct**: the rule exists to stop a *fail-open* read —
a caller that reads a claim row and forgets the `revokedAt` filter, so a revoked
claim silently resolves. The CLI is the tool that **manages** revocation: D2's
own refusal logic needs the owning tenant *and* the revoked state together, and
`resolveTenantByClaim` structurally hides both (a revoked row returns `null`,
indistinguishable from "unregistered"). Routing `add`/`remove` through the
resolver would make the D2 recovery path — "`add` after `remove` must clear
`revokedAt` instead of reporting a success that leaves the tenant locked out" —
impossible to implement.

**Restatement of the invariant, scoped to where the hazard lives**: exactly one
`tenantClaim.findUnique` under `src/`. `scripts/tenant-domain.ts` is the
documented operator-tool exception. Note this remains a plan-level forbidden
pattern with **no runner** (the shape round-2 CR7 objected to); it is recorded
here so Phase 3 can decide whether it warrants a mechanical gate.

## D-14 — The CLI's confirmation prompt runs inside the open transaction

Every `tenant-domain` command opens `withBypassRls(...)` first, because C1 put
`FORCE ROW LEVEL SECURITY` on `tenant_claims` and `FORCE` binds the table owner
too (round-3 S3-3 — without the GUCs the CLI returns *silent wrong answers* at
incident time, not errors). `add`/`remove` then print the preview and await the
operator's confirmation **inside** that transaction.

**Known cost**: an idle-in-transaction session for as long as the human takes to
read the warning — and the warning is deliberately long, because it has to say
that registering a claim can absorb an existing user's entire personal estate.
On a deployment with `idle_in_transaction_session_timeout` set (common on RDS),
a slow operator gets the transaction killed mid-flow.

**Kept anyway, deliberately**, and the reason is not "no time":
- the failure mode is **loud** (an error), never a silent wrong answer;
- `add`/`remove` are idempotent by design (D2), so re-running after a timeout is
  safe and converges;
- the alternative — read/preview in one transaction, confirm, write in a second
  — reintroduces a TOCTOU window into exactly the revoked-claim ownership logic
  that four review rounds just settled. Trading a loud, recoverable failure for a
  silent race in the D2 path is the wrong direction.

Flagged for Phase 3 as a candidate hardening, not as a defect.

## D-15 — `ci-integration.yml` paths filter broadened to `scripts/**`

The plan asked for `scripts/tenant-domain.ts`. The implemented filter is
`scripts/**`, which is strictly more conservative (the integration suite runs on
more PRs, never fewer) and matches the fact that `scripts/bootstrap-rds-roles.mjs`
is already integration-tested from `src/__tests__/db-integration/` without the
filter naming it. Recorded so the widening is not mistaken for an accident.

## D-16 — `worker-policy-manifest.json` needed a new entry

Not anticipated by the plan or by the Step 2-1 gate survey. `scripts/tenant-domain.ts`
constructs a `PrismaClient`, which matches `check-worker-policy`'s candidate-module
regex, so the new file silently joined that gate's input set and had to be
classified. Added to `$documented-exclusions` following the two existing
one-shot-operator-CLI precedents (`migrate-account-tokens-to-encrypted.ts`,
`migrate-webhook-secrets-v1-to-v2.ts`).

This is precisely the "a gate's pattern is `<all .ts under scripts/>` and a new
file joins its input set without appearing in any existing reference" class the
Step 2-1 CI-parity survey exists to catch — and this one it missed. Recorded so
the survey's own blind spot is visible.

## D-17 — Memory cross-check direct hit: `IdentifierHashScope` was a bare union

Step 2-4's user-feedback cross-check found one **direct hit**. C6 introduced
`type IdentifierHashScope = "tenant" | "global" | "unkeyed"` — a new set of three
enumerated string values expressed as a bare TypeScript union, which is exactly
what the standing feedback rule forbids (the user's note: *"定数化するの、よく漏らす
のですけれども"*, recorded after catching the same miss twice in one PR).

**Fixed in Phase 2, not deferred**, per the rule's own disposition: replaced with
a `const`-object plus a derived literal-union type, matching the repo's
established `AUDIT_ACTION` / `TENANT_ROLE` convention, and every literal usage
replaced across source and all three test files. Residual-literal grep is clean.

**Process failure worth naming**: that same memory says explicitly *"When
delegating to a sub-agent: include [this rule] in the brief — this prevents the
gap from re-appearing in newly-generated code."* I did not put it in any of the
seven batch briefs, so the gap re-appeared exactly where the memory predicted.
The cross-check caught it, but one step later than it should have.

**Checked and deliberately not changed**: `AuthLoginFailureReason` gained a sixth
member (`tenant_claim_unmapped`) and is still a bare union. The rule scopes itself
to a *new* module introducing an enumerated set; this union is pre-existing, its
literals are spread across many call sites, and converting it is a refactor of its
own rather than part of this PR.

## D-18 — Step 2-5 self-R-check: two Majors found and fixed

Functionality and testing returned **No findings**. Security returned two Majors,
both verified against the code before acting, both fixed in Phase 2 per the
disposition rule.

**R49 — a stale control description in the schema SSoT.** `src/lib/env-schema.ts`'s
inline comment on `AUDIT_IDENTIFIER_PEPPER` still read *"unset falls back to an
empty-key HMAC (degraded but still functional; a warning is logged)"* — the
pre-C8 behaviour that C8 exists to retire. Rewritten to the real three-tier
resolution.

**This is a class I closed only partially.** When the C12 batch reported the same
staleness in `scripts/env-descriptions.ts`, I fixed that one file and did not
enumerate the rest of the class — leaving the copy in the file that *is* the
schema's source of truth. The class, enumerated properly this time, is: the Zod
schema comment (was stale, fixed), the env sidecar (fixed earlier), `.env.example`
(generated from the sidecar), `docs/security/audit-log-schema.md` (correct — it
describes the empty-key HMAC explicitly as *"before C8"*), and
`auth-failure.test.ts:114` (correct — it asserts the derived hash *differs from*
an empty-key HMAC). The plan and review documents also mention it and are
historical records that must not be rewritten.

**R2 — the printable-ASCII predicate had four copies, one drift-guarded.** The
C1 CHECK is the authority. The backfill's copy and its extracted `.sql` twin were
already pinned to each other by D-7's drift test. But `scripts/tenant-domain.ts`'s
pre-flight queries carried a **third, independent copy with no guard at all** —
and pre-flight is precisely the tool an operator runs to learn which rows the
CHECK will reject *before* migrating, so a drifted copy yields a confident
"all clear" at the one moment it matters.

Fixed by giving the predicate a single source, `NON_PRINTABLE_ASCII_SQL_CLASS`
in `tenant-claim-registry.ts`, which the pre-flight queries now bind as a **query
parameter** (`external_id !~ $1`) rather than spelling again — so no
interpolation, and the raw-SQL gate's Layer 2 stays inapplicable. The two `.sql`
files cannot import it, so `tenant-claim-registry.test.ts` gained a drift guard
that reads both files and pins them against the constant, plus a behavioural
cross-check that the SQL class and the JS predicate classify the same values
identically.

The guard was **red-proved on a throwaway copy** (never by mutating real source):
changing the range end from `\x7E` to `\x7D` — the exact one-character revision
the guard exists to catch — reds both file assertions.

Also folded in while here: the JS mirror now reuses the repo's existing
`asciiPrintable` constant (`src/lib/validations/common.ts`) instead of
re-declaring the same character class, with `storableClaimSchema`'s `.min(1)`
supplying the non-empty half that constant's `*` quantifier leaves open.

## D-10 — CI gate parity: two gaps run manually rather than added to `pre-pr.sh`

`extract-ci-checks.sh` yields 13 gates. Eleven are already covered by
`scripts/pre-pr.sh` under a different spelling (`node scripts/checks/check-<x>.mjs`
rather than `npm run check:<x>`; `npx eslint .` for `npm run lint`; the production
build for `npm run typecheck`). Two are genuine gaps:

- `bash scripts/check-state-mutation-centralization.sh`
- `npm run licenses:check:strict` / `:cli:strict` / `:ext:strict`

Both are **pre-existing** and unrelated to this diff. **Deferred parity gap** —
reason: extending the shared `pre-pr.sh` aggregate is a repo-wide change outside
this PR's scope, and this PR touches neither dependency manifests nor the state
mutation surface. They are run explicitly in Step 2-4 instead.

## D-11 — Two gates cannot be judged before the branch is committed

`check-test-hygiene.sh` and `check-security-matrices` both diff against
`main...HEAD`. With nothing committed (per the standing instruction), the first
reports "no changed test files — skipping" and the second compares the freshly
regenerated `docs/security/deletion-retention-matrix.md` against git HEAD and
reports drift. Neither is a defect:

- gate (c)'s criterion was verified directly with its own regex over every
  changed test file — zero matches.
- the matrix file is correctly regenerated on disk; the gate goes green once the
  branch is committed.

Both must be re-run after the first commit.

---

# Round-1 fix round (commit `c360415fd`)

Everything above was introduced by Phase 2. The entries below were introduced by
the round-1 fix commit, which changed contracts the plan states. They were
recorded only narratively in
`docs/archive/review/sso-tenant-domain-alias-code-review.md`'s Resolution Status;
they belong here, with the reasoning rather than the diff.

## D-19 — C4's `{ id } | null` return became a discriminated `ClaimTenantResolution`

**Plan (C3/C4)**: `findOrCreateTenantForClaim(...): Promise<{ id: string } | null>`,
and the dispatch table's row 8b exists *because* "`findOrCreateTenantForClaim`
returns `{ id } | null`".

**Implemented**: `Promise<ClaimTenantResolution>`, where `ClaimTenantResolution` is
`{ kind: "tenant"; id: string } | { kind: "claim_taken" } | { kind: "claim_invalid" }`.

**Why**: round-1 M1. Phase 2 gave `null` a third, operator-reachable meaning (D2's
revoked-claim refusal) on top of the two the plan had, and `createUser` in
`src/lib/auth/session/auth-adapter.ts` read that `null` as "no claim was
presented" — falling through to a fresh `isBootstrap` tenant with
`role: "OWNER"`. A deliberately revoked claim therefore admitted one sign-in, as
the owner of a new tenant, with no `tenant_claim_unmapped` row to show it. A
nullable return cannot distinguish "no tenant" from "refused", so two callers
adjudicating the same predicate necessarily read it differently and the weaker
reading allowed. The discriminant turns each outcome into a case the compiler
forces every caller to handle, and it is what lets M2's `CLAIM_REFUSAL_REASON`
map the two refusals to their two distinct audit reasons instead of collapsing
both into `tenant_mismatch`.

## D-20 — `add --from`: a new CLI verb, a new privileged operation, and no revoke-first requirement

**Plan (C7)**: `add --tenant <ref> --domain <domain> --by <label> [--yes]`, which
*refuses* when the named tenant does not own the named claim. No reassignment
path exists.

**Implemented**: `add … [--from <current-owner-uuid>]` moves a registered claim
from one tenant to another, atomically.

**Why the verb exists**: round-1 M5. The plan's refusal told the operator to run
`remove` on the owning tenant first, but `remove` is a soft delete (`revokedAt`
set, `tenantId` unchanged), so the following `add` re-enters the same refusal —
the instructed recovery loops, and the only exit is hand-written SQL. The
wrong-owner state is reachable with no operator action at all, because
`findOrCreateTenantForClaim` auto-registers `createdBy: "signin"` rows: one
sign-in with a mistyped or squatted claim binds it permanently to a junk tenant.
That falsified SC1's anti-deferral claim that "the CLI fully restores a
locked-out tenant".

**Why revoke-first is deliberately NOT required**: it would add a step without
adding a check — `--from` already supplies the "name the losing side"
deliberateness that the requirement would be standing in for — and it opens a
window in which the claim resolves to nobody, so **both** tenants' members are
denied until the second command lands. Trading one atomic move for a
self-inflicted lockout window is the wrong direction for a tool whose reason to
exist is ending lockouts. A revoked row is reassignable too and comes out active:
the operator has just asked for this claim to select the gaining tenant.

**Guards, because this is a new privileged operation**: `--from` takes a bare
tenant UUID and nothing else — not a slug, claim or `external_id` — because a
reassignment can deny an entire tenant's members and so must not be reachable by
a typo; the other `--tenant` ref forms stay as they are. It refuses when `--from`
is not the row's actual owner, and when the claim is registered to nobody. Before
writing, it prints both tenants (id, name, slug, **active member count**) plus
the row-6/9a absorption warning and asks for confirmation. The write is
`updateMany` with the owner re-asserted in `WHERE`, not `update`: the
confirmation prompt runs inside the open transaction (D-14) but the read happened
before the human answered, so a concurrent change must surface as `count === 0` —
a clean refusal — never as a silent overwrite of an owner the operator was never
shown. `createdBy` is left untouched by the move (M2 / SC8): it records who first
registered the claim, which is the evidence an incident needs.

## D-21 — `unmapped --days`

**Plan (C7)**: `unmapped` takes no flags; the window is `AUDIT_LOG_RETENTION_MIN`
and the command "prints the retention window".

**Implemented**: `unmapped [--days <n>]` — `n` a bounded positive integer,
defaulting to that same floor — and the output names the number of days it
actually covered, stating that this is a *query* window and not this deployment's
retention.

**Why**: round-1 Func F4. `AUDIT_LOG_RETENTION_MIN` is the configurable **floor**,
so on any deployment retaining longer than the floor the plan's wording asserted
that still-retained denials had been checked when the query had never looked at
them. The failure mode is an operator concluding "nothing was denied" at incident
time from a window they did not choose. Honest wording alone was not enough: it
has to end in an action, and "re-run with `--days <n>`" needs the flag to exist.

## D-22 — `hd` is selectable in `AUTH_TENANT_CLAIM_KEYS`

**Plan (SC7)**: claim-source attestation deferred, on the stated premise that the
exploit needs "a deliberate `AUTH_TENANT_CLAIM_KEYS` configuration naming an
IdP-asserted attribute". `hd` is a hard-coded Google-only fallback consulted
after the key list, not a member of it.

**Implemented**: `hd` may be named in `AUTH_TENANT_CLAIM_KEYS`, and carries a
provider gate (`account.provider === "google"`) wherever it is reached — through
the key list or through the fallback. `DEFAULT_TENANT_CLAIM_KEYS` is untouched;
unset behaviour is byte-identical.

**Why**: round-1 M4. Four of the six shipped defaults (`organization`, `org`,
`company`, `company_id`) are exactly the class SC7's premise treats as needing
deliberate configuration, and all six are tried *before* `hd`, so a
multi-connection SAML deployment that never set the variable was already inside
the unsafe configuration rather than outside it. Worse, the documented escape
hatch named a state an operator could not reach: `AUTH_TENANT_CLAIM_KEYS=hd` was
not expressible. The user chose this over the stricter alternative — narrowing
`DEFAULT_TENANT_CLAIM_KEYS` to attested sources only — which is a breaking change
for deployments relying on those keys.

The provider gate is what turns "named `hd`" into "attested by Google": a SAML
profile carrying a self-asserted field literally named `hd` does not resolve.
**That same gate makes `AUTH_TENANT_CLAIM_KEYS=hd` a harmful configuration on a
SAML-only deployment** — extraction returns `null` for every sign-in, which is an
allow rather than a denial, so a first-ever SAML user gets their own bootstrap
tenant as OWNER, invisibly, and the absorption path is armed for later. Round 2
(documentation finding D-A) found the READMEs recommending exactly that to
multi-connection SAML deployments; the documentation now scopes the
recommendation to Google sign-in and gives SAML deployments per-connection tenant
binding as their answer.

## D-23 — C8's pepper floor is two different predicates, deliberately

**Plan (C8)**: one floor — the identifier pepper must be "real key material".

**Implemented**: two predicates that do not agree.

- `src/lib/env-schema.ts`: `AUDIT_IDENTIFIER_PEPPER: hex64.optional()` — exactly
  64 hex characters, or absent.
- `src/lib/audit/auth-failure.ts`: `explicit.length >= MIN_KEY_MATERIAL_LENGTH`
  (32) over any characters at all.

**Why the asymmetry is deliberate**: `auth-failure.ts` reads `process.env`
directly rather than the validated `env` singleton, and it runs in processes that
never parse the full schema — the audit-outbox and retention-GC workers — so a
value that never passed `hex64` still reaches the derivation site. The check
there is the last line of defence and therefore has to be independent of the
schema rather than a restatement of it. It is looser on purpose because it
answers a different question: not "is this the shape this deployment is required
to configure?" but "is there enough key material to key an HMAC at all, whatever
this process was started with?" — and a one-byte HMAC key is worse than the
honest unkeyed branch, because the record then claims key material it does not
have (round-1 Sec F5). The schema is free to be stricter, and is, holding the app
to the same 256-bit shape as every other secret in `envObject`.

**Consequence recorded for operators**: the schema predicate is a boot-time
breaking change — the variable already exists on `main` — for any deployment with
a set-but-not-64-hex pepper, and correcting it changes the HMAC key, so new
`identifierHash` values no longer correlate with the ones already in
`audit_logs`. Both READMEs now carry this under *Upgrade notes: environment
variables that now fail closed* (round-2 documentation finding D-C), together
with the same boot-failure shape for `COOKIE_PARTITIONED` and
`BREAKGLASS_COOLING_OFF_SECONDS`.

## D-24 — Environment fact: the dev DB's integration failures are the live outbox worker, not the tests

**Causally proven, not inferred.** With the `audit-outbox-worker` container
stopped, the full integration suite is 95/95 files / 426 tests / exit 0. With it
running, a *different* pre-existing test fails on each run. The mechanism is the
worker draining `audit_outbox` into `audit_logs` concurrently with
`deleteTestData`, against `audit_logs_tenant_id_fkey`, which is `RESTRICT`: the
worker inserts a child row for a tenant the cleanup is in the middle of deleting.

**Why it matters next time**: the non-determinism is local-only — CI runs no such
container — so it is not a defect to "fix" in the tests, and chasing it there
costs a round. Stop the worker before a local integration run and restart it
afterwards. One member of the class was observed outside this PR's files
(`src/__tests__/db-integration/rate-limit-fail-closed.integration.test.ts`), so a
failure in an unrelated suite is not evidence against this explanation.

## D-25 — Environment fact: the local unit suite is not environment-equivalent to CI

`.github/workflows/ci.yml` sets `AUTH_SECRET`, `SHARE_MASTER_KEY`, `AUTH_URL`,
`VERIFIER_PEPPER_KEY`, `REDIS_URL` and `DATABASE_URL` at **job level** for
`app-ci`. The divergence therefore runs in the unusual direction — CI supplies
variables the local shell does not — which is why a test asserting the *absence*
of `AUTH_SECRET` passed locally and failed in CI (round-1 CR1), and why C8's
no-key-material branch never executed in CI at all.

**Standing consequence**: a test that depends on an environment variable being
unset must assert that precondition itself (`vi.stubEnv(<key>, "")` in
`beforeEach`) rather than inherit ambient absence, and a change to that surface
should be re-run under the **full** `app-ci` env block, not just the one variable
a failure happened to name.

---

# Round-2 fix round (commit `58af27fc9`)

Recorded here in the round-3 fix round, because round 3 (**Test A1**) found them
recorded only as a commit message. All six change a contract the plan states.

## D-26 — `sanitizeTenantClaimValue` rejects where the plan says it strips

**Plan (C6, lines 1033-1036)**: the claim reaches audit metadata "with
bidi/zero-width characters **stripped** — asserted with a fixture containing
U+202E".

**Implemented (round 2)**: the value is **refused**; the test asserts
`toBeNull()`.

**Why the criterion is superseded, not merely unmet**: this function's output is
the resolution key and the stored `Tenant.externalId`/`name`, not a display
copy. Stripping is what lets `ac<U+00AD>me.example` pass C1's printable-ASCII
CHECK and select the *existing* `acme.example` tenant, with nothing recorded
anywhere — the character is gone before storage, so `preflight`'s non-ASCII
report can never see it. The plan's criterion was written when the strip was
believed to be a display-only concern.

**Round 3 amended this again** — see D-27 — because rejecting without
distinguishing the refusal from an absent claim turned a denial into an allow.

## D-27 — `extractTenantClaimValue` returns a discriminated result

**Plan (C2/C6)**: `extractTenantClaimValue(...): string | null`, and revision 3
explicitly *dropped* the shape change round 2 had proposed for it (see the
plan's "Simplifications this revision also makes").

**Implemented (round 3)**:
`{ kind: "claim"; value } | { kind: "absent" } | { kind: "malformed"; display }`.

**Why**: round-3 M1. D-26's reject arm produced the same `null` as an absent
attribute, and both consumers read `null` as "the IdP asserted no claim", which
is an ALLOW. Measured against round 2, an existing member of tenant A
presenting `beta.example` + U+200B went from a `tenant_mismatch` denial to a
sign-in; on the first-ever-sign-in path it produced a fresh bootstrap tenant
with role OWNER and the row-6/9a absorption armed for the next sign-in. That is
round-1 M1's overloaded `null`, one layer up, and the same remedy applies.

Revision 3's reason for dropping the shape change was that it would break four
consumers and nine assertions. There are now **two** consumers (`src/auth.ts`
only), because C5 moved the dispatch, so the cost that justified the
simplification no longer exists.

**The classification is per-cause, not per-`return null`** — the omission that
produced M1 in the first place:

| Cause | Arm | Why |
|---|---|---|
| key absent / `undefined` / `null` | absent | nothing was asserted |
| empty or whitespace-only string | absent | an empty assertion is not an assertion; IdPs emit empty attributes for unset fields, and refusing would deny working deployments (NF2) for no gain — the same actor can omit the key |
| value present, not a string | **malformed** | the key the operator made authoritative WAS asserted; falling through would let a lower-priority, self-asserted attribute decide the tenant |
| unsafe display characters | **malformed** | D-26's case, now routed to a denial instead of an allow |
| longer than `MAX_TENANT_CLAIM_LENGTH` | **malformed** | a claim that cannot be stored cannot be honoured |

A malformed read also **stops the key walk**, for the same reason: continuing
would make the tenant depend on which higher-priority key happened to be
unreadable.

**Correction (round 4): the narrowing above was wrong, and so was the cost
recorded for it.** Both the functionality and the security expert found it
independently. The paragraph originally read *"That deployment is unlikely to
have been working — it would have been placing every user in their own
bootstrap tenant"*, which is **false for existing users**: the claim-less path
returns `{ ok: true }` at `src/auth.ts`, so those users simply signed in.
Bootstrap-tenant creation happens only on a first-ever sign-in.

The reachable case is not exotic either. SAML attributes are multi-valued by
specification and BoxyHQ Jackson surfaces them into the OIDC profile as JSON
arrays, so a deployment whose `organization` or `company` — both in
`DEFAULT_TENANT_CLAIM_KEYS` — arrives as `["acme"]` went from allowing every
sign-in to denying every sign-in. With `AUTH_TENANT_CLAIM_KEYS="groups,hd"`
it is worse: round 2 skipped the array-valued `groups` and resolved through
`hd`; round 3 stopped the walk at `groups` and never read `hd` at all.

**Second correction, round-5 F9.** The sentence above originally read "went
from *resolving correctly* to denying", which is false — and it is the second
factual error in this entry. On `main` an array value hits
`if (typeof value !== "string") return null` and falls through, so the claim
never resolved: those users signed in CLAIM-LESS, into their existing tenant.
Round 4 restores that and fixes the lockout; it does not make the array
resolve. The residual, recorded rather than implied: in such a deployment a
first-ever SSO sign-in still reaches the claim-less path and gets a fresh
bootstrap tenant with role OWNER. If Jackson array claims are a supported
deployment shape, the fix is to unwrap a single-element string array at the
ingest boundary — deliberately NOT done here, because that is new resolution
behaviour rather than a regression repair, and three rounds of this branch
have been spent on defects introduced by fixes that went one step past their
finding. The multi-key case DID resolve correctly on main, and does again.

The arm now classifies as **absent**, and the walk continues. Denying was
conflating two decisions — *stop the key walk* and *deny the sign-in* — where
only the first followed from the stated reason. It also bought nothing: an
actor who can change an attribute's TYPE can equally remove the attribute, and
omission reaches the same claim-less path.

## D-28 — `unmapped` reads every non-SENT outbox status, and counts only *stranded* ones

**Plan (C7)**: `unmapped` reads `audit_logs` **union** *pending* `audit_outbox`
payloads.

**Implemented (round 2)**: the predicate is `status <> 'SENT'`. PENDING is not
the only status whose event is absent from `audit_logs`; PROCESSING and FAILED
are too, and they are exactly the degraded-worker case the union exists for.

**Amended (round 3, M5)**: the *reported* set is unchanged, but the
`undelivered` count — the operator-facing "your audit delivery is degraded"
signal — now excludes a PROCESSING row still inside the worker's claim lease.
An in-flight row is normal, and reporting it as degraded told an operator their
audit pipeline was broken in the middle of a lockout diagnosis. The staleness
boundary is `AUDIT_OUTBOX.PROCESSING_TIMEOUT_MS`, the worker's own reap
threshold, so the report and the component that acts on it agree whenever both
read the same environment.

**Corrected (round-5 F8)**: this originally claimed they "cannot disagree".
Round-4 F6 found that false — `AUDIT_OUTBOX.PROCESSING_TIMEOUT_MS` resolves
from the CLI process's own environment, and the documented way to run the tool
is from a workstation against a remote deployment — and corrected it at the
call site while leaving this entry stale. The report now prints the lease value
it applied.

## D-29 — `ClaimTenantResolution` gained a `claim_collision` arm

**Plan (D2)**: two outcomes — the claim resolves, or it is taken by a revoked
row.

**Implemented (round 2, F-A)**: a third refusal. Round-1 M3 made the backfill
exclude **every** side of a fold collision, which leaves the `UNIQUE(claim)`
slot free; without this arm a third spelling neither colliding tenant stores
verbatim would create a NEW tenant, register the claim, and outrank both
tenants' `externalId` fallback — denying their existing members and placing
their new ones in the new tenant.

Kept a separate arm rather than folded into `claim_taken` for round-1 M2's
reason: a third trigger wearing a second trigger's name is how the wrong remedy
gets applied. `CLAIM_REFUSAL_REASON`'s `satisfies` is what forced it to be
classified.

## D-30 — `createUser` emits its own AUTH_LOGIN_FAILURE

**Plan (C5/C6)**: the emit lives at the `signIn` callback, post-transaction.

**Implemented (round 2, M1)**: a second emit site in
`auth-adapter.createUser`'s `.catch`. On a first-ever sign-in `src/auth.ts`
returns early — there is no user row yet — so its emit never runs, and probing
a deliberately revoked claim left no audit row at all.

The emit stays **after** `withBypassRls` settles: `emitAuthLoginFailure` →
`logAuditAsync` resolves a tenant through its own `withBypassRls`, and nesting
that inside the open transaction is the R9 pool-exhaustion shape.

**Observability limit, stated rather than assumed** (round-3 S3-4): the emit
binds a tenant for `claim_taken` and `claim_collision`, which carry the owning
tenant. `claim_invalid` has none by construction, and neither does the round-3
`claim_malformed` refusal in `src/auth.ts`'s first-ever-sign-in branch — so
those two dead-letter, and the synchronous structured log line is their durable
record. There is nothing to bind them to; inventing a binding would file the
denial under an unrelated tenant.

## D-31 — `--tenant` no longer resolves a slug; `--from` never did

**Plan (C7)**: `--tenant <uuid|domain>`. Round-1 Func F8 widened it to
`uuid | claim | slug | external_id`.

**Implemented (round 2, F-F)**: slug removed. `slugifyTenant` collapses
`[^a-z0-9]+`, so the claim → slug mapping is many-to-one and the first tenant
to take a slug keeps it: one squatted sign-in (`"acme com"`) pre-empts the slug
an operator would later type (`acme-com`). `--tenant` names the GAINING side of
a reassignment, so a wrong resolution hands the claim to the squatter's tenant,
and `--yes` removes the visual check. `external_id` carries no such hazard — it
is `@unique` and matched verbatim — and it is the form that keeps a
backfill-skipped tenant nameable, which is what F8 was for.

Round 3 (**M3**) found both READMEs still documenting the slug form; they now
state the exclusion and why.

---

# Round-3 fix round

## D-32 — Display escaping is a third policy on the shared unsafe-character class

**Before**: the shared class (`src/lib/security/unsafe-display-chars.ts`)
offered detect and strip. Both ingest boundaries reject; nothing rendered.

**Implemented**: `escapeUnsafeDisplayChars(value, maxLength?)` rewrites each
member as its visible `<U+XXXX>` form, and every CLI print site plus the
malformed-claim audit metadata goes through it (round-3 A3).

**Why escape rather than strip**: stripping `ac<U+00AD>me.example` prints
`acme.example` — a *different*, existing claim. The reader is shown a value
that resolves and told it was refused. The escape is the only rendering that is
both safe to print and honest about what arrived.

**Correction (round-4 F4)**: "every CLI print site" was false when written —
`cmdAdd`'s post-write line printed `existing.createdBy` unescaped, 80 lines
below the site in the same function that escapes it. Fixed, and now covered by
a test that spies on `console.log` and asserts that no printed line mentioning
the label carries the raw character — the assertion that catches one missed
site among several, which a per-site test would not.

**Where it is applied, and why each**: `list` (claim + the unvalidated
operator-supplied `createdBy`), `unmapped` (claim, read out of
`audit_logs`/`audit_outbox`, neither CHECK-constrained, and rows predating this
PR's ingest boundary can carry U+202E), `preflight` (its entire purpose is to
report values that are not printable ASCII), and `printTenantSummary`'s
`tenant.name`. `--by` is additionally **rejected** at input, matching the claim
boundary: it is stored attribution, and what is stored stays what was typed.

## D-33 — The refusal's own tenant decides which tenant a lockout is filed under

**Plan**: silent on this; each refusal site chose independently.

**Implemented (round-3 F7)**: `refusalTenantId(refusal, existingTenantId)` —
the claim's owning tenant where one exists, the user's existing tenant
otherwise. One lockout was previously attributed to three different tenants
depending on which site observed it, and `tenant-domain unmapped` groups by
`tenant_id`, so one incident arrived as three unrelated groups — two pointing at
tenants the operator cannot act on, and the `null` one not arriving at all.

**Residual, considered and accepted** (round-3 S3-2): the tenant these rows land
on is chosen by the claim the caller presented, so someone who can complete an
IdP authentication can add rows to a tenant they do not belong to.
Per-`(tenant, claim)` write-time dedupe was **rejected on correctness, not
cost**: `unmapped` GROUPs BY exactly that pair and reports `count(*)`, which is
how an operator tells one confused user from a whole tenant locked out.
Collapsing duplicates would delete the number the report exists to show.

**Two corrections from round-4 S3.** The bound this entry originally cited —
"completed IdP authentications rather than unauthenticated requests" — does not
hold: with a live IdP session, re-authorization is a non-interactive redirect
chain, i.e. a scripted loop. The control that actually bounds it is
`withCallbackRateLimit` in `src/app/api/auth/[...nextauth]/route.ts` (60/min per
client IP, `failClosedOnRedisError: true`, `boundUnknownIp: true`), and an
accepted-residual entry has to name the control it relies on rather than a
bound that does not. The blast radius was also understated: these rows surface
in the **victim tenant's** admin audit viewer and CSV export. Both sinks are
safe (React escaping; `escapeCsvValue` + `CSV_FORMULA_TRIGGER_RE`), webhook
egress is closed (`claim` is in `EXTERNAL_DELIVERY_METADATA_BLOCKLIST`, so plan
C6 holds), and after D-35 the field carries a bounded ASCII diagnosis rather
than attacker-chosen text — but it is still content another tenant's console
displays.

## D-34 — `deleteTestData` retries a transient conflict instead of re-ordering again

**Implemented (round-3 M4)**: the cleanup transaction is wrapped in a bounded
(4-attempt) retry on `40P01`, `40001` and `23503`, and each retry is announced
on `console.warn`.

**Why not another re-ordering**: this transaction and the live outbox worker
touch the same `audit_outbox` rows, `audit_logs` rows and `tenants` row, and the
worker's acquisition order is not ours to choose — re-ordering relocates the
cycle rather than removing it. **No specific cycle is claimed**: the exact
interleaving behind the observed `40P01` was not reproduced, and asserting an
untraced mechanism is how the previous two rounds' wrong diagnoses happened.
What is certain is that the conflict is transient, which is all the remedy
needs.

The bound is what keeps it from masking a real FK-ordering bug in the delete
list — that fails all four attempts identically.

**Verified, with its limit stated**: six consecutive local integration runs
**with the worker container live** — the configuration D-24 recorded as
reliably red — gave five clean 95/95 runs and one failure in
`webhook-delivery-durable.integration.test.ts` (`R2c: concurrent failures
increment fail_count atomically`), a file this PR does not touch. The retry
itself **never fired** in those runs, so they are not evidence that it works;
`src/__tests__/db-integration/helpers.test.ts` proves the mechanism directly
against fabricated errors of both Prisma error shapes, including that it gives
up after four attempts.

---

# Round-4 fix round

Round 4 returned 9 Majors (after convergence) and 13 Minors — **more Majors
than round 3**, and almost all of them against round 3's own fixes. The
entries below are the contract changes; the corrections to D-27, D-32 and D-33
are made in place, above.

## D-35 — A claim refusal carries a DIAGNOSIS, not a rendering of the value

**Round 3**: `{ kind: "malformed"; display }` carried an escaped rendering of
the refused value, so an operator could see which claim their IdP had started
mangling. **Round 4** (user-chosen among three options): `{ kind: "malformed";
diagnosis }`, printable ASCII, describing the violation —
`refused: contains U+200B`, `refused: 312 characters (max 255)`.

**Why**: the rendering put an attacker-chosen string on the path
`metadata.claim` → `logAuditAsync` → a `jsonb` write → the CSV export → the
operator's terminal, and round-4 **S1** found the first consequence
empirically. The rendering was truncated at `MAX_TENANT_CLAIM_LENGTH` with a
UTF-16 `slice`, which splits a surrogate pair; Postgres rejects a lone
surrogate in `jsonb` with 22P02; `logAuditAsync` swallows the failure into a
dead-letter. So an actor could **suppress the audit record of their own denied
sign-in** by padding the claim past the cap with an emoji at the boundary.
Verified both halves directly — the JS output (`isWellFormed() === false`) and
`psql` rejecting `{"claim":"a\ud83d"}::jsonb`.

Four findings collapse into this one decision: S1 (suppression), S2/F5
(non-injective escape), and the F4/T4 pair about the CLI print sites, which now
matter only for values already in the database.

**What is lost, and why it is acceptable**: the audit row no longer names the
offending claim. The operator's remedy for this arm is at the IdP, so what they
need is which RULE the value broke — and the value is unregistrable, so
`tenant-domain add` could never have consumed it. Requirement F6 ("the audit
record names the claim, so the operator knows what to register") is about the
registrable population and is unaffected.

**Consequences kept**: `escapeUnsafeDisplayChars` remains, for pre-existing
database rows the ingest boundary never adjudicated. It lost its `maxLength`
parameter entirely — no caller needs one, and the parameter WAS the surrogate
bug — and it now escapes its own introducer (`<` → `<U+003C>`), so a literal
`<U+202E>` typed into `--by` cannot render identically to a real U+202E
(round-4 F5/S2, RS6). The same unguarded slice at
`src/lib/audit/auth-failure.ts` is now `.toWellFormed()`-guarded: it is the
shared boundary every caller crosses, and nothing enforced the "already ≤ cap"
precondition its safety rested on.

## D-36 — `resolveTenantByClaim` returns `ClaimLookup`

**Before**: `{ id } | null`, where `null` meant "a revoked row owns this claim"
OR "nothing owns it".

**Implemented**: `{ kind: "tenant"; id } | { kind: "revoked"; tenantId } |
{ kind: "unregistered" }`.

**Why**: round-4 **F1**, and this is the THIRD round to produce a finding
against a nullable return on this path (rounds 1, 3, 4). No consumer read this
`null` as an allow — the fail-open was genuinely closed, and the security
expert re-traced all four branches to confirm it — but one consumer read it as
"no owner exists" and filed its denial under the USER's tenant, while the
identical lockout reached through the no-membership path was filed under the
CLAIM's owner. `tenant-domain unmapped` groups by `(tenant_id, claim)`, so one
incident arrived as two groups, one naming a tenant the operator cannot act on,
and the `count(*)` D-33 relies on was split between them.

Recorded as a class closure, not an instance fix: this was the last
un-discriminated adjudicator on the sign-in path, and the compiler enumerated
every consumer the moment the type changed.

## D-37 — Whitespace is trimmed before the unsafe-character test, with an ASCII trim

**Round 3**: `UNSAFE_DISPLAY_CHARS_RE.test(value)` ran BEFORE `value.trim()`.
`\t \n \r \v \f` are C0 controls and therefore members of the unsafe class, so
`"acme.example\n"` — the ordinary shape of a pretty-printed SAML
`<AttributeValue>` — was refused and the sign-in denied (round-4 **T2**).
D-27's own table said whitespace-only was `absent`; that was true only for
U+0020, and the test sampled exactly that member.

**Implemented**: an explicit ASCII-whitespace trim (`[ \t\n\r\v\f]`) runs
first. Deliberately NOT `.trim()`: JS trim also strips U+FEFF, which IS in the
unsafe class, and stripping it would canonicalise a U+FEFF-prefixed claim onto
its existing neighbour — the exact F-D hazard the reject policy exists to
prevent, reintroduced by the fix for T2. Whitespace the ASCII trim leaves but
`.trim()` would take (U+00A0 and friends) is its own refusal arm, because
`normalizeTenantClaim` runs `.trim()` downstream and accepting it would mean
the value matched on is not the value asserted.

## D-38 — `unmapped` reports refused-at-ingest denials as a second bucket

**Plan (C7)**: `unmapped` reports `tenant_claim_unmapped` denials.

**Implemented**: it selects both claim-bearing reasons and prints them under
separate headings — *"Unregistered claims — remedy: `tenant-domain add`"* and
*"Claims REFUSED at ingest — `add` cannot help; the remedy is at the IdP"* —
with both counts always in the summary line.

**Why**: round-4 **F3**. `claim_malformed` maps to `tenant_mismatch` (correctly
— nothing is registrable, so `add` is not the remedy), and `unmapped` filtered
on `tenant_claim_unmapped` alone. An IdP that starts emitting a zero-width
character therefore denies EVERY sign-in in the deployment while the tool built
to diagnose lockouts prints *"No unmapped-claim denials in the last 30 days"*.
A denial class this tool cannot see is the same NF2-shaped invisibility the
tool exists to end. Both READMEs' runbooks now carry the third cause.

## D-39 — `parseFlags` refuses a repeated flag

Round-4 **S5**. `Map.set` overwrote, so `remove --tenant A --tenant B` acted on
B and `add --from A --from B` reassigned away from a tenant the operator never
named — on a destructive path where `--yes` removes the visual check. Same rule
the module already stated ("a flag the operator wrote must either take effect
or stop the command"); the member set now comes from the parser's own state
machine rather than from the spellings that happened to be reported.

## D-40 — The missing-store branch of the signIn callback denies

Round-4 **S4**, the FOURTH site of the overloaded-signal class. `if (store &&
extraction.kind === "claim")` conflated "this deployment could not propagate
the claim" with "no claim was asserted", so a valid claim was dropped and
`createUser` took the bootstrap path, granting OWNER of a fresh tenant with
nothing denied and nothing audited — round-1 M1's outcome by a third route.

Unreachable through the wired entry point (`tenantClaimStorage.run()` wraps
both Auth.js handlers and there is no other caller), and recorded anyway
because the previous test **pinned the fall-through as intended behaviour**,
which is precisely how the next entry point would have inherited it.

---

# Round-5 fix round

Round 5 returned 9 Majors and 13 Minors — the same count as round 4, and again
mostly against the previous round's fixes. The entries below are the contract
changes; corrections to D-27 and D-28 are made in place, above.

## D-41 — The refusal diagnosis moves to its own metadata key

**Round 4 (D-35)**: the malformed arm's diagnosis was written to
`metadata.claim`, prefixed `refused: `, and both READMEs told the operator to
key their remedy on that prefix.

**Round 5 (user-chosen)**: `metadata.claimRefusal`, a separate key.
`metadata.claim` means "the value the IdP asserted" and nothing else.

**Why**: round-5 S2, verified against the real ingest boundary —

```
tenant_id: "refused: contains U+200B"  →  { kind: "claim", value: "refused: contains U+200B" }
```

The diagnosis strings are printable ASCII under the length cap, so an actor who
controls the asserted attribute — the precondition this whole branch is written
against — can assert one verbatim and manufacture a row the shipped runbook
tells an operator to read as a machine-generated ingest refusal. **This is the
branch's own recurring class** (one representation, two meanings, one of them
trusted) reproduced in the audit schema while being fixed in the code. A
separate key cannot be forged from the value side at all.

Three findings collapse into this one change: S2 (forgery), F1/S3 (the report
bucketed on `reason`, which swept a genuine row-7 "registered to a different
tenant" denial under the heading "the remedy is at the IdP" — the opposite of
its README remedy), and the shape of T3's missing test.

**Egress (C6 re-decided, not inherited)**: `claimRefusal` is added to
`EXTERNAL_DELIVERY_METADATA_BLOCKLIST`. It carries no organisational data of
its own, but it is only meaningful alongside the claim, and the claim is
stripped; forwarding a bare "an asserted value was refused for containing
U+200B" tells a tenant-configured endpoint that an authentication was attempted
and mangled, which is the disclosure `reason` is already withheld for.

## D-42 — `ClaimLookup` gains `unstorable` and `collision`; one adjudicator decides both attribution and reason

**Round 4 (D-36)**: three arms — `tenant | revoked | unregistered`.

**Round 5**: five — `tenant | revoked | unstorable | collision | unregistered`,
with `lookupOwnerId` and `lookupRefusalReason` deriving attribution and audit
reason from the arm rather than from an inline truthiness test.

**Why, two findings**:
- **F2**: round 4 closed the attribution split for `revoked` and left
  `claim_collision` out, so a fold collision was still filed under the claim's
  owner on the no-membership path and under the user's tenant on row 9b — one
  lockout, two `unmapped` groups, and the `count(*)` D-33 depends on split
  between them. D-36 claimed the closure worked because "the compiler
  enumerated every consumer"; the compiler enumerates consumers, not
  attribution SOURCES, so the claim was stronger than the fix.
- **F3**: rows 7/9b never consulted `storableClaimSchema`, while
  `findOrCreateTenantForClaim` — the same predicate one call path away — did.
  A non-ASCII claim was reported as `tenant_claim_unmapped` and, after round
  4's headings, printed under "run `tenant-domain add`" — a command guaranteed
  to refuse it. R48: two adjudicators, verdict decided by which path the user
  happened to take.

**Cost**: two extra reads on the resolver's miss path. They run only after both
lookups have missed — i.e. only for claims that resolve to nothing — so an
ordinary sign-in pays for neither, and the create path re-probes once. Accepted
for one adjudicator over two that agree by convention.

## D-43 — Two more ingest arms corrected

- **Whitespace-only under EITHER trim is `absent`** (round-5 F4). Round 4's
  ASCII trim left a value that is entirely NON-ASCII whitespace — `"　"`,
  a realistic unset-field artefact from a JP-locale IdP — to fall through to
  the trim-residue arm and DENY. Both `main` and round 3 read it as absent.
  The round-4 fixtures parameterised the whitespace EDGE class over six ASCII
  members and reused that list for the whitespace-ONLY class, which is the
  per-sample-vs-derived miss round-4 T2 itself reported, one round later.
- **An unpaired surrogate is `malformed`** (round-5 T1). It is not in the
  unsafe class, not whitespace and usually under the cap, so it passed as an
  ordinary claim and reached `metadata.claim` verbatim — where the jsonb write
  fails with 22P02 and `logAuditAsync` swallows the row. That is round-4 S1's
  audit-suppression path, still open for ACCEPTED values after round 4 closed
  it for rendered ones. Refused at ingest as well as guarded at the audit
  boundary: a value this deployment cannot store should not be adjudicating
  tenant membership either.

## D-44 — The consumer end of the tenant-claim store fails closed

Round-5 S1, the **fifth** site of the overloaded-signal class and the one where
the OWNER grant actually happens: `getStore()?.tenantClaim ?? null` in
`createUser` collapsed "the deployment could not propagate a claim" into "the
IdP asserted no claim", and `pendingClaim === null` selects both the bootstrap
branch and `TENANT_ROLE.OWNER`.

Round 4 (D-40) closed the PRODUCER of this signal on the grounds that a test
pinning the fall-through is how a future entry point inherits it — and left the
consumer reading the same overloaded value, with its own test pinning it. The
two callbacks read the ALS independently, so a context lost between them passes
the producer's guard and lands here. Applying that standard to one end of a
two-ended signal and not the other is a partial fix.

The guard throws **inside** `withBypassRls`, so the refusal takes the same route
as every other one: the existing `.catch` turns it into an audit emit, and
aborting the transaction means no user, no tenant and no OWNER membership
survive. Throwing before the transaction would have skipped that catch and made
the denial silent — the property the guard exists to provide.

---

# Round-6 fix round

Round 6 returned 8 Majors and 6 Minors, plus four findings from an independent
Codex review of the same branch. The entries below are the contract changes; the
corrections to SC7 and SC8, and the new SC11, are made in the plan.

The round's defining decision is not in any single entry: three separate classes
had each been closed by hand and reopened twice or more, always by enumerating
members from a file instead of deriving them from the primitive that defines
them. Three mutation-verified guards now hold those classes — see the review
log's Resolution Status for each guard's red-proof table.

## D-45 — `metadata.claimRefusal` is a BRANDED type, not a string

**Round 5 (D-41)**: the diagnosis moved to its own metadata key, so an IdP could
not forge the signal from the value side.

**Round 6 (SEC-R6-3)**: `ClaimRefusalDiagnosis`, a branded string whose only
producer is `claimRefusal()` in the new `src/lib/tenant/claim-refusal.ts`.

**Why**: a separate key stops the IdP forging the signal; it does not stop a
caller in this repo from writing an arbitrary string into it, and
`emitAuthLoginFailure`'s parameter was a bare `string | null` with the guarantee
living in a comment ("every producer is `malformed()` in tenant-claim.ts"). That
comment was a survey of callers, i.e. exactly the shape this branch has been
finding wrong for six rounds. The brand makes it a compile error.

**It paid for itself immediately**: every test fixture that spelled a diagnosis as
a literal became a type error, so five files now call the real producer — which
also means the `refused: ` prefix asserted in those tests is production's spelling
rather than each file's private copy of it.

**Second producer, admitted deliberately**: `storableClaimSchema`'s refusal
(D-46) also emits one. Both are refusal ADJUDICATORS, and the brand is what makes
adding a producer a visible act rather than an accident.

## D-46 — the `unstorable` / `claim_invalid` arms carry a refusal diagnosis

**Round 5 (D-42)**: `ClaimLookup` gained `unstorable`, and `lookupRefusalReason`
gave it `tenant_mismatch` — the reason whose remedy is not "register the claim".

**Round 6 (F1)**: both arms now carry `refusal: ClaimRefusalDiagnosis`, derived
from `storableClaimSchema`'s own issue message rather than written out.

**Why**: round 5 fixed the REASON and left the FIELD. `tenant-domain unmapped`
buckets on whether `claimRefusal` is set (D-41), so a `tenant_mismatch` with a
claim and no diagnosis is byte-identical to a row-7 "registered to a different
tenant" denial — and this population was therefore printed under *"move the claim
with `add --from`"*, a command guaranteed to refuse it on the very predicate that
produced the arm. Round 4 had it right by accident (the population fell on the
refused side before the field split existed), so this is a regression against
round 4 introduced by round 5's fix.

Deriving the message from the schema's issue rather than hard-coding "not
printable ASCII" is deliberate: `storableClaimSchema` has four refinements, only
one of which is reachable from sign-in today, and a hard-coded message would
describe the wrong rule the moment that changes.

`printGroup` also prints BOTH fields when a row has both. An ingest refusal
carries no claim by construction; an unstorable one carries the value AND the
rule, and the operator needs the value to know which population is affected.

## D-47 — store loss is `store_unavailable` / `provider_error` at both ends

**Round 4/5 (D-40, D-44)**: the producer (`src/auth.ts`'s signIn callback) and the
consumer (`createUser`) were each made to fail closed on a missing
`tenantClaimStorage` context.

**Round 6 (F3 + SEC-R6-1, converged)**: they did so in two different judgement
vocabularies. The producer emitted `provider_error`; the consumer threw
`TenantClaimUnusableError("claim_invalid", null)`, i.e. `tenant_mismatch`.

**Why the consumer's word was wrong, not merely different**: `claim_invalid`'s
definition is "the claim fails `storableClaimSchema`", and on this path no
resolution runs at all. The resulting audit row carried neither `claim` nor
`claimRefusal`, so it matched none of the three rows in the READMEs' cause table
and fell outside `cmdUnmapped`'s `claim IS NOT NULL OR claim_refusal IS NOT NULL`
filter — a denial shaped so that nothing could report it. D-44's claim that the
refusal "takes the same route as every other one" was also overstated: with
`tenantId = null` it dead-letters, which is inherent (D-30) rather than a defect,
but was not what the entry said.

**Implemented**: `CLAIM_REFUSAL_REASON` gains `store_unavailable: "provider_error"`,
under the same `satisfies` that forced `claim_collision` to be classified when it
was added. `TenantClaimUnusableError.kind` widens from
`ClaimResolutionRefusalKind` to `ClaimRefusalKind` so the arm can name itself
instead of borrowing a resolution arm's word. `provider_error` joins the table's
value union — a small loss of precision for the other arms, accepted because the
alternative is two tables, which is the defect.

## D-48 — only `unregistered` reaches `findOrCreateTenantForClaim`

**Before**: `src/auth.ts` answered every non-`tenant` lookup by calling
`findOrCreateTenantForClaim`, which retook the advisory lock and re-ran four reads
to arrive at the arm `resolveTenantByClaim` had named one statement earlier.

**Implemented (round-6 F5)**: `refusalFromLookup(lookup)` maps a refusing lookup
onto its resolution arm, and `resolveTargetTenant` sends only `unregistered` to
the creator.

**Why it is more than a saved read**: attribution (`lookupOwnerId`), audit reason
(`lookupRefusalReason`) and diagnosis (`lookupRefusalDiagnosis`) were three
independent enumerations of `ClaimLookup`'s arms. D-42 recorded that round 4's
closure of the first was claimed on the grounds that "the compiler enumerated
every consumer", and that the compiler enumerates consumers rather than
attribution SOURCES — which is how `collision` came to be missing from one of
them. All three now read `refusalFromLookup`, so there is one source. The removed
call is what made two adjudicators of one question possible.

`claimRefusalOf` moved from `src/auth.ts` to `tenant-management.ts` and is
exported, so the CLI's bucket guard can ask production the same question the
dispatch asks rather than restating the answer.

## D-49 — `add`'s compare-and-swap covers `revokedAt`, not only the owner

**Round 1 (D-20)**: `add --from` re-asserts the owner in the `WHERE` so a
concurrent change is a refusal rather than a silent overwrite.

**Round 6 (raised independently by Codex)**: it re-asserted `id` and `tenantId`
only. The preview prints the row's revocation state and the write CLEARS it, so a
concurrent `remove` landing while the operator reads the absorption warning (which
is deliberately long — D-14) was silently undone: the move succeeded and set
`revokedAt: null`, reversing another operator's incident containment with no
notice to either of them.

**Implemented**: both mutating paths in `cmdAdd` assert the exact `revokedAt` they
read. `cmdRemove` already did, which is what made the asymmetry findable.

**The rule this generalises to, stated because the instance patch is not the
point**: every field the preview showed and the write changes belongs in the
`WHERE`. The two existing CAS tests could not catch this one — both race by
changing the OWNER, the field the old predicate did cover — so a per-field case is
what shows which fields are actually covered.

## D-50 — `AUTH_TENANT_CLAIM_KEYS` fails closed when it names no key

**Before**: the parser filtered empty entries away and returned `[]`, so `","`
behaved exactly like leaving the variable unset — the key walk read nothing and
fell through to the Google-only `hd` fallback.

**Round 6 (raised independently by Codex)**: two predicates, following D-23's
shape. `envSchema` refuses the value at boot; `parseTenantClaimKeys` throws for
processes that never parse the schema (it reads `process.env` directly, as
`auth-failure.ts` does).

**Why it matters**: on a SAML deployment the fall-through resolves no claim for
ANY sign-in, so first-time users are created in their own bootstrap tenant as
OWNER, invisibly, with the row-6/9a absorption armed for later — the outcome
D-22 already records for the deliberate `AUTH_TENANT_CLAIM_KEYS=hd`
misconfiguration, reached here by a typo instead. Throwing is fail-closed: it
reaches `src/auth.ts`'s signIn catch, which emits `provider_error` and writes
nothing.

**Narrower than the reviewer asked, deliberately.** Codex also wanted duplicate
keys and stray empty entries (`org,,tenant`) rejected. Neither has a failure mode
— a repeated key is read twice and takes effect once, and `org,,tenant` names
exactly the two keys it appears to — so rejecting them would fail the boot of
configurations that work today for no behavioural gain. Per the
no-false-technical-justification rule, a boot failure needs a consequence behind
it. Both READMEs' *"environment variables that now fail closed"* table gains the
row, and says which shapes still boot.

## D-51 — the whitespace-only arm runs BEFORE the unsafe-class test

**Round 5 (D-43)**: whitespace-only under either trim is `absent`, placed after
the unsafe-class test.

**Round 6 (F2)**: moved above it. Of the 25 code points JS `.trim()` strips, three
(U+2028, U+2029, U+FEFF) are also `UNSAFE_DISPLAY_CHAR_RANGES` members, so they
never reached the new arm and were DENIED — while `main` and round 3 read all
three as absent.

**Why the move is safe, stated because the ordering was chosen deliberately in
round 4**: the unsafe test comes first so a value is never canonicalised onto a
neighbouring claim. A value that is entirely JS-trim whitespace normalises to the
EMPTY string, so it has no neighbour to land on; every value with a
non-whitespace character still meets the unsafe test first. The reject-don't-strip
policy is unchanged.

**Third round in a row for this table** (r4 T2, r5 F4, r6 F2), and the last one
fixed as an instance: the classification is now enumerated from
`String.prototype.trim` and `UNSAFE_DISPLAY_CHAR_RANGES` directly. See the review
log for that guard's three red-proofs.

## D-52 — `unmapped`'s reason set and bucket table live in one shared module

**Before**: `bucketOf` and the bucket names were private to
`scripts/tenant-domain.ts`, and the selected reasons were spelled inline in each
of the two UNION arms.

**Implemented**: `scripts/lib/tenant-domain-buckets.ts` (pure, so it is unit
testable without importing the CLI — the same reason `tenant-domain-flags.ts`
exists), holding `UNMAPPED_BUCKET`, `bucketOf`, `UNMAPPED_SELECTED_REASONS`,
`REFUSAL_BUCKET` and `RESOLVED_ELSEWHERE_BUCKET`. The reason set is bound as a
query parameter rather than spelled twice.

**Why**: round-4 F3 was a reason missing from an inline predicate, and round 6
found that round 5's red-proof of that fix covered only one of the two copies —
precisely because there were two. One source removes the possibility rather than
testing for it. `REFUSAL_BUCKET`'s `satisfies Record<ClaimRefusalKind, …>` is what
makes a new refusal arm state which population it joins before it compiles, and
`RESOLVED_ELSEWHERE_BUCKET` names the one reported population that is not a
refusal (rows 7/9b) instead of leaving it as whatever the else-branch returns.

## D-53 — SEC-R6-2: no expression index, and the reviewer's mechanism was wrong

The security expert reported `findFoldedExternalIdOwner` as an unindexed
sequential scan. **Measured against the dev database, it is not:**

```
Limit -> Sort (Sort Key: created_at, id)
          -> Index Scan using tenants_external_id_key
               Index Cond: (external_id IS NOT NULL)
               Filter: lower(btrim(external_id)) = $1
               Rows Removed by Filter: 2
Execution Time: 0.104 ms
```

**Accepted as a residual rather than fixed.** The scan is bounded by the non-null
`external_id` population — 2 of 269 here, and by construction only tenants
provisioned before the registry existed — it is reached only after both lookups
have missed, and SC10 removes the column in release 2. An expression index
(`ON tenants (lower(btrim(external_id) COLLATE "C")) WHERE external_id IS NOT NULL`)
would be a migration, an RLS/grants delta and a new object with a measured benefit
of a fraction of a millisecond. Recorded with the measurement rather than with the
reviewer's stated mechanism, per the rule that an accepted residual must name the
real one.
