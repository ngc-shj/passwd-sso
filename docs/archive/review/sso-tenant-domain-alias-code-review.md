# Code Review: sso-tenant-domain-alias
Date: 2026-07-29
Review round: 3 (rounds 1-3 recorded below)

## Changes from Previous Round

Initial code review. Phase 2 Step 2-5 had already run a focused R1-R50 (+RS/RT)
self-check — functionality and testing returned clean, security returned two
Majors which were fixed before this round. Round 1 is therefore incremental
verification on that baseline.

Ollama seed generation timed out on the ~7,800-line diff, so all three experts
performed full-diff review (skill Step 3-3 branch (a)). The general pre-screen
(`pre-review.sh code`) returned "No issues found" and was explicitly **not**
treated as evidence of safety.

## Verdict

**No-Go.** 1 Critical, 12 Major, 15 Minor.

The Critical is a reproduced CI failure. Two Majors converged across experts.
The dominant theme is that **`null` from `findOrCreateTenantForClaim` became an
overloaded signal in Phase 2** — it now means three different things to three
different callers, and the weakest reading is an allow.

## Perspective convergence

Per the convergence rule, these carry a severity floor at the highest single
assessment.

| # | Finding | Func | Sec | Test | Merged |
|---|---|---|---|---|---|
| M1 | `createUser` reads a revoked-claim `null` as "no claim" → bootstrap tenant + **OWNER** | F1 Major | F1 Major | — | **Major** |
| M2 | `add` after `remove` overwrites `createdBy`, destroying the timeline SC8's deferral rests on | F7 Minor | F7 Minor | — | **Minor** |

## Critical findings

### CR1 (Testing F1) — two new tests fail in CI, and C8's unkeyed branch is never exercised there

`.github/workflows/ci.yml:259` sets `AUTH_SECRET` at **job level** for `app-ci`.
`src/lib/audit/auth-failure.test.ts:183` and `:208` both assume it is absent.
Reproduced by the orchestrator:

```
npx vitest run src/lib/audit/auth-failure.test.ts                        → 11 passed
AUTH_SECRET="ci-secret-value-that-is-at-least-32-chars" npx vitest run … →  9 passed, 2 FAILED
  :202 expected '9025992cf0140c7e' to be null
  :218 expected "vi.fn()" to be called 1 times, but got 0 times
```

The consequence beyond the red is worse than the red: in CI the environment
silently takes the HKDF branch, so **C8's entire no-key-material path —
`identifierHash: null`, `identifierHashScope: "unkeyed"`, warn-once, i.e. all of
I10 — is never executed**.

Phase 2 could not have caught this locally: the divergence is CI supplying a
variable the local environment does not, the inverse of the usual direction.

**Same class, two more members** (no CI impact today, but the guard was actively
removed during Phase 2's `vi.stubEnv` conversion — both now depend on ambient
absence rather than asserting it):
`src/app/api/mobile/.well-known/apple-app-site-association/route.test.ts:7-10`,
`src/lib/tenant/tenant-claim.test.ts:5-8`.

## Major findings

### M1 (Func F1 + Sec F1, converged) — a revoked claim admits one sign-in, as OWNER

`src/lib/auth/session/auth-adapter.ts:174-208`. `createUser` treats `null` from
`findOrCreateTenantForClaim` as "no claim was presented":

```ts
ssoTenant = await findOrCreateTenantForClaim(pendingClaim, tx);
const tenant = ssoTenant ?? await tx.tenant.create({ … isBootstrap: true … });
role: ssoTenant ? "MEMBER" : "OWNER",
```

Phase 2 gave `null` a new, operator-reachable meaning (D2's revoked-claim
refusal). So a first-ever sign-in presenting a **deliberately revoked** claim
succeeds, creates a fresh bootstrap tenant, and makes the user its **OWNER** —
with no `tenant_claim_unmapped` row, so `tenant-domain unmapped` never shows it.
Their next sign-in then takes the row-6/9a bootstrap-migration path and absorbs
that estate into the real tenant. The revocation is not merely bypassed, it is
invisible.

On `main` this branch was effectively dead (`null` arose only from two
unreachable paths), so it is newly reachable. Security classes it as **R48**:
two adjudicators (`src/auth.ts`, `auth-adapter.ts`) decide the same predicate
with different semantics and the weaker one allows. Security also notes the
`storableClaimSchema` reject reaches the same branch, contradicting SC9's stated
outcome.

### M2 (Func F2) — the revoked-claim denial emits the reason its own diagnostic tool filters out

`src/auth.ts:119` and `:177` both hard-code `reason: "tenant_mismatch"`, while
`scripts/tenant-domain.ts:248,255` filters on `tenant_claim_unmapped`. A
revoked-claim lockout is therefore invisible to the one tool this PR ships for
it.

**The orchestrator disagrees with the reviewer's diagnosis** ("the plan is
internally inconsistent; I pick D2's side"). Re-reading the plan, it is not
inconsistent — the two statements describe **different triggers**:

- row 8b's stated trigger is the `storableClaimSchema` reject (plan:892) → `tenant_mismatch`
- D2's added trigger is the revoked row (plan:78-81) → `tenant_claim_unmapped`

The defect is that the implementation collapsed both triggers into one `null`
and gave both the same reason. **Root cause is the orchestrator's Batch C
brief**, which instructed `tenant_mismatch` for the row-9a null after reading
row 8b alone.

### M3 (Sec F2) — the backfill silently merges case/whitespace-variant tenants, placing new users of one into the other

`prisma/migrations/20260729110000_add_tenant_claims/migration.sql:46-52` and
`scripts/lib/tenant-claim-backfill.sql:26-32`. The backfill folds with
`lower(btrim(x) COLLATE "C")` and `ON CONFLICT DO NOTHING` drops the loser of a
collision. Tenants A (`external_id = "acme.com"`) and B (`"ACME.COM"`) are
**distinct today** — `findOrCreateSsoTenant` matches `externalId` exactly. After
the migration one of them (nondeterministically, by `SELECT` order) owns the
claim, and `resolveTenantByClaim` normalises before lookup, so:

- B's existing members are denied `tenant_mismatch` — a lockout, but loud;
- B's **new** members are created in **tenant A** as MEMBER — a cross-tenant
  placement that did not exist before the migration and raises no error anywhere.

The release-1 `externalId` fallback does not save B: a claim row exists (owned by
A), so the fallback is never reached. The only control is `tenant-domain
preflight`, which is advisory and out-of-band.

