# Plan: drop `Tenant.externalId` — the claim registry is the only SSO tenant key (#744)

## Project context

- Type: web app (Next.js + Prisma/PostgreSQL) plus an operator CLI (`scripts/tenant-domain.ts`).
- Test infrastructure: unit + integration (real Postgres) + E2E + CI/CD.
- **Not in production.** Owner decision (2026-10-06): no deployment needs its
  `external_id`-only tenants carried forward; any that exist are patched by hand
  (`tenant-domain add`). This is what licenses a single-release contract instead
  of the release-2 / release-3 split `#744` describes.
- Verification environment constraints:
  - **VE1** — the deploy-window (old code live against the new schema) cannot be
    exercised; it is not needed because there is no production roll. `blocked-deferred`.
    **Anti-Deferral**: worst case is a self-hosted operator upgrading with old app
    containers running for the length of `migrate`; old code then errors on the
    missing column until it is replaced. Likelihood: believed negligible — the
    owner runs no production instance and knows of no external self-hosted one
    (pre-1.0); not measured beyond that.
    Cost-to-fix: the expand-and-contract split, which the owner declined.
  - **VE2** — integration tests need a local Postgres with the audit workers stopped
    (CLAUDE.md). `verifiable-local` / `verifiable-CI`.

## Objective

End state: an IdP claim resolves to a tenant through `tenant_claims` and nothing
else. `tenants.external_id`, every reader and writer of it, and everything that
existed only to manage the gap between it and the registry are removed.

## Requirements

- FR1 Resolution has four outcomes: active row → tenant; revoked row → refuse
  (`claim_taken`); unstorable claim → refuse (`claim_invalid`); no row → create
  tenant + claim row + `register` event in one transaction (sign-in path), or
  `unregistered` (read-only resolver).
- FR2 No code reads or writes `tenants.external_id`; the column and its unique
  index are dropped.
- FR3 Operator CLI `--tenant` accepts a UUID or a registered claim only.
- NF1 Every removal is complete: no dead arm, constant, doc row or test survives
  for a removed behaviour (CLAUDE.md "no cutting corners").
- NF1a Removal includes prose (round-2 Func F1/F2): in every file this change
  touches, and in `README.md`, `README.ja.md`, `CLAUDE.md`, `docs/operations/`,
  `docs/security/`, any comment or doc that describes the external_id fallback,
  the fold probe, `preflight`, the collision arm, or the release-1 / release-2
  (D1 / SC10) split is rewritten to the end state, not left for later. This
  includes the `resolveTenantByClaim` / `findOrCreateTenantForClaim` JSDoc and the
  whole "IdP domain changed / tenant locked out" section of both READMEs (the
  `<ref>` paragraph, the subcommand sentence, the preflight block — not only the
  cause-table rows). Acceptance: the residue sweep below, every hit read and
  either rewritten or confirmed unrelated (SCIM, CORS preflight, backup-db,
  immutable migrations, `docs/archive/`).
- NF2 Existing guards keep their strength: tenant-claim event coverage gate,
  `ClaimRefusalKind` exhaustiveness (`satisfies Record<ClaimRefusalKind, …>`).

## Technical approach

Pure deletion plus one migration. Nothing new is designed: the four outcomes in
FR1 are the arms the code already has once the external_id-derived ones are gone.

## Contracts

### C1 — Migration `<ts>_drop_tenant_external_id`

- `BEGIN; DROP INDEX IF EXISTS "tenants_external_id_key"; ALTER TABLE "tenants" DROP COLUMN "external_id"; COMMIT;`
- `prisma/schema.prisma`: remove `Tenant.externalId`.
- `scripts/checks/destructive-migration-baseline.txt`: one entry for this
  migration. Reason states the actual justification: pre-production contract
  without an expand phase, owner-approved, old code incompatible during a roll
  (VE1). The baseline header forbids entries "just to silence the gate" — this
  entry records a deliberate maintenance-path-equivalent decision, which the
  header permits when said in the reason.
- Control class: n/a (schema change). The destructive gate stays a
  `fail-closed verification gate`; this entry is its sanctioned exception path.
- Acceptance: `prisma migrate dev` applies cleanly on the dev DB;
  `check-destructive-migration.mjs` and `check-migration-transaction.mjs` pass;
  `npm run db:migrate` shows no drift.

### C2 — `src/lib/tenant/tenant-management.ts`

