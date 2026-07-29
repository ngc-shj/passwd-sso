# Code Review: sso-tenant-domain-alias
Date: 2026-07-29
Review round: 1

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

_(populated after fixes)_