**This is the one cross-tenant path that does not begin with database-level
access** — it begins with pre-existing data — so it falls outside what plan-review
rounds 3 and 4 concluded.

### M4 (Sec F3) — SC7's deferral rests on a false premise, and the documented safe configuration is unreachable

`src/lib/tenant/tenant-claim.ts:6-13,65-84`. SC7 defers claim-source attestation
on the premise that the exploit needs *"a deliberate `AUTH_TENANT_CLAIM_KEYS`
configuration naming an IdP-asserted attribute"*. But four of the six **shipped
defaults** (`organization`, `org`, `company`, `company_id`) are exactly that
class, and they are tried **before** the attested `hd`. A multi-connection SAML
deployment that never sets the variable — the default — is already in the unsafe
configuration.

Worse, README's escape hatch names a state an operator cannot reach: `hd` is a
hard-coded Google-only fallback, not a member of the key list, so
`AUTH_TENANT_CLAIM_KEYS=hd` is not expressible.

### M5 (Sec F4) — no path to reassign a claim, and the CLI instructs a remediation that loops

`scripts/tenant-domain.ts:439-446` refuses a wrong-owner `add` with *"run
`remove` on the owning tenant first"*. But `remove` is a **soft delete**: it sets
`revokedAt` and leaves `tenantId` unchanged (`:599-602`), so re-running `add`
re-enters the same branch with `state = "revoked and owned by"`. The instructed
recovery is a loop; the only exit is hand-written SQL.

The wrong-owner state is reachable **without operator action**:
`findOrCreateTenantForClaim` auto-registers `createdBy: "signin"` rows, so one
sign-in with a mistyped or squatted claim binds it permanently to a junk tenant.
This falsifies SC1's anti-deferral claim that "the CLI fully restores a
locked-out tenant".

### M6-M12 (Testing F2-F8) — assertions that cannot fail for the reason they claim

- **M6 (F2, RT1)** — C1's normalisation-equivalence criterion is **absent**, and its
  substitute (`tenant-claim-registry.test.ts:128-138`) builds `new RegExp(sqlLiteral)`
  and runs it **in V8**, so it cannot detect any Postgres/JS divergence. No test
  anywhere inserts a non-ASCII claim into `tenant_claims` and asserts the CHECK
  fires. This is the exact shape the plan's own Mocking stance forbids.
- **M7 (F3, RT7)** — the advisory-lock proof calls `raceTwoClients` **once**, against
  the helper's own documented contract (*"50 iterations"*, `helpers.ts:358-362`)
  and both in-repo precedents. A single `Promise.all` on a pooled DB frequently
  serialises without contention, so the test can pass with `advisoryXactLock`
  removed — and it is C4's only real-Postgres proof of I6.
- **M8 (F4, RT7/RT8)** — the `preflight` test asserts only `ok`/`code`/`typeof
  message`. Inverting an operator, testing the folded output instead of the raw
  column (the exact D3 error), or dropping a `WHERE` clause all stay green,
  because no row that must be reported is ever seeded.
- **M9 (F5, RT7)** — the SAVEPOINT-before-create rule is asserted by
  `$executeRaw` **call count** (`tenant-management.test.ts:119`). Moving the
  SAVEPOINT after the create — the exact round-4 N6 regression — still yields
  three calls against a mock that models no session state.
- **M10 (F6)** — the new `unmapped` test seeds a `PENDING` `audit_outbox` row and
  cleans up with `deleteTestData`, inheriting the live-worker / `audit_logs`
  FK-`RESTRICT` race by construction. It is the only new test that manufactures a
  drainable row.
- **M11 (F7, RT8)** — *"makes no connection"* is in the test name and in C7's
  acceptance criterion; nothing asserts it. An implementation that built the
  client first and checked the env afterwards passes.
- **M12 (F8)** — both D1 fallback tests use `"alias.example"`, whose raw and
  normalised forms are identical, so they hold whether the implementation passes
  the raw or the normalised claim. D-3 makes the **raw** semantics load-bearing.

## Minor findings

- **Func F3** — the release-1 fallback resolves an `externalId`-only tenant but never registers its claim row, so deploy-window tenants never converge; SC10 will lock them out and nothing assigns the re-backfill. Also, the fallback is exact-match while the registry is folded, so a differently-cased spelling misses both lookups and creates a second tenant — the round-2 S1 shape.
- **Func F4** — `unmapped` uses `AUDIT_LOG_RETENTION_MIN` (the configurable **floor**) as the query window and labels the result "the retained window", excluding still-retained denials on deployments with longer retention while asserting they were checked.
- **Func F5** — `sanitizeTenantClaimValue` trims **before** stripping, so `" ​ alias.example "` retains a leading space after the strip; that value becomes `Tenant.name`/`externalId` and the fallback's exact-match key.
- **Func F6** — `scripts/init-env.ts` is in the Implementation Checklist but absent from the diff. Structurally fine (prompts derive from the sidecar), but `IOS_APP_TEAM_ID` now prompts with `example` as the default, so Enter writes `ABCDE12345` — defeating the AASA 503-when-unset signal, the exact class D-8 fixed.
- **Func F8** — `--tenant <domain>` resolves only via `tenant_claims`, so a tenant whose backfill row was skipped (i.e. precisely what `preflight` reports) cannot be named except by UUID, at incident time. Slugs fail identically.
- **Sec F5 / RS5** — `AUDIT_IDENTIFIER_PEPPER` accepts any length (`z.string().optional()`, and no guard at the derivation site) while the derived path enforces ≥32. `AUDIT_IDENTIFIER_PEPPER=x` yields a 1-byte HMAC key, contradicting the docs' claim that no hash is computed without real key material. Every other secret in `envObject` uses `hex64`.
- **Sec F6 / R1** — the new bidi/zero-width strip re-declares a class the repo already owns at `src/lib/auth/access/delegation.ts:131-133`, and **diverges**: the new one misses U+2028, U+2029, U+2060, U+180E (both miss U+00AD, U+061C). Those survive into the audit metadata and the operator terminal — the surfaces the strip exists to protect.
- **M2 (Sec F7 + Func F7, converged)** — the un-revoke nulls `revokedAt` **and** overwrites `createdBy`, so after a `remove`→`add` cycle there is no record that the claim was ever revoked, when, or who first registered it. SC8 defers application-level audit *precisely because* "the row itself carries the timeline"; the recovery command destroys it. Round-3 S3-4 reappearing on `add`.
- **Sec F8 / R2, R42** — D-18 enumerated the printable-ASCII predicate's copies as four and pinned them, but missed two: `README.md:323,328` and `README.ja.md:322,327` spell it inline under *"or, without the CLI"* — the exact hazard D-18 names, for the operator running the SQL by hand.
- **Test F9** — the two `unmapped` message assertions (`toBeTruthy()`, `toContain("1")`) barely distinguish the branches; the latter works only because `AUDIT_LOG_RETENTION_MIN` happens to be 30.
- **Test F10** — the drift guard's `.replace(/\\\\/g,"\\")` is a verified no-op and its comment describes a state that does not exist.
- **Test F11** — the `src-read-dynamic-key` fixture is not self-pinning: a declared read produces no output whether the scanner is alive or dead.
- **Test F12** — `delete process.env.X` / `if (…) process.env.X = …` in `tenant-claim-cli.integration.test.ts:436,451` escapes gate (c) only on a line-anchor technicality, while the same file's comment cites that gate as its reason for using `vi.stubEnv`.
- **Test F13** — the backfill test executes an **unscoped** global `INSERT…SELECT` over all tenants on the shared dev DB, while the same file elsewhere refuses an unscoped delete citing round-4 T35.