- `resolveTenantByClaim(tenantClaim, db?) : Promise<ClaimLookup>` with
  `ClaimLookup = tenant | revoked | unstorable | unregistered` (the `collision`
  arm is removed). Order: normalise → claim row → `storableClaimSchema` →
  `unregistered`.
- `findOrCreateTenantForClaim(tenantClaim, db) : Promise<ClaimTenantResolution>`
  with `ClaimTenantResolution = tenant | claim_taken | claim_invalid`
  (`claim_collision` removed). Order: advisory lock → claim row → schema →
  create (no `externalId` in `data`).
- `refusalFromLookup`, `claimRefusalOf`: drop the collision cases.
- Removed: `findFoldedExternalIdOwner`, both `externalId` fallbacks, the
  `externalId` field in both `tenant.create` calls.
- Invariant (unchanged, app-enforced): `resolveTenantByClaim` never writes (I5).
- Acceptance: `tsc` passes with the arms removed; unit tests for the four outcomes.

### C3 — Refusal-kind member set

`claim_collision` (and `ClaimLookup`'s bare `"collision"` discriminant) is
removed from every place that enumerates refusal kinds. Member set, derived:

```
git grep -nE 'claim_collision|kind: "collision"|"collision"' -- src scripts
```

→ `src/lib/audit/auth-failure-mapping.ts` (type + `CLAIM_REFUSAL_REASON`),
`src/lib/auth/session/auth-adapter.ts` (comments), `scripts/lib/tenant-domain-buckets.ts`
(`REFUSAL_BUCKET`), `src/lib/tenant/tenant-management.ts`, and their tests.
`ClaimRefusalKind`'s `satisfies` maps make an omission a compile error. Audit
rows persist the REASON (`tenant_claim_unmapped`), not the arm, so no stored
data references the removed kind.

### C4 — `scripts/tenant-domain.ts`

- `resolveTenantRef`: UUID → registered claim → `null`. The external_id step and
  its comment block are removed; the slug rationale (round-2 F-F) stays.
- `preflight` subcommand removed (all three of its queries are about
  `external_id`), with its usage text and dispatch entry. (`preflight` takes no
  flags; `scripts/lib/tenant-domain-flags.ts` has nothing to change.)
- Prose that describes the external_id resolution step or preflight is rewritten,
  not left for the grep to find (Sec F3): the header block, the
  `resolveTenantRef` block, and the sentinel-tenant comment in `cmdAdd`.
- `scripts/checks/worker-policy-manifest.json`: the `tenant-domain.ts` exclusion
  reason's command list drops `preflight` (Func F2).
- Acceptance: `tenant-domain preflight` is an unknown-command error.

### C5 — Removed artefacts

- `scripts/lib/tenant-claim-backfill.sql` and the drift tests that compare it
  with the (immutable) `20260729110000_add_tenant_claims` migration.
- `EXTERNAL_ID_FOLD_SQL` in `src/lib/tenant/tenant-claim-registry.ts`.
- In `src/lib/tenant/tenant-claim-registry.test.ts`'s
  `NON_PRINTABLE_ASCII_SQL_CLASS drift guard` block (Func F1 / Test F1), the
  boundary is per assertion, not per file:
  - **delete**: the `FOLD_COPIES`-driven cases ("spells the fold exactly…",
    "no copy folds external_id without the C collation") and "is the predicate
    the backfill filters the raw external_id on"; the `EXTERNAL_ID_FOLD_SQL`
    import and the `BACKFILL` / `FOLD_COPIES` constants;
  - **keep unchanged**: "is the predicate the CHECK constraint enforces" and
    "agrees with the JS predicate storableClaimSchema applies" — they pin
    `NON_PRINTABLE_ASCII_SQL_CLASS` to the `tenant_claims` CHECK (SC9), which
    this plan keeps.
  - Acceptance: both kept cases still exist by name after the change.
- Comments that describe external_id behaviour in `src/lib/tenant/tenant-claim.ts`,
  `src/lib/tenant/tenant-claim-registry.ts`, `scripts/checks/worker-policy-manifest.json`.

### C6 — Documentation

`README.md`, `README.ja.md` ("IdP domain changed / tenant locked out": preflight
and collision rows), `CLAUDE.md` (tenant-domain command list),
`docs/operations/sentinel-tenant-membership.md` (external_id resolution step),
`docs/security/security-review.md` §7 item 4 — rewritten, not deleted, to the
control that replaced it: resolution only through `tenant_claims`, serialised by
`pg_advisory_xact_lock`, deduplicated by `UNIQUE(claim)` on the normalised form
(Sec F2).

### Forbidden patterns (post-change, over `src scripts prisma/schema.prisma`, excluding `prisma/migrations` and SCIM)

(A leftover `externalId` in a Prisma `tenant.*` call is not grep-able on one
line; it is a compile error once the field leaves `schema.prisma`, so `tsc` /
`next build` is its enforcement — Test F2.)

- pattern: `tenants.external_id|"tenants" .*external_id` outside migrations — reason: column is gone
- pattern: `claim_collision|"collision"` over `src/lib/tenant src/lib/audit src/lib/auth src/auth.ts src/auth.test.ts scripts/lib scripts/tenant-domain.ts scripts/__tests__/tenant-domain-buckets.test.ts` — reason: arm removed (C3); the bare form catches `case "collision":`, which `tsc` does not reject (round-2 Sec 1 / Test T2)
- pattern: `findFoldedExternalIdOwner|EXTERNAL_ID_FOLD_SQL|tenant-claim-backfill` — reason: removed (C5)
- pattern: `preflight` in `scripts/tenant-domain.ts` and `scripts/checks/worker-policy-manifest.json` — reason: subcommand removed (C4)

(`scim_external_mappings.external_id` / `ScimExternalMapping.externalId` are unrelated and stay.)

## Testing strategy

- Unit: `resolve-tenant-by-claim.test.ts`, `tenant-management.test.ts`,
  `auth.test.ts`, `auth-adapter.test.ts`, `auth-failure-mapping.test.ts`,
  `tenant-domain-buckets.test.ts`, `tenant-claim-registry.test.ts` (boundary in
  C5) — remove collision/fallback cases; every remaining outcome keeps its allow
  and deny case (already present — Test review verified RT10). Remove the mock
  surface that only the deleted arms used (`tenant.findUnique`, `$queryRaw` and
  their `beforeEach` defaults) and re-read every remaining "did not call X"
  assertion so it is not vacuously true (Test F4).
- Integration: `tenant-claim.integration.test.ts`,
  `tenant-claim-cli.integration.test.ts` — remove backfill, fold-collision,
  external_id-resolution and preflight cases. The existing
  "register (first-create, sign-in path)" case already proves tenant + claim row +
  `register` event in one transaction and keeps doing so. One new case asserts
  through `information_schema.columns` that `tenants.external_id` does not exist —
  the only claim of this change a passing sign-in does not already imply (Test F3).
- Integration, per assertion (round-2 Func F3 / Test T1):
  `tenant-claim-cli.integration.test.ts`'s "resolves a tenant by external_id, and
  refuses a slug (round-2 F-F)" — delete the external_id setup and assertions;
  keep the slug refusal as its own case, "refuses a tenant's slug as a --tenant
  ref (round-2 F-F)", on a plain `ctx.createTenant()` fixture. The shared
  "every command fails closed…" case drops `cmdPreflight()` from its array and
  keeps the rest. Acceptance: the slug-refusal case exists by name.
- RT7: each forbidden pattern grep run against the final tree returns nothing;
  each was confirmed to match the current (unfixed) tree before the change.
- Residue sweep (NF1a), manual review of every hit:
  `git grep -nE '[eE]xternal_?[iI]d|[pP]re-?flight|[cC]ollision|[rR]elease[- ]?[12]\b|SC10|\bD1\b|プリフライト|衝突|リリース ?[12]' -- src scripts README.md README.ja.md CLAUDE.md docs/operations docs/security` (`prisma/` is never in scope — SC2).
  The pattern cannot be complete over prose (round-3 Func F1), so it is a
  tripwire, not the acceptance: the "IdP domain changed / tenant locked out"
  sections of `README.md` and `README.ja.md`, and the JSDoc of every symbol C2/C5
  touch or keep in `tenant-management.ts` and `tenant-claim-registry.ts`, are
  read in full regardless of hits.
- Mandatory: `npx vitest run`, `npm run test:integration`, `npx next build`,
  `scripts/pre-pr.sh`.

## Considerations & constraints

### Scope contract

- **SC1** — `#742` (bind a claim to the asserting SSO connection) is orthogonal and
  stays open.
- **SC2** — historical `tenant_claim_events` rows and the immutable
  `20260729110000` migration (which reads `external_id` for its one-time backfill)
  are not edited; migrations are history.

### Risks

- R1 — a database with a sign-in tenant that has no claim row loses its
  mapping, and a fold-collision pair (both sides excluded from the original
  backfill) can be shadowed by a new tenant on the next sign-in (Sec F1).
  Remedy: `tenant-domain add --tenant <uuid> --domain <claim>`. Measured on the
  only existing database before `preflight` is removed (dev, 2026-10-06):
  `tenant-domain preflight` → 0 collisions, 0 non-ASCII, 0 fold mismatches;
  `select count(*) … where external_id is not null and no tenant_claims row` → 0.
  See Sec F1's Anti-Deferral entry in the review file.

## User operation scenarios

1. First sign-in for a new IdP domain → tenant + claim row + `register` event; no external_id written.
2. Second user from the same domain → resolves via the claim row.
3. Operator `remove`s the claim → next sign-in refused `claim_taken` / `tenant_claim_unmapped`.
4. Operator runs `tenant-domain add --tenant acme.com …` where `acme.com` is a registered claim → resolves; where it is only an old external_id → "tenant not found" (by design, FR3).
5. Operator runs `tenant-domain preflight` → unknown command.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | Drop column + index migration, baseline entry | locked |
| C2 | Resolver / creator without external_id | locked |
| C3 | `claim_collision` removed from the refusal member set | locked |
| C4 | CLI: ref resolution, preflight removed | locked |
| C5 | Backfill SQL, fold constant, stale comments removed | locked |
| C6 | Docs | locked |

## Implementation Checklist

Derived 2026-10-06 (Step 2-1) by mechanism, not by the plan's list:
`git grep -lnE 'tenants.*external_id|externalId: (tenantClaim|ref)|where: \{ externalId|EXTERNAL_ID_FOLD|findFoldedExternalIdOwner|external_id' -- src scripts e2e infra prisma/schema.prisma`,
`git grep -lnE 'claim_collision|"collision"' -- src scripts`,
`git grep -lnE 'cmdPreflight|preflight' -- <tenant paths>`, `git grep -lnE 'tenant-claim-backfill' -- src scripts`.

Production (C1–C5):
- [ ] `prisma/schema.prisma` — drop `Tenant.externalId`
- [ ] `prisma/migrations/<ts>_drop_tenant_external_id/migration.sql` — new
- [ ] `scripts/checks/destructive-migration-baseline.txt` — one entry
- [ ] `src/lib/tenant/tenant-management.ts` — C2 + JSDoc (NF1a)
- [ ] `src/lib/audit/auth-failure-mapping.ts` — `claim_collision` out of type + `CLAIM_REFUSAL_REASON` + comments
- [ ] `src/lib/auth/session/auth-adapter.ts` — comments
- [ ] `scripts/lib/tenant-domain-buckets.ts` — `REFUSAL_BUCKET` + comment
- [ ] `src/lib/tenant/tenant-claim-registry.ts` — `EXTERNAL_ID_FOLD_SQL` + pre-flight prose
- [ ] `src/lib/tenant/tenant-claim.ts` — external_id / preflight comment
- [ ] `scripts/tenant-domain.ts` — `resolveTenantRef`, `cmdPreflight`, usage, dispatch, prose
- [ ] `scripts/lib/tenant-claim-backfill.sql` — delete
- [ ] `scripts/checks/worker-policy-manifest.json` — drop `preflight`

Tests (R19 — all trees searched: co-located `src/**/*.test.ts`, `src/__tests__/`, `scripts/__tests__/`, `e2e/` (no hits)):
- [ ] `src/lib/tenant/tenant-management.test.ts`, `resolve-tenant-by-claim.test.ts`, `tenant-claim-registry.test.ts` (C5 boundary), `tenant-claim.test.ts`
- [ ] `src/auth.test.ts`, `src/lib/auth/session/auth-adapter.test.ts`, `src/lib/audit/auth-failure-mapping.test.ts`, `scripts/__tests__/tenant-domain-buckets.test.ts`
- [ ] `src/__tests__/db-integration/tenant-claim.integration.test.ts`, `tenant-claim-cli.integration.test.ts` (per-assertion instructions)

Docs (C6, NF1a): `README.md`, `README.ja.md`, `CLAUDE.md`, `docs/operations/sentinel-tenant-membership.md`, `docs/security/security-review.md`.

Confirmed unrelated (not touched): `scripts/rls-cross-tenant-seed.sql`, `scripts/tenant-team-phase2-validate.sql`, `directory-sync-*` (SCIM `external_id`); `scripts/checks/migration-transaction-baseline.txt` (migration directory name); `src/__tests__/db-integration/helpers.test.ts` (synthetic error-string fixture, never executed as SQL).

CI parity: 15 CI gate commands extracted; all already run through `scripts/pre-pr.sh` or the mandatory checks. No gap.
