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

**Implemented**: a revoked row returns `null` with **no** fallback.

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