## Adjacent Findings

- Testing F14 [Adjacent → Functionality]: `cmdPreflight` query 3 fetches every tenant's `external_id` unbounded into memory (`scripts/tenant-domain.ts:337-342`) — fine at 264 tenants, unbounded by contract.
- Security F9 [Adjacent → Functionality]: newly declared env vars turn previously-tolerated values into hard boot failures — `COOKIE_PARTITIONED=1`/`TRUE` previously meant "off" via `=== "true"`, now fails `z.enum(["true","false"])` at import. Failing closed is right, but it is an undeclared breaking change that belongs in release notes.
- Functionality F1 [Adjacent → Security]: raised independently by Security as its own F1; merged as **M1**.

## Quality Warnings

None. All three experts cited file:line and reproduced the claims they contest;
the testing expert supplied a runnable reproduction for CR1, which the
orchestrator independently re-ran.

## Environment Verification Report

Phase 1 declared three constraints (VE1-VE3).

- **VE1** — an IdP actually emitting a changed claim: `blocked-deferred`, linked to
  the Phase 1 VE1 entry and its Anti-Deferral cost-justification. Everything below
  the `extractTenantClaimValue` seam is `verified-CI`.
- **VE2** — shared dev database: `verified-local`. Surfaced two real findings this
  round (Test F13's unscoped backfill, Test F6's outbox race).
- **VE3** — `check-env-docs` self-test via `--root`: `verified-local` (five committed
  fixtures + the one-off scratch-copy revert proof).

Additionally recorded: the local suite is **not** environment-equivalent to CI —
`app-ci` sets `AUTH_SECRET`, `SHARE_MASTER_KEY`, `AUTH_URL`, `VERIFIER_PEPPER_KEY`,
`REDIS_URL`, `DATABASE_URL` at job level, and CR1 is the first defect this
divergence has produced on this branch.

## Decisions taken by the user this round

- **M3's migration fix** — re-apply by updating the `_prisma_migrations` checksum
  only. The dev DB has zero collisions, so the old and new backfill produce
  identical data there; no destructive operation.
- **M4** — make `hd` addressable in `AUTH_TENANT_CLAIM_KEYS` and correct the
  documentation. The stricter option (narrowing `DEFAULT_TENANT_CLAIM_KEYS` to
  attested sources only) was declined as a breaking change for deployments
  relying on those keys.

## Resolution Status

Fix commit: `c360415fd`. All Critical and Major findings fixed; no deferrals.

### CR1 [Critical] Two tests fail in CI; C8's unkeyed branch never exercised there
- Action: three test files now assert their own preconditions (`vi.stubEnv(<key>, "")` in `beforeEach`) instead of inheriting ambient absence. Verified by running the changed unit-test surface under the **full `app-ci` env block**, not just `AUTH_SECRET`: 9 files / 217 tests pass. Red-proved: removing the two stubs under CI's `AUTH_SECRET` gives 4 failures.
- Modified: `src/lib/audit/auth-failure.test.ts`, `src/lib/tenant/tenant-claim.test.ts`, `src/app/api/mobile/.well-known/apple-app-site-association/route.test.ts`

### M1 [Major, converged Func+Sec] Revoked claim admits one sign-in as OWNER
- Action: `findOrCreateTenantForClaim` returns `ClaimTenantResolution` (`{kind:"tenant";id} | {kind:"claim_taken"} | {kind:"claim_invalid"}`). `createUser` branches on **whether a claim was presented**, not on whether resolution produced a tenant, and throws `TENANT_CLAIM_UNUSABLE` on either refusal — aborting the `withBypassRls` tx so no tenant, user or OWNER membership survives.
- Modified: `src/lib/tenant/tenant-management.ts`, `src/lib/auth/session/auth-adapter.ts` (+ both test files)

### M2 [Major] Revoked-claim denial emitted the reason its own diagnostic filters out
- Action: `CLAIM_REFUSAL_REASON` const-object (`satisfies`-constrained) maps `claim_taken → tenant_claim_unmapped`, `claim_invalid → tenant_mismatch` at both `src/auth.ts` refusal sites. **The reviewer's premise was corrected**: the plan is not self-contradictory — row 8b's trigger is the schema reject, D2's is the revoked row; the implementation had collapsed two triggers into one `null`. Root cause was the orchestrator's Batch C brief.
- Modified: `src/auth.ts:80-86,141-150`, `src/auth.test.ts`

### M3 [Major] Backfill merged case/whitespace-variant tenants across the tenant boundary
- Action: both copies of the backfill exclude **every** side of a collision, so release 1's exact-match `externalId` fallback keeps both tenants resolving as they do today. Verified against the live DB with seeded 2-way and 3-way collisions inside `BEGIN…ROLLBACK`; the pre-fix statement reproduced the one-winner behaviour, so the new assertion genuinely reds. Migration re-applied by the user-chosen method — checksum-only `UPDATE` (dev has zero collisions, so old and new produce identical data); `prisma migrate status` and `check-migration-drift` green afterwards.
- Modified: `prisma/migrations/20260729110000_add_tenant_claims/migration.sql`, `scripts/lib/tenant-claim-backfill.sql`, `src/__tests__/db-integration/tenant-claim.integration.test.ts`

### M4 [Major] SC7's premise false; the documented safe configuration was unreachable
- Action (user-chosen, non-breaking): `hd` is now selectable in `AUTH_TENANT_CLAIM_KEYS`, **behind a provider gate** (`account.provider === "google"`) — so a SAML profile carrying a self-asserted field literally named `hd` does not resolve. That gate is what turns "named `hd`" into "attested by Google". `DEFAULT_TENANT_CLAIM_KEYS` untouched; unset behaviour byte-identical. READMEs and the sidecar now state that leaving the variable unset selects an assertion-sourced list tried *before* `hd`.
- Modified: `src/lib/tenant/tenant-claim.ts`, `scripts/env-descriptions.ts`, `README.md`, `README.ja.md`

### M5 [Major] No claim-reassignment path; the CLI's own remediation looped
- Action: `add --from <current-owner-uuid>` moves a claim atomically. `--from` takes a bare UUID only, refuses on owner mismatch, prints both tenants with active member counts plus the absorption warning, and re-asserts the owner in the `WHERE` so a concurrent change is a refusal rather than a silent overwrite. **Revoke-first was deliberately not required**: it adds a step without adding a check (`--from` already supplies the deliberateness) and opens a window in which the claim resolves to nobody, denying *both* tenants' members — the wrong direction for a tool whose purpose is ending lockouts. The looping refusal message now names the flag.
- Modified: `scripts/tenant-domain.ts`, `src/__tests__/db-integration/tenant-claim-cli.integration.test.ts`, both READMEs

### M6-M12 [Major] Assertions that could not fail for the reason claimed
- **M6** — the missing normalisation-equivalence criterion is implemented against real Postgres: 9 adversarial values through the real `normalizeTenantClaim`, accept arm asserting byte-identical round-trip (string **and** `Buffer.equals`), reject arm asserting a real CHECK violation, with anti-vacuity counters proving both arms fire. The D3 case behaves as predicted — JS folds `İ` to `i`+U+0307, which the CHECK's ASCII clause rejects.
- **M7** — 50-iteration race per the helper's own contract. **Red-proved**: a copy of the function with `advisoryXactLock` removed fails the loop.
- **M8** — pre-flight now seeds a collision and a non-ASCII row and asserts they are reported. Red-proved four ways (predicate inverted, `btrim` dropped, `WHERE` dropped, fold-vs-raw swapped).
- **M9** — SAVEPOINT ordering asserted by SQL text **and** `invocationCallOrder` vs `tenant.create`. **Red-proved**: moving the SAVEPOINT into the catch block gives `expected 14 to be less than 13`, while the old call-count assertion stayed green under the same mutation.
- **M10** — the `unmapped` test neutralises its `PENDING` outbox row before cleanup, closing the worker window rather than narrowing it.
- **M11** — "no connection attempted" is now asserted via a spy on the client factory. Red-proved by building the client before the env check.
- **M12** — mixed-case fallback cases added to both files, pinning the **raw** claim spelling that D-3 makes load-bearing.

### Minor findings — all fixed
Func F4 (`--days` flag, honest wording), Func F5 (strip-then-trim), Func F6 (`example` dropped; verified by running `init-env.ts` in a tmpdir with Enter at every prompt — proves the mechanism, not the absence), Func F8 (slug/`external_id` fallback in `--tenant`), Sec F5 (`hex64.optional()` **and** a 32-char floor at the derivation site, since that module reads `process.env` directly), Sec F6 (one shared class in `src/lib/security/unsafe-display-chars.ts`, widened by U+2028/2029/2060/180E/00AD/061C, both call sites migrated), Sec F8 (inline predicate removed from both READMEs, which point at `preflight`), M2/F7 (`createdBy` never overwritten on un-revoke), Test F9/F10/F11/F12/F13, Test F14 (pre-flight scan bounded).

### Deferred with an owner — Func F3
The release-1 `externalId` fallback resolves a deploy-window tenant but never registers its claim row. **Not fixed in this PR, deliberately**: `resolveTenantByClaim` must stay read-only (I5), and a naive "register what the fallback resolved" write would insert the *raw* spelling and could itself collide with a backfilled row — re-creating the round-2 S1 shape the finding also names. Which spelling converges, and what happens on collision, is one design decision that belongs with SC10's fallback removal, where the ASCII narrowing takes effect anyway.
**Anti-Deferral** — Worst case: deploy-window tenants lock out when release 2 removes the fallback. Likelihood: only for tenants first seen during a migration-first roll. Cost to fix later: one re-backfill run. **Required**: SC10's release-2 work must carry an explicit item — *"re-backfill or converge deploy-window tenants before removing the fallback"* — or those tenants lock out with nothing assigned to catch them.

### Environment findings resolved this round (not code defects)
- **Integration non-determinism causally proven, not assumed**: with `passwd-sso-audit-outbox-worker-1` stopped, the full suite is 95/95 / 426 pass / exit 0; with it running, a different pre-existing outbox/retention test fails each run. Worker restarted. CI runs no such container. One member of the class (`rate-limit-fail-closed.integration.test.ts`) was observed outside this PR's files.
- **Shared dev DB restored to its pre-session state**: 76 leaked test tenants from today's runs and 353 child rows removed (catalog-driven iterative delete — 48 of 49 FKs to `tenants` are `RESTRICT`, so a hand-written order would have been fragile; a guard refused the batch if any non-test row appeared). Back to 264 tenants / 2 claim rows / 2 `external_id`. Pre-existing residue from earlier days left untouched.
- **RS4 re-verified**: the dev database contains real customer domains; a repo-wide search confirms none appear in any committed file.



---

# Round 2 — findings and resolution

Fix commit: `58af27fc9`. **6 Major, 13 Minor.** Three Majors converged across experts.

| # | Finding | Func | Sec | Test | Merged |
|---|---|---|---|---|---|
| R2-M1 | `createUser`'s refusal emits no audit event — M1's "invisible" half | F1 Major | S1 Major | N2 Major | **Major** |
| R2-M2 | M3's all-sides exclusion leaves the `UNIQUE(claim)` slot squattable by a third spelling | F2 Major | S2 Major | — | **Major** |
| R2-M3 | The recommended `AUTH_TENANT_CLAIM_KEYS=hd` makes every new SAML user an OWNER | F9 Minor | S3 Major | — | **Major** (floor) |
| R2-M4 | `unmapped` reads only `PENDING`, so terminal `FAILED` denials are invisible | F3 Major | — | — | **Major** |
| R2-M5 | The `--from` compare-and-swap has no test; the owner re-assert can be deleted green | — | — | N1 Major | **Major** |
| R2-M6 | New tests clean up only on the success path; 5 tenants leaked to the shared dev DB | — | — | N3 Major | **Major** |

Minors: reassignment attribution (S4/F6), widened strip class canonicalising into the matching key (S5), case-sensitive `hd` gate (S6), IdP-influenceable slug in `--tenant` (S7/F5), valueless `--days` (F4), `AUDIT_IDENTIFIER_PEPPER` breaking boot change (F7/A2), READMEs describing the pre-fix backfill (F8), bare role literals (F10), M10 post-assertion cleanup (N4), M6 byte-identity decoration (N5), Sec-F5 test proving the wrong thing (N6), `deleteTestData` ordering (A1).

**All Majors and Minors fixed in `58af27fc9`** — see that commit's message for the reasoning. Contract deviations introduced by the round are recorded in the deviation log.

---

# Round 3 — findings

Reviewed `58af27fc9`. **1 Critical, 6 Major, 11 Minor, 3 Adjacent.**

## CR-3 [Critical, converged Func F1 + Test T1] — the dead-letter chain broke at its last hop

`src/lib/audit/auth-failure.ts` accepted `tenantId` and used it **only** for the HMAC binding and `identifierHashScope`, then called `logAuditAsync` without it. So `resolveTenantId` fell through to a `users` lookup on `SYSTEM_ACTOR_ID` (no such row), dead-lettered, and wrote neither an `audit_logs` nor an `audit_outbox` row.

Round 2's commit claimed the opposite. **The claim was false**: the orchestrator verified the emit's *arguments* against a mocked module and never traced the hop into `logAuditAsync`. Both ends of that seam were mocked, so nothing in the repo could have caught it.

**Fixed** — `tenantId: args.tenantId ?? undefined` forwarded, plus two tests pinning the seam. Red-proved: removing the forward gives `expected undefined to be 'tenant-owner'`.

## Round-3 Majors

| # | Finding | Source | Status |
|---|---|---|---|
| R3-M1 | A malformed claim collapses into "no claim presented", turning a **deny into an allow** (R43 widening vs Round 2) | Func F3 + Sec S3-1 | **fix in flight** |
| R3-M2 | `findFoldedExternalIdOwner` uses `LIMIT 1` with no `ORDER BY` — the collision owner in the audit row is nondeterministic | Func F2 | **fix in flight** |
| R3-M3 | Both READMEs still document the `--tenant <slug>` form that was removed | Func F4 | open |
| R3-M4 | `deleteTestData`'s reorder trades an FK failure for a lock-order inversion; the observed `40P01` is that inversion | Func F5 + Test T2 | open |
| R3-M5 | `undelivered_cnt` reports normal in-flight `PROCESSING` as degraded delivery | Func F6 | open |
| R3-M6 | `claim_collision` has no real-Postgres proof; its JS↔Postgres fold pair is the round-1 M6/D3 class | Test T3 | open |
| R3-M7 | `findValuelessFlag` / `VALUE_FLAG_HINTS` are unexported and untested | Test T4 | open |
| R3-M8 | The tenant sweep misses tenants created through production code; the SAVEPOINT-retry test leaks tenants **and UNIQUE claim rows** on the red path | Test T5 | open |
| R3-M9 | The M10 anti-vacuity guard re-reads the outbox status *after* the query, introducing a new worker-race flake | Test T6 | open |

**R3-M1 is the important one.** Round 2 changed the sanitizer from strip to reject — right for the matching key — but `null` is also what the function returns for absent/non-string/empty/over-length, and both consumers read `null` as "no claim presented", which is an allow. Measured against Round 2's state, for an existing member of tenant A: `beta.example` + U+200B went from **deny `tenant_mismatch`** to **allow into A**. The precondition is only control of the asserted attribute, which every one of the six default claim keys is. This is round-1 M1's overloaded-`null` defect one layer up.

## Round-3 Minors

Sec: attacker-named `tenantId` on audit rows with no per-`(tenant,claim)` dedupe (S3-2); `toAuditProvider` resolving through the prototype chain (S3-3); `claim_invalid` still dead-lettering under a comment asserting the arm is unreachable (S3-4); `--days=30` bypassing the valueless-flag guard on a spelling technicality (S3-5); stale `unsafe-display-chars` header (S3-6).

Func: refusal sites discarding `target.tenantId` so one lockout is attributed to three tenants (F7); stale shared-class comment and an unused global regex (F8); the unreachable-arm comment (F9); Round-2 findings unrecorded (F10 — closed by this section); a fifth un-pinned copy of the fold expression (F11).

Test: PROCESSING fixture safe for an unnamed reason (T7); containment test pinning a hand-copied constant (T8); per-range not per-member table (T9); redundant block with an assertion that cannot fail (T10); `mockImplementation` inside a test body (T11); slug refusal asserted only by `ok === false` (T12).

## Adjacent

- **Test A1 → process**: six Round-2 contract changes absent from the deviation log, including one that **contradicts a written acceptance criterion** — plan lines 1033-1036 specify bidi characters *stripped*, the test now asserts `toBeNull()`. The behaviour change is right; nothing recorded that the criterion was superseded.
- **Test A2 → functionality**: the dropped-`tenantId` defect was never confined to the new call site — every `emitAuthLoginFailure` caller with a tenant but no user row dead-lettered silently.
- **Test A3 → security**: `cmdUnmapped` prints `row.claim` verbatim from `audit_logs`/`audit_outbox`, neither CHECK-constrained; pre-existing rows can still carry U+202E to the operator terminal.

## Independently re-proved this round

The testing expert re-ran every Round-2 red-proof rather than trusting the reports: N1's CAS tests genuinely reach `count === 0` (not an earlier pre-check); F-B reds both ways; the adapter runs the **real** `CLAIM_REFUSAL_REASON` / `AUDIT_PROVIDER_BY_ID` tables (dropping `"saml-jackson"` reds 4 tests). Four full integration runs, 95 files / 430 passed each, with the worker live and actively draining.

## Round-3 — Resolution Status

All 6 remaining Majors and every Minor fixed; no deferrals. CR-3, R3-M1 and
R3-M2 were reported as "fix in flight" in the section above — **that report was
wrong**: nothing had been applied. CR-3's fix *was* committed (in `58af27fc9`'s
follow-up), M1 and M2 were not, and the partial work sat in two stashes that
had been mixed together. Both were rewritten from the findings rather than
resumed.

### R3-M1 [Major, converged Func F3 + Sec S3-1] A malformed claim collapsed into "no claim", turning a deny into an allow

- **Action**: `extractTenantClaimValue` returns
  `{kind:"claim";value} | {kind:"absent"} | {kind:"malformed";display}`. **All
  five null-producing causes were re-classified individually** — the omission
  that produced the defect — and the table, with the reasoning for each, is in
  the deviation log (D-27). Summary: absent = key missing / non-string
  `undefined`/`null` / empty-or-whitespace / the `hd` provider gate; malformed =
  a present non-string value, unsafe display characters, over-length. A
  malformed read also stops the key walk, so a refusal at a higher-priority key
  cannot silently promote a lower-priority one.
- Both consumers now dispatch it: `ensureTenantMembershipForSignIn` denies with
  `tenant_mismatch` **bound to the user's tenant** (so the emit does not
  dead-letter), and the `signIn` callback's first-ever-sign-in branch denies
  *before* the claim can become a pending claim — closing the bootstrap-tenant-
  with-OWNER outcome, which was the damaging half.
- The refused value reaches the audit row as an **escaped rendering**
  (`beta.example<U+200B>`), never the raw value and never a stripped one: a
  strip would print `beta.example`, a claim that resolves, next to the word
  "refused".
- **Red-proved on throwaway copies, real source never mutated**: a copy of
  `tenant-claim.ts` with the three malformed arms returned to `ABSENT` fails 26
  of 50 boundary cases; a copy of `auth.ts` with both dispatch branches removed
  fails exactly the 3 new consumer tests and nothing else.
- Modified: `src/lib/tenant/tenant-claim.ts`, `src/auth.ts`,
  `src/lib/audit/auth-failure-mapping.ts`,
  `src/lib/security/unsafe-display-chars.ts` (+ four test files).

### R3-M2 [Major] `findFoldedExternalIdOwner`'s `LIMIT 1` had no `ORDER BY`
- Action: `ORDER BY created_at ASC, id ASC`. A collision has two sides by
  construction, and the id this query returns binds the AUTH_LOGIN_FAILURE row —
  unordered, one lockout would be filed under a different tenant on different
  runs and `unmapped`, which groups by `tenant_id`, would split it in two.
  Oldest-first because of the colliding spellings the one that existed first is
  likeliest to own the population being denied; `id` makes the order total.
  Proved against real Postgres (five consecutive calls, both sides seeded with
  explicit `created_at`, so the fixture distinguishes created_at ordering from
  id ordering), and the clause itself pinned in the unit suite.

### R3-M3 [Major] Both READMEs documented the removed `--tenant <slug>` form
- Action: both now list `uuid | claim | external_id` and state why slug is
  excluded (many-to-one derivation, pre-emptable by one squatted sign-in).
  Recorded as D-31.

### R3-M4 [Major] `deleteTestData`'s reorder traded an FK failure for a lock-order inversion
- Action: bounded 4-attempt retry on `40P01` / `40001` / `23503`, each firing
  announced on stderr. **No specific lock cycle is claimed** — it was not
  reproduced, and the last two rounds' wrong diagnoses came from asserting
  untraced mechanisms. See D-34 for the reasoning, the verification, and its
  limit: six local runs with the worker live never fired the retry, so the
  mechanism is proved directly in `helpers.test.ts` instead.

### R3-M5 [Major] `undelivered_cnt` reported normal in-flight `PROCESSING` as degraded
- Action: a PROCESSING row inside `AUDIT_OUTBOX.PROCESSING_TIMEOUT_MS` — the
  worker's own reap threshold, so the report cannot disagree with the component
  that acts on it — counts as 0. It is still *reported*: the denial happened and
  the operator needs the claim. The integration test now seeds a stale and a
  fresh PROCESSING row and asserts both halves, which is what distinguishes
  "excluded from the report" (wrong) from "reported, not degraded" (right).

### R3-M6 [Major] `claim_collision` had no real-Postgres proof
- Action: an integration test seeds two tenants whose raw `external_id`s differ
  but fold together, then drives `findOrCreateTenantForClaim` with a **third**
  spelling and asserts the refusal, the named owner, and that no tenant and no
  claim row were created. This is the JS↔Postgres fold pair (JS
  `normalizeTenantClaim` decides the lookup, `lower(btrim(x) COLLATE "C")`
  decides the match), so only a real INSERT can adjudicate it — the round-1
  M6/D3 class.

### R3-M7 [Major] `findValuelessFlag` / `VALUE_FLAG_HINTS` were unexported and untested
- Action: moved to `scripts/lib/tenant-domain-flags.ts` (no Prisma, no
  `loadEnv`) with 19 unit tests in the **unit** suite. While proving them,
  S3-5's `--days=30` bypass was closed properly: `--name=value` is now parsed,
  and **unknown flags are refused** — which closes the class (`--dayss`,
  `--Days`, a stray positional) rather than the one spelling. The rule the tests
  pin: a flag the operator wrote either takes effect or stops the command.

### R3-M8 [Major] The tenant sweep missed tenants created through production code
- Action: `ctx.trackTenant(id)` registers an id obtained from
  `findOrCreateTenantForClaim` with the same sweep, called at both such sites
  **before** the assertions that can throw; the SAVEPOINT-retry test's
  post-transaction assertions moved into a `try/finally`. Previously a red there
  leaked two tenants *and their `UNIQUE(claim)` rows*, and the claim rows then
  collided with the next run of that same test.

### R3-M9 [Major] The M10 anti-vacuity guard introduced a new worker race
- Action: the fixture is now structurally unclaimable — `nextRetryAt` an hour
  ahead, which `claimBatch`'s `next_retry_at <= now()` excludes — so the row
  stays PENDING and absent from `audit_logs` by construction. The status
  assertion remains as a fixture check but can no longer be reddened by worker
  timing. Detecting the race after the fact had turned one race (drained before
  the query) into two (drained after it, reddening a run whose query saw the
  right state).

### Minors — all fixed
- **S3-2** — accepted residual with its reasoning; per-`(tenant,claim)` dedupe
  rejected **on correctness**: `unmapped`'s `count(*)` is how an operator tells
  one confused user from a locked-out tenant (D-33).
- **S3-3** — `toAuditProvider` resolved inherited `Object.prototype` members:
  `toAuditProvider("constructor")` returned a *function* as the provider,
  because `?? "unknown"` cannot fire on a truthy value. Fixed with
  `hasOwnProperty`, and the new `auth-failure-mapping.test.ts` covers six
  inherited names plus the whole `CLAIM_REFUSAL_REASON` table.
- **S3-4 / F9** — the dead-lettering arms are now stated where they happen,
  with why nothing can be bound to them, instead of a comment claiming the arm
  is unreachable.
- **S3-5** — closed as a class, see R3-M7.
- **S3-6 / F8** — the shared-class header rewritten (both boundaries reject; the
  escape is the third policy), and the "unused" global regex now has its real
  consumer.
- **F7** — see D-33.
- **F11** — the fifth copy of the fold expression is pinned:
  `EXTERNAL_ID_FOLD_SQL` plus a drift guard that counts exact occurrences in all
  four files and separately fails any `lower(btrim(external_id))` without the
  `C` collation — the failure that is invisible on an en_US database and appears
  only on someone else's deployment. Guard sensitivity verified per file against
  in-memory mutations.
- **T7** — the PROCESSING fixture now states *why* it is race-free (claimBatch
  selects PENDING), so a later edit that switches a status cannot re-arm the
  race silently.
- **T8** — the fold containment assertion imports the shared constant instead of
  pinning the test's own hand-copied string against the source's.
- **T9** — `UNSAFE_DISPLAY_CHAR_RANGES` is now the single definition: the regex
  is built from it and the tests enumerate **all 86** members. The old table was
  21 endpoint samples under a comment claiming one case per member — narrowing
  U+202A-U+202E to U+202C-U+202E dropped two live bidi controls and stayed
  green.
- **T10** — `typeof message === "string"` (true of every message, including the
  "0 collision(s), 0 non-ASCII" output the seeded rows exist to prevent) is
  replaced by parsing the counts out of the summary line.
- **T11** — `mockEmitAuthLoginFailure`'s implementation is reset in `beforeEach`.
  `vi.clearAllMocks()` clears calls but not implementations, so a test body's
  implementation — one that writes to its own closure variable — stayed live for
  every later test in the file.
- **T12** — the slug refusal asserts the exact message, so a missing `--by`, a
  rejected `--domain` or an unset URL can no longer keep it green with the slug
  path fully restored.
- **A1** — recorded: six Round-2 contract changes are now in the deviation log
  as D-26 … D-31, including D-26's explicit supersession of the plan's
  "characters stripped" acceptance criterion.
- **A2** — re-derived rather than assumed: of the seven `emitAuthLoginFailure`
  call sites, three pass a `tenantId`, one passes a `userId` whose row exists
  (so `resolveTenantId` finds the tenant), and the remaining three are failures
  where **no** tenant is known — pre-`signIn` provider errors and the
  first-ever-sign-in refusals. No caller drops a tenant it has. No gate was
  added, because "always pass tenantId" is not true of the class.
- **A3** — see D-32.

### Verification
- `npx tsc --noEmit` exit 0; `npx next build` exit 0.
- Unit: **996 files / 13,640 passed**, 1 skipped.
- The changed unit surface re-run under the **full `app-ci` env block** (D-25):
  44 files / 530 passed.
- Integration, with the outbox worker container **live** — the configuration
  D-24 recorded as reliably red: six runs, five at **95 files / 431 passed**,
  one failure in `webhook-delivery-durable.integration.test.ts`
  (`R2c: concurrent failures increment fail_count atomically`), a file this PR
  does not touch and a member of D-24's own class. No run failed in a file this
  PR touches.

---

# Round 4 — findings and resolution

Reviewed the uncommitted round-3 fix tree. **9 Majors (after convergence) and
13 Minors — more Majors than round 3.**

Two process notes on the input. The fixes were uncommitted, so
`git diff main...HEAD` contained none of them and four new files appeared in no
git diff at all; the experts were given a concatenated working-tree diff with
those files inlined. And the Ollama seeds returned "No findings" for both
functionality and security over a 3,384-line diff — treated as no signal, which
was correct: the security expert's two Majors both came from *executing*
adversarial probes rather than reading.

**Almost every Major is against round 3's own fixes.** The R3-M1 remedy alone
produced four of them, all downstream of one decision — rendering the refused
claim into the audit row.

## Convergence

| # | Finding | Func | Sec | Test | Merged |
|---|---|---|---|---|---|
| M1 | Non-string claim classified `malformed` and denied: a lockout, and D-27's recorded cost was factually wrong | F2 Major | S6 Major | — | **Major** |
| M2 | The escape is not injective — `<` is not itself escaped | F5 Minor | S2 Minor | — | **Minor** |
| M3 | `createdBy` printed unescaped at `tenant-domain.ts:862`, contradicting D-32 | F4 Major | — | T4 (evidence) | **Major** |

## Majors

### S1 [Major, Security] The claim rendering was an audit-suppression primitive
`escapeUnsafeDisplayChars`'s `maxLength` truncated at a UTF-16 code-unit
boundary, splitting surrogate pairs. Every over-long claim went through that
path, so the input was fully attacker-chosen: a lone surrogate makes the `jsonb`
audit write fail with 22P02, and `logAuditAsync` swallows it into a dead-letter
— **an actor could delete the audit record of their own denied sign-in**, from
both `audit_logs` and `audit_outbox`, leaving `tenant-domain unmapped` blind.
Verified independently by the orchestrator: the JS side (`isWellFormed() ===
false`) and `psql` rejecting `{"claim":"a\ud83d"}::jsonb`. Same unguarded slice
found at `src/lib/audit/auth-failure.ts` (R3 propagation).
- **Fixed** by the user's chosen design: the refusal carries a printable-ASCII
  **diagnosis** (`refused: contains U+200B`) instead of a rendering, and
  `maxLength` is deleted outright — no caller needs it and the parameter WAS
  the bug. The shared audit boundary's slice is `.toWellFormed()`-guarded.
  See D-35.

### F2 + S6 [Major, converged] Non-string claim denied every sign-in in a plausible deployment
SAML attributes are multi-valued by specification and Jackson surfaces them as
JSON arrays, so `organization: ["acme"]` — a shipped default key — went from
resolving to denying. Round 3 conflated *stop the key walk* with *deny the
sign-in*; only the first followed from its stated reason. D-27's cost paragraph
was also wrong on its face (the claim-less path returns `ok: true` for existing
users; no bootstrap tenant is created).
- **Fixed**: the arm is `absent` and the walk continues. D-27 corrected in
  place, with the two lockout scenarios named.

### T2 [Major, Testing] The whitespace class was sampled at its one exceptional member
`\t \n \r \v \f` are C0 controls, so they are in the unsafe class *and* are
whitespace — and the unsafe test ran **before** the trim. `"acme.example\n"`,
the ordinary shape of a pretty-printed SAML `<AttributeValue>`, was denied. The
tests fixtured only U+0020 while their comments asserted the whole class: the
same per-sample-vs-derived defect the same commit fixed for T9.
- **Fixed**: an explicit **ASCII** trim runs first — not `.trim()`, which would
  strip U+FEFF and reintroduce the F-D canonicalisation hazard. Whitespace the
  ASCII trim leaves but `.trim()` would take is its own refusal arm. Tests
  parameterised over all six members plus CRLF. See D-37.

### F1 [Major, Functionality] `refusalTenantId` was applied at two of three refusal sites
`resolveTenantByClaim`'s `null` collapsed "revoked row owned by A" and "nobody
owns it", so rows 7/9b filed the denial under the USER's tenant while the
no-membership path filed the same lockout under the CLAIM's owner —
`unmapped` groups by `(tenant_id, claim)`, so one incident became two groups.
**Third round running to produce a finding against a nullable return here.**
- **Fixed** as a class closure, not an instance patch: `ClaimLookup`
  (`tenant | revoked | unregistered`). The compiler enumerated every consumer.
  See D-36.

### F3 [Major, Functionality] The new lockout class was invisible to the tool built for lockouts
`claim_malformed` maps to `tenant_mismatch` (correctly — nothing is
registrable), and `unmapped` filtered on `tenant_claim_unmapped` alone. An IdP
emitting a zero-width character denies **every** sign-in while `unmapped`
prints "No unmapped-claim denials".
- **Fixed**: both claim-bearing reasons are selected and printed under separate
  headings, both counts always in the summary; both READMEs' runbooks gained
  the third cause and its remedy (at the IdP, not in the CLI). See D-38.

### F4 [Major, Functionality] The escape sweep missed a site inside the command it hardened
`tenant-domain.ts:862` printed `existing.createdBy` raw, 80 lines below the
site that escapes the same field — and D-32 claimed "every CLI print site".
- **Fixed**, and covered by a test that asserts *no* printed line mentioning
  the label carries the raw character, which is what catches one missed site
  among several. D-32 corrected in place.

### T1 [Major, Testing] One of round 3's new tests could not fail
`denies a refused claim when the user has multiple active memberships` asserted
only `ok === false`; the MULTI_TENANT throw exits before the malformed dispatch
is reached, so it was a duplicate of row 3 and stayed green with both dispatch
branches deleted. Round 3's own red-proof said "exactly the 3 new consumer
tests" — there were four.
- **Fixed**: the MULTI_TENANT exit now carries the diagnosis too (F8), which
  makes the two exits distinguishable, and the test asserts the full result.

### T3 [Major, Testing] The collision fixture discriminated the ordering by coin flip
Both tenant ids come from `randomUUID()`, so `ORDER BY id ASC` passed ~50% of
runs — and R3-M2's Resolution Status claimed the fixture distinguished the two
orderings. The `id ASC` tie-break was untested entirely.
- **Fixed**: the older `created_at` is assigned to whichever id sorts *larger*,
  making `ORDER BY id ASC` deterministically red, plus a second test with two
  tenants sharing a `created_at` for the tie-break.

### T4 [Major, Testing] The `--by` guard and eight escape sites had no test on either side
- **Fixed**: deny side (bidi label refused, no row written), allow side
  (ordinary label stored), and a `console.log` spy asserting the escaped
  rendering — the test that would have caught F4.

### T5 [Major, Testing] The typed-fixture fix was applied to one of three mocks
`refusal()` was added for `mockFindOrCreateTenantForClaim`;
`mockExtractTenantClaimValue` — the mock the whole R3-M1 fix hangs on — kept
hand-written literals.
- **Fixed**: `extraction()` and `lookup()` added. This immediately earned its
  place: it turned round 4's two type changes into compile errors in the test
  file rather than runtime surprises.

## Minors — all fixed
S2/F5 (escape the introducer `<`, making the rendering injective — RS6);
S3 (D-33 named a bound that does not hold; `withCallbackRateLimit` is the real
one, and the victim-tenant admin surface is now recorded);
S4 (**fourth** site of the overloaded-signal class: an absent
`tenantClaimStorage` store dropped a valid claim into the bootstrap+OWNER path,
and the old test pinned that fall-through as intended — now denies, D-40);
S5 (duplicate flags silently last-wins on a destructive path — refused, D-39);
F6 (the "cannot disagree with the reaper" claim was overstated: the lease is
read from the CLI process's own env, so the report now prints the value it
applied);
F7 (`auth.config.ts`'s `hd` cast → type guard);
F8 (the MULTI_TENANT exit dropped the diagnosis);
T6 (`AUDIT_PROVIDER_BY_ID` exported and the positive cases derived from it; an
unfalsifiable `typeof` assertion and a derivable block removed);
T7 (an assertion that could never fail — an out-of-order range throws at
`new RegExp` during import — removed; the "matches exactly" claim narrowed);
T8 (the known-flag loop was a tautology over the tables the parser derives
acceptance from; it now reads the CLI's actual flag reads);
T9 (unscoped global `tenant.count()` on the shared dev DB scoped to the test's
own token; cleanup moved into `try/finally`);
T10 (nothing proved `deleteTestData` is *wrapped* — an R17 adoption gap — and
the SQLSTATE classifier was a substring match over `message + meta`, where
`meta` carries the query text and parameters; it now reads the code
positionally and has a false-positive test);
T11 (the `ORDER BY` source pin scoped to the function body);
T12 (a fixture carrying a literal backslash-u sequence instead of the character
it named — removed, since the extractor is mocked in that file).

## Seed dispositions
Functionality and Security: seed returned "No findings"; both experts recorded
what they did instead. Testing: two seed Minors, **both rejected with evidence**
— no fake timers exist anywhere in the file, and the `nextRetryAt` offset is an
hour against a `next_retry_at <= now()` predicate.

## Verification
- `npx tsc --noEmit` exit 0; `npx next build` exit 0.
- Unit: **997 files / 13,683 passed**, 1 skipped.
- Integration, worker container live: **95 files / 437 passed**, 1 skipped,
  4 todo — no failures this run.
